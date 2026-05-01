// =============================================================
// VEKT meet - Cloudflare Worker API (Supabase backend)
//
// Routes:
//   GET  /api/csrf       -> HMAC-signed CSRF token (stateless)
//   GET  /api/counties   -> live leaderboard from Supabase
//   POST /api/register   -> validate, call register_vote RPC, email
//   *    /api/*          -> 404 JSON
//
// Bindings (wrangler.toml / secrets):
//   SUPABASE_URL         var   - https://xxx.supabase.co
//   SUPABASE_SERVICE_KEY secret - service_role JWT
//   RESEND_API_KEY       secret
//   CSRF_SECRET          secret - 32+ byte hex
//   RESEND_FROM, RESEND_REPLY_TO, PUBLIC_SITE_URL,
//   UNSUBSCRIBE_URL, ALLOWED_ORIGIN, RATE_LIMIT_PER_HR
// =============================================================

const COUNTY_NAMES = {
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
    const url    = new URL(request.url);
    const method = request.method.toUpperCase();

    if (method === 'OPTIONS') return cors(new Response(null, { status: 204 }), env);

    try {
      if (url.pathname === '/api/csrf'     && method === 'GET')  return cors(await handleCsrf(env), env);
      if (url.pathname === '/api/counties' && method === 'GET')  return cors(await handleCounties(env), env);
      if (url.pathname === '/api/register' && method === 'POST') return cors(await handleRegister(request, env), env);
      if (url.pathname.startsWith('/api/')) return cors(json({ error: 'not_found' }, 404), env);
      return new Response('VEKT meet API', { status: 200 });
    } catch (err) {
      console.error('unhandled', err);
      return cors(json({ error: 'server_error' }, 500), env);
    }
  },

  async scheduled(event, env, ctx) {
    const cutoff = new Date(Date.now() - 2 * 3600 * 1000).toISOString();
    await sbFetch(env, `DELETE /rest/v1/rate_limits?attempt_at=lt.${cutoff}`, null);
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
    headers: { 'Content-Type': 'application/json' },
  });
}

// =============================================================
// Supabase REST helper
// =============================================================
async function sbFetch(env, endpoint, body) {
  const [method, path] = endpoint.split(' ');
  const url = `${env.SUPABASE_URL}${path}`;
  const opts = {
    method,
    headers: {
      'apikey':        env.SUPABASE_SERVICE_KEY,
      'Authorization': `Bearer ${env.SUPABASE_SERVICE_KEY}`,
      'Content-Type':  'application/json',
      'Prefer':        'return=representation',
    },
  };
  if (body !== null && body !== undefined) opts.body = JSON.stringify(body);
  const res = await fetch(url, opts);
  const text = await res.text();
  let data;
  try { data = JSON.parse(text); } catch { data = text; }
  return { ok: res.ok, status: res.status, data };
}

// =============================================================
// CSRF (stateless HMAC, 1h TTL)
// =============================================================
async function handleCsrf(env) {
  const token = await mintCsrf(env);
  return json({ token, ttl: 3600 });
}

async function mintCsrf(env) {
  const now    = Math.floor(Date.now() / 1000);
  const bucket = Math.floor(now / 3600);
  const key    = await importKey(env.CSRF_SECRET);
  const sig    = await sign(key, String(bucket));
  return `${bucket}.${sig}`;
}

async function verifyCsrf(token, env) {
  if (!token || typeof token !== 'string') return false;
  const [bucketStr, sig] = token.split('.');
  if (!bucketStr || !sig) return false;
  const now    = Math.floor(Date.now() / 1000);
  const bucket = parseInt(bucketStr, 10);
  if (isNaN(bucket)) return false;
  const currentBucket = Math.floor(now / 3600);
  if (Math.abs(currentBucket - bucket) > 1) return false;
  const key      = await importKey(env.CSRF_SECRET);
  const expected = await sign(key, String(bucket));
  return timingSafe(sig, expected);
}

async function importKey(secret) {
  const raw = hexToBytes(secret);
  return crypto.subtle.importKey('raw', raw, { name: 'HMAC', hash: 'SHA-256' }, false, ['sign']);
}

async function sign(key, msg) {
  const enc = new TextEncoder();
  const buf = await crypto.subtle.sign('HMAC', key, enc.encode(msg));
  return bytesToHex(new Uint8Array(buf));
}

function hexToBytes(hex) {
  const arr = new Uint8Array(hex.length / 2);
  for (let i = 0; i < hex.length; i += 2) arr[i / 2] = parseInt(hex.slice(i, i + 2), 16);
  return arr;
}

function bytesToHex(bytes) {
  return Array.from(bytes).map(b => b.toString(16).padStart(2, '0')).join('');
}

