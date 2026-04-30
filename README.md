# VEKT meet

Production-ready registration page for VEKT meet — vot pe județ pentru carmeet.

**Stack:** Cloudflare Pages (static frontend) + Cloudflare Workers (API) + Cloudflare D1 (SQLite) + Resend (email).

```
vekt-meet/
├── public/                   # Cloudflare Pages (static)
│   ├── index.html            # form + inline Romania SVG (42 counties)
│   ├── style.css             # VEKT brand: industrial, minimal, copper accent
│   └── script.js             # vanilla JS: validation, map, AJAX, leaderboard
├── tools/
│   └── fetch-romania-svg.mjs # GeoJSON -> production SVG paths
├── worker.js                 # Cloudflare Worker API
├── schema.sql                # D1 schema + 42-county seed
├── wrangler.toml             # Cloudflare config
└── README.md
```

---

## 1. Prerequisites

- Cloudflare account with Workers + Pages + D1 enabled
- `wrangler` CLI ≥ 3.x: `npm i -g wrangler` then `wrangler login`
- Resend account + verified sending domain (e.g. `meet.vekt.ro`) → API key
- Domain `meet.vekt.ro` pointing to Cloudflare (DNS proxied)

---

## 2. Create the D1 database

```bash
wrangler d1 create vekt-meet-db
```

Copy the returned `database_id` and paste into `wrangler.toml`:

```toml
[[d1_databases]]
binding = "DB"
database_name = "vekt-meet-db"
database_id = "PASTE_HERE"
```

Apply schema (creates tables, indexes, seeds all 42 counties):

```bash
wrangler d1 execute vekt-meet-db --file=./schema.sql                # remote
wrangler d1 execute vekt-meet-db --local --file=./schema.sql        # local dev
```

Verify:

```bash
wrangler d1 execute vekt-meet-db --command="SELECT county_id, county_name FROM county_totals ORDER BY county_id;"
```

You should see 42 rows.

---

## 3. Configure secrets

```bash
# 32+ byte hex string. Generate with: openssl rand -hex 32
wrangler secret put CSRF_SECRET

# Resend API key (starts with re_)
wrangler secret put RESEND_API_KEY
```

Public (non-secret) vars are already in `wrangler.toml`. Edit to match your domain:

```toml
[vars]
RESEND_FROM        = "VEKT meet <noreply@meet.vekt.ro>"
RESEND_REPLY_TO    = "contact@vekt.ro"
PUBLIC_SITE_URL    = "https://meet.vekt.ro"
UNSUBSCRIBE_URL    = "https://meet.vekt.ro/unsubscribe"
ALLOWED_ORIGIN     = "https://meet.vekt.ro"
RATE_LIMIT_PER_HR  = "5"
```

Resend setup: in Resend dashboard, add `meet.vekt.ro` as a domain, add the SPF/DKIM/DMARC DNS records to Cloudflare DNS, wait for verification, then create an API key scoped to **Send only**.

---

## 4. Deploy the Worker (API)

```bash
wrangler deploy
```

This deploys `worker.js`. Hourly cron (`triggers.crons` in `wrangler.toml`) prunes the rate-limit table.

Add a route so `/api/*` on `meet.vekt.ro` goes to the Worker. Either:

- Uncomment the `routes` block in `wrangler.toml` and `wrangler deploy` again, or
- Cloudflare dashboard → Workers Routes → add `meet.vekt.ro/api/*` → `vekt-meet-api`.

Test the API:

```bash
curl https://meet.vekt.ro/api/counties
curl https://meet.vekt.ro/api/csrf
```

---

## 5. Deploy the static site (Pages)

Two options:

### A. Direct upload

```bash
wrangler pages deploy public --project-name=vekt-meet
```

### B. Connect GitHub (auto-deploy on push)

1. Cloudflare dashboard → Pages → Create project → Connect to Git
2. Repository: `AlexMNV16/vekt-meet`
3. Build command: *(empty — static)*
4. Build output directory: `public`
5. Environment variables: none required for the frontend
6. Custom domain: `meet.vekt.ro`

Both routing and Pages live on the same hostname:
- `meet.vekt.ro/*` → Pages (static)
- `meet.vekt.ro/api/*` → Worker (API)

---

## 6. (Optional) Replace the schematic SVG with cartographic paths

The repo ships with a **schematic** placeholder SVG (42 geographically-arranged blocks). Functional and on-brand, but not topologically accurate. To swap in real polygon paths:

1. Download Romania judete GeoJSON. Recommended sources:
   - https://github.com/codeforromania/judete-romania
   - https://github.com/octav/romania-geojson
   - https://gadm.org/ (level 1 — judete)

2. Run the converter:

   ```bash
   # Generate SVG block to public/romania-counties.svg.html (preview)
   node tools/fetch-romania-svg.mjs ./judete.geojson

   # Or patch index.html in-place
   node tools/fetch-romania-svg.mjs ./judete.geojson --patch
   ```

The script:
- Resolves county IDs from common GeoJSON property names (`mnemonic`, `name`, `NAME_1`, etc.)
- Equirectangular projection with cosine-latitude correction
- 760×600 viewBox to match existing CSS
- Generates `<g class="county" data-id="XX" data-name="…"><path class="hit" d="…"/><text>…</text></g>` blocks — same structure as the placeholder, no JS/CSS changes needed.

---

## 7. Local development

```bash
# 1. Local D1
wrangler d1 execute vekt-meet-db --local --file=./schema.sql

# 2. Run Worker + Pages together
wrangler pages dev public --d1=DB=vekt-meet-db --compatibility-flag=nodejs_compat

# Or just the Worker:
wrangler dev
```

