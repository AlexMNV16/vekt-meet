// =============================================================
// VEKT meet - Cloudflare Worker API
//
// Routes:
//   GET  /api/csrf       -> issue HMAC-signed CSRF token
//   GET  /api/counties   -> live leaderboard (totals)
//   POST /api/register   -> validate, persist, email
//   *    /api/*          -> 404 JSON
//
// Bindings (wrangler.toml):
//   DB                  D1 database
//   RESEND_API_KEY      secret
//   CSRF_SECRET         secret (>= 32 bytes hex)
//   RESEND_FROM, RESEND_REPLY_TO, PUBLIC_SITE_URL,
//   UNSUBSCRIBE_URL, ALLOWED_ORIGIN, RATE_LIMIT_PER_HR
// =============================================================

const COUNTIES = {
  AB:'Alba', AR:'Arad', AG:'Argeș', BC:'Bacău', BH:'Bihor',
  BN:'Bistrița-Năsăud', BT:'Botoșani', BV:'Brașov', BR:'Brăila',
  B:'București', BZ:'Buzău', CS:'Caraș-Severin', CL:'Călărași',
  CJ:'Cluj', CT:'Constanța', CV:'Covasna', DB:'Dâmbovița',
  DJ:'Dolj', GL:'Galați', GR:'Giurgiu', GJ:'Gorj', HR:'Harghita',
  HD:'Hunedoara', IL:'Ialomița', IS:'Iași', IF:'Ilfov',
  MM:'Maramureș', MH:'Mehedinți', MS:'Mureș', NT:'Neamț',
  OT:'Olt', PH:'Prahova', SJ:'Sălaj', SM:'Satu Mare', SB:'Sibiu',
  SV:'Suceava', TR:'Teleorman', TM:'Timiș', TL:'Tulcea',
  VS:'Vaslui', VL:'Vâlcea', VN:'Vrancea',
};

// =============================================================
// Entry
// =============================================================
export default {
  async fetch(request, env, ctx) {
    const url = new URL(request.url);
    const method = request.method.toUpperCase();

    // CORS preflight
    if (method === 'OPTIONS') return cors(new Response(null, { status: 204 }), env);

    try {
      if (url.pathname === '/api/csrf'      && method === 'GET')  return cors(await handleCsrf(env), env);
      if (url.pathname === '/api/counties'  && method === 'GET')  return cors(await handleCounties(env), env);
      if (url.pathname === '/api/register'  && method === 'POST') return cors(await handleRegister(request, env), env);

      if (url.pathname.startsWith('/api/')) {
        return cors(json({ error: 'not_found' }, 404), env);
      }

      return new Response('VEKT meet API', { status: 200 });
    } catch (err) {
      console.error('unhandled', err);
      return cors(json({ error: 'server_error' }, 500), env);
    }
  },

  // Hourly cron: prune rate_limits older than 2h
  async scheduled(event, env, ctx) {
    try {
      await env.DB.prepare(
        `DELETE FROM rate_limits WHERE attempt_at < datetime('now', '-2 hours')`
      ).run();
    } catch (err) {
      console.error('cron prune failed', err);
    }
  },
};