function timingSafe(a, b) {
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return diff === 0;
}

// =============================================================
// GET /api/counties -- leaderboard
// =============================================================
async function handleCounties(env) {
  const { ok, data } = await sbFetch(
    env,
    'GET /rest/v1/county_totals?order=total_points.desc&select=county_id,county_name,total_votes,total_points',
    null
  );
  if (!ok) return json({ error: 'db_error' }, 500);
  const counties = Array.isArray(data) ? data : [];
  const all = Object.entries(COUNTY_NAMES).map(([id, name]) => {
    const row = counties.find(r => r.county_id === id);
    return {
      id,
      name,
      votes:  row?.total_votes  ?? 0,
      points: row?.total_points ?? 0,
    };
  });
  all.sort((a, b) => b.points - a.points || b.votes - a.votes);
  return json({ counties: all });
}

// =============================================================
// POST /api/register
// =============================================================
async function handleRegister(request, env) {
  const csrfToken = request.headers.get('X-CSRF-Token') || '';
  if (!(await verifyCsrf(csrfToken, env))) {
    return json({ error: 'invalid_csrf' }, 403);
  }

  const ip = request.headers.get('CF-Connecting-IP') ||
             request.headers.get('X-Forwarded-For') || 'unknown';
  const limitPerHr = parseInt(env.RATE_LIMIT_PER_HR || '5', 10);
  const cutoff = new Date(Date.now() - 3600 * 1000).toISOString();

  const rlRes = await sbFetch(
    env,
    `GET /rest/v1/rate_limits?ip_address=eq.${encodeURIComponent(ip)}&attempt_at=gte.${cutoff}&select=id`,
    null
  );
  if (rlRes.ok && Array.isArray(rlRes.data) && rlRes.data.length >= limitPerHr) {
    return json({ error: 'rate_limited' }, 429);
  }

  let body;
  try { body = await request.json(); }
  catch { return json({ error: 'invalid_json' }, 400); }

  const err = validate(body);
  if (err) return json({ error: err }, 422);

  const votes = body.votes;

  const payload = {
    prenume:           body.prenume.trim(),
    nume:              body.nume.trim(),
    email:             body.email.trim().toLowerCase(),
    telefon:           body.telefon?.trim() || '',
    marca_masina:      body.marca_masina.trim(),
    model_masina:      body.model_masina.trim(),
    an_fabricatie:     Number(body.an_fabricatie),
    marketing_consent: !!body.marketing_consent,
    votes:             votes.map(v => ({
      county_id:   v.county_id,
      county_name: COUNTY_NAMES[v.county_id] || v.county_id,
      vote_rank:   v.vote_rank,
    })),
    ip_address: ip,
    user_agent: request.headers.get('User-Agent') || '',
  };

  const rpcRes = await sbFetch(env, 'POST /rest/v1/rpc/register_vote', payload);
  const result = rpcRes.data;

  if (!rpcRes.ok || result?.error) {
    const errCode = result?.error || 'db_error';
    if (errCode === 'email_exists')   return json({ error: 'email_exists' }, 409);
    if (errCode === 'duplicate_vote') return json({ error: 'duplicate_vote' }, 409);
    console.error('rpc error', result);
    return json({ error: 'db_error' }, 500);
  }

  try {
    await sendEmail(env, body.email.trim().toLowerCase(), body.prenume.trim(), votes);
  } catch (e) {
    console.error('email failed', e);
  }

  return json({ ok: true });
}

// =============================================================
// Validation
// =============================================================
function validate(body) {
  if (!body || typeof body !== 'object') return 'invalid_body';
  if (!str(body.prenume, 2, 60))       return 'invalid_prenume';
  if (!str(body.nume, 2, 60))          return 'invalid_nume';
  if (!email(body.email))              return 'invalid_email';
  if (body.telefon && !phone(body.telefon)) return 'invalid_telefon';
  if (!str(body.marca_masina, 1, 60))  return 'invalid_marca';
  if (!str(body.model_masina, 1, 60))  return 'invalid_model';
  const an = Number(body.an_fabricatie);
  if (!Number.isInteger(an) || an < 1950 || an > new Date().getFullYear() + 1) return 'invalid_an';
  if (!body.privacy_consent)           return 'privacy_required';

  const votes = body.votes;
  if (!Array.isArray(votes) || votes.length < 1 || votes.length > 3) return 'invalid_votes_count';
  const seen = new Set();
  for (const v of votes) {
    if (!COUNTY_NAMES[v.county_id]) return 'invalid_county';
    if (![1, 2, 3].includes(v.vote_rank)) return 'invalid_rank';
    if (seen.has(v.county_id)) return 'duplicate_county';
    seen.add(v.county_id);
  }
  const ranks = votes.map(v => v.vote_rank).sort((a, b) => a - b);
  for (let i = 0; i < ranks.length; i++) if (ranks[i] !== i + 1) return 'invalid_ranks';

  return null;
}