For local dev the frontend will hit `/api/*` on the same origin (`localhost:8788` for `pages dev`). Set `CSRF_SECRET` and `RESEND_API_KEY` via:

```bash
echo 'CSRF_SECRET="local_dev_secret_change_me_xxxxxxxxxxxxxxxxxxxx"' >> .dev.vars
echo 'RESEND_API_KEY="re_xxx"' >> .dev.vars
```

(`.dev.vars` is gitignored.)

---

## 8. API contract

### `GET /api/csrf`

Issues an HMAC-signed CSRF token (valid 1 hour).

```json
{ "token": "eyJ...x.yYY...", "ttl": 3600 }
```

### `GET /api/counties`

Live leaderboard.

```json
{
  "counties": [
    { "county_id": "CJ", "county_name": "Cluj", "total_votes": 12, "total_points": 28 },
    ...
  ]
}
```

### `POST /api/register`

Headers: `Content-Type: application/json`, `X-CSRF-Token: <token>`

Body:

```json
{
  "prenume": "Alex",
  "nume": "Minov",
  "email": "alex@example.com",
  "telefon": "0712345678",          // optional, RO format
  "marca_masina": "Alfa Romeo",
  "model_masina": "166",
  "an_fabricatie": 2001,
  "marketing_consent": true,        // GDPR: not pre-checked
  "privacy_consent": true,          // required
  "votes": [
    { "id": "CJ", "rank": 1 },
    { "id": "CT", "rank": 2 },
    { "id": "TM", "rank": 3 }
  ]
}
```

Responses:

- `200 { ok: true, message: "..." }` — registered + email queued
- `400 { error: "invalid_input", fields: { email: "invalid_email", ... } }`
- `400 { error: "email_exists" }` — duplicate email
- `403 { error: "invalid_csrf" }` — missing/expired/forged token
- `429 { error: "rate_limited", retry_after: 3600 }` — 5+ submissions/IP/hour
- `500 { error: "server_error" }`

---

## 9. Database schema

```
users             1 ─────┐
                          ├──< county_votes  (3 rows / user, ranked 1/2/3)
                          │
                          └─→ updates → county_totals  (denormalised counters, 1/county)

rate_limits       (sliding window, IP + timestamp; pruned hourly by cron)
```

All inserts and counter updates run inside `db.batch([...])` so vote insertion + total update are atomic. If the batch fails, the user row is rolled back manually.

---

## 10. Security & GDPR checklist

| Item | Status |
|---|---|
| HTTPS only | ✅ Cloudflare auto |
| CSRF: HMAC-signed token, double-submit via header | ✅ `worker.js` |
| Rate limit: 5/IP/hour (D1-backed sliding window) | ✅ `worker.js` |
| Server-side input validation (all fields) | ✅ `validate()` |
| SQL injection: parameterised queries everywhere | ✅ `prepare().bind()` |
| XSS: `escapeHtml()` for email rendering, no `innerHTML` of user data on page | ✅ |
| Marketing checkbox NOT pre-checked | ✅ `index.html` |
| Privacy checkbox required, links to `/privacy` | ✅ `index.html` |
| Consent timestamps stored (`marketing_consent_at`, `privacy_consent_at`) | ✅ `users` table |
| Unsubscribe link in every email + `List-Unsubscribe` header | ✅ Resend payload |
| IP + UA stored for fraud audit; not exposed | ✅ `users` table |
| Touch targets ≥ 44×44px | ✅ CSS `min-height: 44px / 48px / 60px` |
| Mobile responsive 375–1920px | ✅ media queries |

You'll also need pages at `/privacy`, `/terms`, and `/unsubscribe` (out of scope for this build — placeholder paths are linked).

---

## 11. Operations

**View recent registrations:**

```bash
wrangler d1 execute vekt-meet-db --command="SELECT id, prenume, nume, email, marca_masina, model_masina, created_at FROM users ORDER BY id DESC LIMIT 20;"
```

**Current leaderboard:**

```bash
wrangler d1 execute vekt-meet-db --command="SELECT county_name, total_votes, total_points FROM county_totals WHERE total_votes > 0 ORDER BY total_points DESC, total_votes DESC LIMIT 10;"
```

**Export users (CSV via D1):**

```bash
wrangler d1 export vekt-meet-db --output=backup.sql
```

**Delete a user (GDPR right-to-erasure):**

```bash
wrangler d1 execute vekt-meet-db --command="DELETE FROM users WHERE email='someone@example.com';"
# CASCADE removes their county_votes; county_totals are NOT auto-decremented.
# To re-sync totals after deletions, run:
wrangler d1 execute vekt-meet-db --command="UPDATE county_totals SET total_votes = (SELECT COUNT(*) FROM county_votes WHERE county_id = county_totals.county_id), total_points = COALESCE((SELECT SUM(points) FROM county_votes WHERE county_id = county_totals.county_id), 0), last_updated = datetime('now');"
```

---

## 12. What's intentionally NOT included

- `/privacy`, `/terms`, `/unsubscribe` pages — link in place, content is your legal team's call
- A11y audit beyond the basics (skip link, ARIA on map, focus styles, reduced-motion) — recommend Axe pass before launch
- Captcha — Cloudflare Turnstile is a 5-minute add if abuse becomes an issue (`<div class="cf-turnstile">` + server verify)
- Analytics — drop in Plausible / Cloudflare Web Analytics via a single script tag
- The cartographically-accurate SVG — see section 6 above

---

## License

Internal — Pharaoh Media S.R.L. / VEKT.
