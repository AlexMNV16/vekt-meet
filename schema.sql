-- =============================================================
-- VEKT meet - D1 schema
-- Apply with:  wrangler d1 execute vekt-meet-db --file=./schema.sql
-- =============================================================

PRAGMA foreign_keys = ON;

-- -------------------------------------------------------------
-- users
-- -------------------------------------------------------------
CREATE TABLE IF NOT EXISTS users (
  id                    INTEGER PRIMARY KEY AUTOINCREMENT,
  prenume               TEXT    NOT NULL,
  nume                  TEXT    NOT NULL,
  email                 TEXT    NOT NULL UNIQUE,
  telefon               TEXT,
  marca_masina          TEXT    NOT NULL,
  model_masina          TEXT    NOT NULL,
  an_fabricatie         INTEGER NOT NULL,
  marketing_consent     INTEGER NOT NULL DEFAULT 0 CHECK (marketing_consent IN (0,1)),
  marketing_consent_at  TEXT,
  privacy_consent_at    TEXT    NOT NULL,
  ip_address            TEXT,
  user_agent            TEXT,
  created_at            TEXT    NOT NULL DEFAULT (datetime('now'))
);

CREATE INDEX IF NOT EXISTS idx_users_email   ON users(email);
CREATE INDEX IF NOT EXISTS idx_users_created ON users(created_at);

-- -------------------------------------------------------------
-- county_votes (3 rows per user, ranked 1/2/3)
-- -------------------------------------------------------------
CREATE TABLE IF NOT EXISTS county_votes (
  id           INTEGER PRIMARY KEY AUTOINCREMENT,
  user_id      INTEGER NOT NULL,
  county_id    TEXT    NOT NULL,
  county_name  TEXT    NOT NULL,
  vote_rank    INTEGER NOT NULL CHECK (vote_rank IN (1,2,3)),
  points       INTEGER NOT NULL CHECK (points IN (1,2,3)),
  created_at   TEXT    NOT NULL DEFAULT (datetime('now')),
  FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE,
  UNIQUE (user_id, vote_rank),
  UNIQUE (user_id, county_id)
);

CREATE INDEX IF NOT EXISTS idx_votes_county ON county_votes(county_id);
CREATE INDEX IF NOT EXISTS idx_votes_user   ON county_votes(user_id);

-- -------------------------------------------------------------
-- county_totals (denormalised counters; 1 row per county)
-- -------------------------------------------------------------
CREATE TABLE IF NOT EXISTS county_totals (
  county_id     TEXT    PRIMARY KEY,
  county_name   TEXT    NOT NULL,
  total_votes   INTEGER NOT NULL DEFAULT 0,
  total_points  INTEGER NOT NULL DEFAULT 0,
  last_updated  TEXT    NOT NULL DEFAULT (datetime('now'))
);

CREATE INDEX IF NOT EXISTS idx_totals_points ON county_totals(total_points DESC);

-- -------------------------------------------------------------
-- rate_limits (sliding window per IP, 1h)
-- -------------------------------------------------------------
CREATE TABLE IF NOT EXISTS rate_limits (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  ip_address  TEXT NOT NULL,
  attempt_at  TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE INDEX IF NOT EXISTS idx_rl_ip   ON rate_limits(ip_address);
CREATE INDEX IF NOT EXISTS idx_rl_time ON rate_limits(attempt_at);

-- =============================================================
-- Seed: all 42 Romanian administrative units (41 judete + B)
-- Idempotent: INSERT OR IGNORE
-- =============================================================
INSERT OR IGNORE INTO county_totals (county_id, county_name) VALUES
  ('AB', 'Alba'),
  ('AR', 'Arad'),
  ('AG', 'Argeș'),
  ('BC', 'Bacău'),
  ('BH', 'Bihor'),
  ('BN', 'Bistrița-Năsăud'),
  ('BT', 'Botoșani'),
  ('BV', 'Brașov'),
  ('BR', 'Brăila'),
  ('B',  'București'),
  ('BZ', 'Buzău'),
  ('CS', 'Caraș-Severin'),
  ('CL', 'Călărași'),
  ('CJ', 'Cluj'),
  ('CT', 'Constanța'),
  ('CV', 'Covasna'),
  ('DB', 'Dâmbovița'),
  ('DJ', 'Dolj'),
  ('GL', 'Galați'),
  ('GR', 'Giurgiu'),
  ('GJ', 'Gorj'),
  ('HR', 'Harghita'),
  ('HD', 'Hunedoara'),
  ('IL', 'Ialomița'),
  ('IS', 'Iași'),
  ('IF', 'Ilfov'),
  ('MM', 'Maramureș'),
  ('MH', 'Mehedinți'),
  ('MS', 'Mureș'),
  ('NT', 'Neamț'),
  ('OT', 'Olt'),
  ('PH', 'Prahova'),
  ('SJ', 'Sălaj'),
  ('SM', 'Satu Mare'),
  ('SB', 'Sibiu'),
  ('SV', 'Suceava'),
  ('TR', 'Teleorman'),
  ('TM', 'Timiș'),
  ('TL', 'Tulcea'),
  ('VS', 'Vaslui'),
  ('VL', 'Vâlcea'),
  ('VN', 'Vrancea');