function str(v, min, max) {
  return typeof v === 'string' && v.trim().length >= min && v.trim().length <= max;
}
function email(v) {
  return typeof v === 'string' && /^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/.test(v.trim());
}
function phone(v) {
  return typeof v === 'string' && /^[\d\s+\-()]{6,20}$/.test(v.trim());
}

// =============================================================
// Confirmation email (Resend)
// =============================================================
async function sendEmail(env, toEmail, prenume, votes) {
  const rankLabel = ['Prima', 'A doua', 'A treia'];
  const voteRows = votes
    .sort((a, b) => a.vote_rank - b.vote_rank)
    .map(v => `<tr>
      <td style="padding:8px 0;color:#888;font-size:12px;text-transform:uppercase;letter-spacing:0.12em;">${rankLabel[v.vote_rank - 1]} alegere</td>
      <td style="padding:8px 0 8px 24px;color:#fff;font-size:16px;font-weight:700;">${COUNTY_NAMES[v.county_id] || v.county_id}</td>
    </tr>`)
    .join('');

  const html = `<!DOCTYPE html>
<html lang="ro">
<head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"></head>
<body style="margin:0;padding:0;background:#000;font-family:Helvetica Neue,Helvetica,Arial,sans-serif;">
<table width="100%" cellpadding="0" cellspacing="0" style="background:#000;padding:40px 0;">
  <tr><td align="center">
    <table width="600" cellpadding="0" cellspacing="0" style="max-width:600px;background:#000;border:1px solid #1a1a1a;">
      <tr><td style="padding:40px 48px 32px;border-bottom:1px solid #1a1a1a;">
        <a href="${env.PUBLIC_SITE_URL}" style="text-decoration:none;">
          <img src="${env.PUBLIC_SITE_URL}/assets/vekt-logo.png" width="80" alt="VEKT" style="display:block;">
        </a>
      </td></tr>
      <tr><td style="padding:48px 48px 0;">
        <p style="margin:0 0 8px;color:#B8860B;font-size:11px;font-weight:700;text-transform:uppercase;letter-spacing:0.2em;">VEKT MEET. EDITIA 01.</p>
        <h1 style="margin:0 0 32px;color:#fff;font-size:40px;font-weight:700;line-height:0.95;text-transform:uppercase;letter-spacing:-0.02em;">AI VOTAT.</h1>
        <p style="margin:0 0 32px;color:#888;font-size:16px;line-height:1.6;">Salut ${prenume}, votul tau a fost inregistrat. Cand VEKT meet se confirma in judetul tau, primesti email.</p>
        <table width="100%" cellpadding="0" cellspacing="0" style="border-top:1px solid #1a1a1a;margin-bottom:32px;">
          ${voteRows}
        </table>
        <p style="margin:0 0 48px;color:#555;font-size:14px;line-height:1.6;">Nu raspunde la acest email. Contact: <a href="mailto:contact@vekt.ro" style="color:#B8860B;text-decoration:none;">contact@vekt.ro</a></p>
      </td></tr>
      <tr><td style="padding:24px 48px 40px;border-top:1px solid #1a1a1a;">
        <p style="margin:0;color:#333;font-size:11px;text-transform:uppercase;letter-spacing:0.12em;">Pharaoh Media SRL &middot; CUI 45791703 &middot; Cluj-Napoca</p>
        <p style="margin:8px 0 0;color:#333;font-size:11px;"><a href="${env.UNSUBSCRIBE_URL}" style="color:#555;text-decoration:none;">Dezabonare</a> &middot; <a href="${env.PUBLIC_SITE_URL}/privacy.html" style="color:#555;text-decoration:none;">Confidentialitate</a></p>
      </td></tr>
    </table>
  </td></tr>
</table>
</body>
</html>`;

  const res = await fetch('https://api.resend.com/emails', {
    method: 'POST',
    headers: {
      'Authorization': `Bearer ${env.RESEND_API_KEY}`,
      'Content-Type':  'application/json',
    },
    body: JSON.stringify({
      from:     env.RESEND_FROM,
      reply_to: env.RESEND_REPLY_TO,
      to:       [toEmail],
      subject:  'VEKT meet - Confirmare Vot',
      html,
    }),
  });
  if (!res.ok) {
    const e = await res.text();
    throw new Error(`Resend ${res.status}: ${e}`);
  }
}