// =============================================================
// CORS
// =============================================================
function cors(res, env) {
  const origin = env.ALLOWED_ORIGIN || '*';
  const h = new Headers(res.headers);
  h.set('Access-Control-Allow-Origin', origin);
  h.set('Vary', 'Origin');
  h.set('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
  h.set('Access-Control-Allow-Headers', 'Content-Type, X-CSRF-Token');
  h.set('Access-Control-Max-Age', '86400');
  return new Response(res.body, { status: res.status, headers: h });
}

function json(data, status = 200) {
  return new Response(JSON.stringify(data), {
    status,
    headers: { 'Content-Type': 'application/json; charset=utf-8' },
  });
}

// =============================================================
// CSRF (HMAC double-submit, stateless)
// Token = base64url(payload) + '.' + base64url(hmac)
// payload = { n: nonce, t: issuedAt, exp: expiresAt }
// =============================================================
const CSRF_TTL_SECONDS = 60 * 60; // 1h

async function hmacKey(secret) {
  const enc = new TextEncoder().encode(secret);
  return crypto.subtle.importKey(
    'raw', enc, { name: 'HMAC', hash: 'SHA-256' }, false, ['sign', 'verify']
  );
}

function b64u(bytes) {
  let s = btoa(String.fromCharCode(...new Uint8Array(bytes)));
  return s.replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}
function b64uDecode(str) {
  str = str.replace(/-/g, '+').replace(/_/g, '/');
  while (str.length % 4) str += '=';
  const bin = atob(str);
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}

async function issueCsrf(env) {
  if (!env.CSRF_SECRET) throw new Error('CSRF_SECRET not set');
  const now = Math.floor(Date.now() / 1000);
  const nonceBytes = new Uint8Array(16);
  crypto.getRandomValues(nonceBytes);
  const payload = { n: b64u(nonceBytes), t: now, exp: now + CSRF_TTL_SECONDS };
  const payloadBytes = new TextEncoder().encode(JSON.stringify(payload));
  const key = await hmacKey(env.CSRF_SECRET);
  const sig = await crypto.subtle.sign('HMAC', key, payloadBytes);
  return `${b64u(payloadBytes)}.${b64u(sig)}`;
}

async function verifyCsrf(token, env) {
  if (!token || typeof token !== 'string') return false;
  const parts = token.split('.');
  if (parts.length !== 2) return false;
  try {
    const payloadBytes = b64uDecode(parts[0]);
    const sigBytes = b64uDecode(parts[1]);
    const key = await hmacKey(env.CSRF_SECRET);
    const ok = await crypto.subtle.verify('HMAC', key, sigBytes, payloadBytes);
    if (!ok) return false;
    const payload = JSON.parse(new TextDecoder().decode(payloadBytes));
    const now = Math.floor(Date.now() / 1000);
    return typeof payload.exp === 'number' && payload.exp > now;
  } catch {
    return false;
  }
}

async function handleCsrf(env) {
  const token = await issueCsrf(env);
  return json({ token, ttl: CSRF_TTL_SECONDS });
}

// =============================================================
// Counties (live leaderboard)
// =============================================================
async function handleCounties(env) {
  const rs = await env.DB.prepare(
    `SELECT county_id, county_name, total_votes, total_points
       FROM county_totals
       ORDER BY total_points DESC, total_votes DESC, county_name ASC`
  ).all();
  return json({ counties: rs.results || [] });
}

// =============================================================
// Register
// =============================================================
async function handleRegister(request, env) {
  // Content-Type
  const ct = request.headers.get('content-type') || '';
  if (!ct.includes('application/json')) {
    return json({ error: 'invalid_content_type' }, 400);
  }

  // CSRF
  const csrf = request.headers.get('x-csrf-token');
  if (!(await verifyCsrf(csrf, env))) {
    return json({ error: 'invalid_csrf' }, 403);
  }

  // Parse
  let body;
  try { body = await request.json(); }
  catch { return json({ error: 'invalid_json' }, 400); }

  // Client IP (CF header)
  const ip = request.headers.get('cf-connecting-ip') || '0.0.0.0';
  const ua = (request.headers.get('user-agent') || '').slice(0, 512);

  // Rate limit
  const limit = parseInt(env.RATE_LIMIT_PER_HR || '5', 10);
  const rl = await env.DB.prepare(
    `SELECT COUNT(*) AS c FROM rate_limits
       WHERE ip_address = ?1 AND attempt_at > datetime('now','-1 hour')`
  ).bind(ip).first();
  if ((rl?.c ?? 0) >= limit) {
    return json({ error: 'rate_limited', retry_after: 3600 }, 429);
  }

  // Validate
  const v = validate(body);
  if (!v.ok) return json({ error: 'invalid_input', fields: v.errors }, 400);
  const data = v.data;

  // Duplicate email
  const dupe = await env.DB.prepare(`SELECT id FROM users WHERE email = ?1`).bind(data.email).first();
  if (dupe) {
    // record rate-limit hit anyway
    await env.DB.prepare(`INSERT INTO rate_limits (ip_address) VALUES (?1)`).bind(ip).run();
    return json({ error: 'email_exists' }, 400);
  }

  // Insert user (single op, get id), then batch votes + totals atomically
  const nowIso = new Date().toISOString();
  const insertUser = await env.DB.prepare(
    `INSERT INTO users
       (prenume, nume, email, telefon, marca_masina, model_masina, an_fabricatie,
        marketing_consent, marketing_consent_at, privacy_consent_at,
        ip_address, user_agent, created_at)
     VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11, ?12, ?13)`
  ).bind(
    data.prenume, data.nume, data.email, data.telefon || null,
    data.marca_masina, data.model_masina, data.an_fabricatie,
    data.marketing_consent ? 1 : 0,
    data.marketing_consent ? nowIso : null,
    nowIso,
    ip, ua, nowIso,
  ).run();

  const userId = insertUser.meta?.last_row_id;
  if (!userId) return json({ error: 'insert_failed' }, 500);

  // Build batch: 3 votes + 3 totals updates
  const ops = [];
  for (const vote of data.votes) {
    const points = vote.rank === 1 ? 3 : vote.rank === 2 ? 2 : 1;
    ops.push(
      env.DB.prepare(
        `INSERT INTO county_votes
           (user_id, county_id, county_name, vote_rank, points)
         VALUES (?1, ?2, ?3, ?4, ?5)`
      ).bind(userId, vote.id, COUNTIES[vote.id], vote.rank, points)
    );
    ops.push(
      env.DB.prepare(
        `UPDATE county_totals
            SET total_votes  = total_votes  + 1,
                total_points = total_points + ?2,
                last_updated = datetime('now')
          WHERE county_id = ?1`
      ).bind(vote.id, points)
    );
  }
  ops.push(env.DB.prepare(`INSERT INTO rate_limits (ip_address) VALUES (?1)`).bind(ip));

  try {
    await env.DB.batch(ops);
  } catch (err) {
    console.error('batch failed', err);
    // Best-effort rollback: remove user (cascade removes any inserted votes)
    await env.DB.prepare(`DELETE FROM users WHERE id = ?1`).bind(userId).run().catch(() => {});
    return json({ error: 'persist_failed' }, 500);
  }

  // Send email (non-blocking for the response if it fails)
  try {
    await sendConfirmationEmail(env, data);
  } catch (err) {
    console.error('email failed', err);
    // Do NOT fail the request - vote is recorded.
  }

  return json({ ok: true, message: 'Gata. Când VEKT meet se confirmă în județul tău, primești email.' }, 200);
}

// =============================================================
// Validation
// =============================================================
function validate(body) {
  const errors = {};
  const out = {};

  // strings
  const txt = (v, min = 1, max = 120) => {
    if (typeof v !== 'string') return null;
    const t = v.trim();
    if (t.length < min || t.length > max) return null;
    return t;
  };

  out.prenume = txt(body.prenume, 2, 60);
  if (!out.prenume) errors.prenume = 'min_2_chars';

  out.nume = txt(body.nume, 2, 60);
  if (!out.nume) errors.nume = 'min_2_chars';

  // Email
  const email = typeof body.email === 'string' ? body.email.trim().toLowerCase() : '';
  // RFC-pragmatic regex
  const emailOk = /^[a-z0-9._%+\-]+@[a-z0-9.\-]+\.[a-z]{2,}$/i.test(email) && email.length <= 254;
  if (!emailOk) errors.email = 'invalid_email';
  else out.email = email;

  // Telefon (optional, RO format if provided)
  if (body.telefon != null && body.telefon !== '') {
    const cleaned = String(body.telefon).replace(/[\s.\-()]/g, '');
    // +407XXXXXXXX  / 07XXXXXXXX  (mobile) - 10 digits after country
    const phoneOk = /^(?:\+?40|0)7\d{8}$/.test(cleaned);
    if (!phoneOk) errors.telefon = 'invalid_phone_ro';
    else out.telefon = cleaned;
  } else {
    out.telefon = null;
  }

  out.marca_masina = txt(body.marca_masina, 1, 60);
  if (!out.marca_masina) errors.marca_masina = 'required';

  out.model_masina = txt(body.model_masina, 1, 60);
  if (!out.model_masina) errors.model_masina = 'required';

  // An fabricatie
  const an = parseInt(body.an_fabricatie, 10);
  if (!Number.isInteger(an) || an < 1950 || an > 2026) errors.an_fabricatie = 'out_of_range';
  else out.an_fabricatie = an;

  // Consents
  out.marketing_consent = body.marketing_consent === true;
  if (body.privacy_consent !== true) errors.privacy_consent = 'required';

  // Votes - exactly 1..3 ranked, distinct counties, valid ids
  if (!Array.isArray(body.votes) || body.votes.length < 1 || body.votes.length > 3) {
    errors.votes = 'select_1_to_3';
  } else {
    const ranks = new Set();
    const ids = new Set();
    const norm = [];
    for (const v of body.votes) {
      if (!v || typeof v !== 'object') { errors.votes = 'invalid_vote_shape'; break; }
      if (!COUNTIES[v.id]) { errors.votes = 'invalid_county_id'; break; }
      const rank = parseInt(v.rank, 10);
      if (![1, 2, 3].includes(rank)) { errors.votes = 'invalid_rank'; break; }
      if (ranks.has(rank)) { errors.votes = 'duplicate_rank'; break; }
      if (ids.has(v.id))   { errors.votes = 'duplicate_county'; break; }
      ranks.add(rank); ids.add(v.id);
      norm.push({ id: v.id, rank });
    }
    norm.sort((a, b) => a.rank - b.rank);
    out.votes = norm;
    // ranks must start at 1 and be contiguous (1, or 1+2, or 1+2+3)
    if (!errors.votes) {
      const expected = [1, 2, 3].slice(0, norm.length);
      if (!norm.every((v, i) => v.rank === expected[i])) errors.votes = 'ranks_must_be_contiguous';
    }
  }

  return Object.keys(errors).length ? { ok: false, errors } : { ok: true, data: out };
}

// =============================================================
// Resend email
// =============================================================
async function sendConfirmationEmail(env, data) {
  if (!env.RESEND_API_KEY) throw new Error('RESEND_API_KEY not set');

  const top = data.votes.find(v => v.rank === 1);
  const topName = COUNTIES[top.id];

  const subject = `VEKT meet - Confirmare Vot ${topName}`;
  const html = renderEmailHtml(data, env);
  const text = renderEmailText(data, env);

  const res = await fetch('https://api.resend.com/emails', {
    method: 'POST',
    headers: {
      'Authorization': `Bearer ${env.RESEND_API_KEY}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({
      from: env.RESEND_FROM,
      reply_to: env.RESEND_REPLY_TO,
      to: [data.email],
      subject,
      html,
      text,
      headers: {
        'List-Unsubscribe': `<${env.UNSUBSCRIBE_URL}?email=${encodeURIComponent(data.email)}>`,
      },
    }),
  });

  if (!res.ok) {
    const body = await res.text().catch(() => '');
    throw new Error(`resend ${res.status}: ${body}`);
  }
}

function escapeHtml(s) {
  return String(s)
    .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;').replace(/'/g, '&#39;');
}

function renderEmailHtml(data, env) {
  const rows = data.votes.map(v => {
    const points = v.rank === 1 ? 3 : v.rank === 2 ? 2 : 1;
    const label = v.rank === 1 ? 'Prima alegere' : v.rank === 2 ? 'A doua alegere' : 'A treia alegere';
    return `
      <tr>
        <td style="padding:14px 18px;border-bottom:1px solid #1a1a1a;font:600 13px/1.4 Helvetica,Arial,sans-serif;color:#999;letter-spacing:0.08em;text-transform:uppercase;">${escapeHtml(label)}</td>
        <td style="padding:14px 18px;border-bottom:1px solid #1a1a1a;font:700 16px/1.4 Helvetica,Arial,sans-serif;color:#ffffff;">${escapeHtml(COUNTIES[v.id])}</td>
        <td style="padding:14px 18px;border-bottom:1px solid #1a1a1a;font:600 13px/1.4 Helvetica,Arial,sans-serif;color:#D4A574;text-align:right;">${points} pct</td>
      </tr>`;
  }).join('');

  const unsub = `${env.UNSUBSCRIBE_URL}?email=${encodeURIComponent(data.email)}`;

  return `<!doctype html>
<html lang="ro">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>VEKT meet</title>
</head>
<body style="margin:0;padding:0;background:#000000;color:#ffffff;font-family:Helvetica,Arial,sans-serif;">
  <table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="background:#000000;">
    <tr><td align="center" style="padding:40px 20px;">
      <table role="presentation" width="600" cellpadding="0" cellspacing="0" style="max-width:600px;width:100%;background:#000000;border:1px solid #1a1a1a;">

        <tr><td style="padding:32px 32px 24px 32px;border-bottom:2px solid;border-image:linear-gradient(90deg,#D4A574,#B8860B) 1;">
          <div style="font:900 11px/1 Helvetica,Arial,sans-serif;letter-spacing:0.32em;color:#D4A574;text-transform:uppercase;">VEKT meet</div>
          <div style="margin-top:14px;font:900 28px/1.1 Helvetica,Arial,sans-serif;color:#ffffff;letter-spacing:-0.01em;text-transform:uppercase;">Vot înregistrat.</div>
        </td></tr>

        <tr><td style="padding:28px 32px 8px 32px;font:400 15px/1.6 Helvetica,Arial,sans-serif;color:#cccccc;">
          Salut ${escapeHtml(data.prenume)},<br><br>
          Am primit voturile tale pentru VEKT meet. Iată ce ai trimis:
        </td></tr>

        <tr><td style="padding:8px 32px 24px 32px;">
          <table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="border-top:1px solid #1a1a1a;">
            ${rows}
          </table>
        </td></tr>

        <tr><td style="padding:8px 32px 28px 32px;font:400 14px/1.6 Helvetica,Arial,sans-serif;color:#999999;">
          Colectăm voturi. Când vedem interes suficient într-un județ, confirmăm data și locația. Primești email cu detalii.
        </td></tr>

        <tr><td style="padding:0 32px 32px 32px;">
          <a href="${escapeHtml(env.PUBLIC_SITE_URL)}" style="display:inline-block;padding:14px 28px;background:linear-gradient(135deg,#D4A574,#B8860B);color:#000000;font:900 12px/1 Helvetica,Arial,sans-serif;letter-spacing:0.16em;text-transform:uppercase;text-decoration:none;">Vezi pagina VEKT meet</a>
        </td></tr>

        <tr><td style="padding:24px 32px;border-top:1px solid #1a1a1a;font:400 11px/1.6 Helvetica,Arial,sans-serif;color:#666666;">
          Ai primit acest email pentru că te-ai înscris pe ${escapeHtml(env.PUBLIC_SITE_URL)}.<br>
          Dacă nu mai vrei să primești emailuri de la noi, <a href="${escapeHtml(unsub)}" style="color:#D4A574;text-decoration:underline;">dezabonează-te aici</a>.<br><br>
          VEKT &middot; Pharaoh Media S.R.L. &middot; Cluj-Napoca
        </td></tr>

      </table>
    </td></tr>
  </table>
</body>
</html>`;
}

function renderEmailText(data, env) {
  const lines = [];
  lines.push('VEKT meet - Vot inregistrat');
  lines.push('');
  lines.push(`Salut ${data.prenume},`);
  lines.push('');
  lines.push('Am primit voturile tale pentru VEKT meet:');
  for (const v of data.votes) {
    const pts = v.rank === 1 ? 3 : v.rank === 2 ? 2 : 1;
    lines.push(`  ${v.rank}. ${COUNTIES[v.id]} (${pts} pct)`);
  }
  lines.push('');
  lines.push('Colectam voturi. Cand vedem interes suficient intr-un judet,');
  lines.push('confirmam data si locatia. Primesti email cu detalii.');
  lines.push('');
  lines.push(env.PUBLIC_SITE_URL);
  lines.push('');
  lines.push(`Dezabonare: ${env.UNSUBSCRIBE_URL}?email=${encodeURIComponent(data.email)}`);
  return lines.join('\n');
}
