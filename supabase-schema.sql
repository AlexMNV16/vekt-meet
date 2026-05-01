-- =============================================================
-- VEKT meet - Supabase / PostgreSQL schema
-- Apply with:  psql $DATABASE_URL -f supabase-schema.sql
-- =============================================================

-- -------------------------------------------------------------
-- users
-- -------------------------------------------------------------
CREATE TABLE IF NOT EXISTS users (
  id                    BIGSERIAL PRIMARY KEY,
  prenume               TEXT        NOT NULL,
  nume                  TEXT        NOT NULL,
  email                 TEXT        NOT NULL UNIQUE,
  telefon               TEXT,
  marca_masina          TEXT        NOT NULL,
  model_masina          TEXT        NOT NULL,
  an_fabricatie         INTEGER     NOT NULL,
  marketing_consent     BOOLEAN     NOT NULL DEFAULT false,
  marketing_consent_at  TIMESTAMPTZ,
  privacy_consent_at    TIMESTAMPTZ NOT NULL,
  ip_address            TEXT,
  user_agent            TEXT,
  created_at            TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_users_email   ON users(email);
CREATE INDEX IF NOT EXISTS idx_users_created ON users(created_at);

-- -------------------------------------------------------------
-- county_votes (3 rows per user, ranked 1/2/3)
-- -------------------------------------------------------------
CREATE TABLE IF NOT EXISTS county_votes (
  id           BIGSERIAL PRIMARY KEY,
  user_id      BIGINT      NOT NULL,
  county_id    TEXT        NOT NULL,
  county_name  TEXT        NOT NULL,
  vote_rank    INTEGER     NOT NULL CHECK (vote_rank IN (1,2,3)),
  points       INTEGER     NOT NULL CHECK (points IN (1,2,3)),
  created_at   TIMESTAMPTZ NOT NULL DEFAULT now(),
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
  county_id     TEXT        PRIMARY KEY,
  county_name   TEXT        NOT NULL,
  total_votes   INTEGER     NOT NULL DEFAULT 0,
  total_points  INTEGER     NOT NULL DEFAULT 0,
  last_updated  TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_totals_points ON county_totals(total_points DESC);

-- -------------------------------------------------------------
-- rate_limits (sliding window per IP, 1h)
-- -------------------------------------------------------------
CREATE TABLE IF NOT EXISTS rate_limits (
  id          BIGSERIAL PRIMARY KEY,
  ip_address  TEXT        NOT NULL,
  attempt_at  TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_rl_ip   ON rate_limits(ip_address);
CREATE INDEX IF NOT EXISTS idx_rl_time ON rate_limits(attempt_at);

-- -------------------------------------------------------------
-- RLS: enable + service_role bypass on all tables
-- -------------------------------------------------------------
ALTER TABLE users          ENABLE ROW LEVEL SECURITY;
ALTER TABLE county_votes   ENABLE ROW LEVEL SECURITY;
ALTER TABLE county_totals  ENABLE ROW LEVEL SECURITY;
ALTER TABLE rate_limits    ENABLE ROW LEVEL SECURITY;

DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_policies WHERE policyname='service_role_all' AND tablename='users') THEN
    CREATE POLICY service_role_all ON users FOR ALL TO service_role USING (true) WITH CHECK (true);
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_policies WHERE policyname='service_role_all' AND tablename='county_votes') THEN
    CREATE POLICY service_role_all ON county_votes FOR ALL TO service_role USING (true) WITH CHECK (true);
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_policies WHERE policyname='service_role_all' AND tablename='county_totals') THEN
    CREATE POLICY service_role_all ON county_totals FOR ALL TO service_role USING (true) WITH CHECK (true);
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_policies WHERE policyname='service_role_all' AND tablename='rate_limits') THEN
    CREATE POLICY service_role_all ON rate_limits FOR ALL TO service_role USING (true) WITH CHECK (true);
  END IF;
END $$;

-- anon can read leaderboard only
DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_policies WHERE policyname='anon_read_totals' AND tablename='county_totals') THEN
    CREATE POLICY anon_read_totals ON county_totals FOR SELECT TO anon USING (true);
  END IF;
END $$;

-- =============================================================
-- Atomic register function
-- =============================================================
CREATE OR REPLACE FUNCTION register_vote(payload JSONB)
RETURNS JSONB
LANGUAGE plpgsql
SECURITY DEFINER
AS $$
DECLARE
  v_user_id    BIGINT;
  v_vote       JSONB;
  v_county_id  TEXT;
  v_rank       INTEGER;
  v_points     INTEGER;
BEGIN
  -- 1. Duplicate email check
  IF EXISTS (SELECT 1 FROM users WHERE email = payload->>'email') THEN
    RETURN jsonb_build_object('error', 'email_exists');
  END IF;

  -- 2. Insert user
  INSERT INTO users (
    prenume, nume, email, telefon,
    marca_masina, model_masina, an_fabricatie,
    marketing_consent, marketing_consent_at,
    privacy_consent_at, ip_address, user_agent
  ) VALUES (
    payload->>'prenume',
    payload->>'nume',
    payload->>'email',
    NULLIF(payload->>'telefon', ''),
    payload->>'marca_masina',
    payload->>'model_masina',
    (payload->>'an_fabricatie')::INTEGER,
    (payload->>'marketing_consent')::BOOLEAN,
    CASE WHEN (payload->>'marketing_consent')::BOOLEAN
         THEN now() ELSE NULL END,
    now(),
    payload->>'ip_address',
    payload->>'user_agent'
  )
  RETURNING id INTO v_user_id;

  -- 3. Insert votes + update totals
  FOR v_vote IN SELECT * FROM jsonb_array_elements(payload->'votes')
  LOOP
    v_county_id := v_vote->>'county_id';
    v_rank      := (v_vote->>'vote_rank')::INTEGER;
    v_points    := 4 - v_rank;  -- rank1=3pts, rank2=2pts, rank3=1pt

    INSERT INTO county_votes (user_id, county_id, county_name, vote_rank, points)
    VALUES (
      v_user_id,
      v_county_id,
      v_vote->>'county_name',
      v_rank,
      v_points
    );

    INSERT INTO county_totals (county_id, county_name, total_votes, total_points, last_updated)
    VALUES (v_county_id, v_vote->>'county_name', 1, v_points, now())
    ON CONFLICT (county_id) DO UPDATE
      SET total_votes  = county_totals.total_votes  + 1,
          total_points = county_totals.total_points + v_points,
          last_updated = now();
  END LOOP;

  -- 4. Log rate limit entry
  INSERT INTO rate_limits (ip_address) VALUES (payload->>'ip_address');

  RETURN jsonb_build_object('ok', true, 'user_id', v_user_id);

EXCEPTION
  WHEN unique_violation THEN
    RETURN jsonb_build_object('error', 'duplicate_vote');
  WHEN others THEN
    RETURN jsonb_build_object('error', SQLERRM);
END;
$$;

-- =============================================================
-- Seed: 42 judete (idempotent)
-- =============================================================
INSERT INTO county_totals (county_id, county_name) VALUES
  ('AB','Alba'), ('AR','Arad'), ('AG','Arges'), ('BC','Bacau'),
  ('BH','Bihor'), ('BN','Bistrita-Nasaud'), ('BT','Botosani'),
  ('BV','Brasov'), ('BR','Braila'), ('B','Bucuresti'),
  ('BZ','Buzau'), ('CS','Caras-Severin'), ('CL','Calarasi'),
  ('CJ','Cluj'), ('CT','Constanta'), ('CV','Covasna'),
  ('DB','Dambovita'), ('DJ','Dolj'), ('GL','Galati'),
  ('GR','Giurgiu'), ('GJ','Gorj'), ('HR','Harghita'),
  ('HD','Hunedoara'), ('IL','Ialomita'), ('IS','Iasi'),
  ('IF','Ilfov'), ('MM','Maramures'), ('MH','Mehedinti'),
  ('MS','Mures'), ('NT','Neamt'), ('OT','Olt'),
  ('PH','Prahova'), ('SJ','Salaj'), ('SM','Satu Mare'),
  ('SB','Sibiu'), ('SV','Suceava'), ('TR','Teleorman'),
  ('TM','Timis'), ('TL','Tulcea'), ('VS','Vaslui'),
  ('VL','Valcea'), ('VN','Vrancea')
ON CONFLICT (county_id) DO NOTHING;
