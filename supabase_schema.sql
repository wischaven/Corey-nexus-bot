-- ═══════════════════════════════════════════════════════════════════════════
-- NEXUS SaaS — Supabase Schema
-- Run this in: Supabase Dashboard → SQL Editor → New Query → Run
-- ═══════════════════════════════════════════════════════════════════════════

-- ─── User settings (ticker, plan, preferences) ───────────────────────────
CREATE TABLE IF NOT EXISTS user_settings (
  id          UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id     UUID REFERENCES auth.users(id) ON DELETE CASCADE NOT NULL UNIQUE,
  ticker      TEXT NOT NULL DEFAULT 'XRPUSD',
  plan        TEXT NOT NULL DEFAULT 'free',   -- free | pro | elite
  stripe_customer_id    TEXT,
  stripe_subscription_id TEXT,
  plan_expires_at       TIMESTAMPTZ,
  created_at  TIMESTAMPTZ DEFAULT NOW(),
  updated_at  TIMESTAMPTZ DEFAULT NOW()
);

-- ─── Bot state (replaces bot_state.json, one row per user) ───────────────
CREATE TABLE IF NOT EXISTS bot_state (
  id          UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id     UUID REFERENCES auth.users(id) ON DELETE CASCADE NOT NULL UNIQUE,
  ticker      TEXT NOT NULL DEFAULT 'XRPUSD',
  price       NUMERIC,
  pnl         NUMERIC DEFAULT 0,
  trades      INTEGER DEFAULT 0,
  wins        INTEGER DEFAULT 0,
  fees        NUMERIC DEFAULT 0,
  live_pos    JSONB,
  sim_pos     JSONB,
  confluence  NUMERIC,
  verdict     TEXT DEFAULT 'LOADING',
  rsi         NUMERIC,
  obi         NUMERIC,
  bot_running BOOLEAN DEFAULT FALSE,
  mode        TEXT DEFAULT 'sim',
  ai_score    INTEGER DEFAULT 50,
  trade_hist  JSONB DEFAULT '[]',
  mtf_summary TEXT DEFAULT '',
  updated_at  TIMESTAMPTZ DEFAULT NOW()
);

-- ─── Trade log (replaces trade_log.json, one row per trade) ─────────────
CREATE TABLE IF NOT EXISTS trade_log (
  id          UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id     UUID REFERENCES auth.users(id) ON DELETE CASCADE NOT NULL,
  ticker      TEXT NOT NULL,
  entry_price NUMERIC,
  exit_price  NUMERIC,
  size        NUMERIC,
  pnl_bps     NUMERIC,
  pnl_usd     NUMERIC,
  reason      TEXT,
  regime      TEXT,
  confluence  NUMERIC,
  ai_score    INTEGER,
  duration_secs INTEGER,
  traded_at   TIMESTAMPTZ DEFAULT NOW()
);

-- ─── Row Level Security ───────────────────────────────────────────────────
ALTER TABLE user_settings ENABLE ROW LEVEL SECURITY;
ALTER TABLE bot_state     ENABLE ROW LEVEL SECURITY;
ALTER TABLE trade_log     ENABLE ROW LEVEL SECURITY;

-- Users can only read/write their own rows
CREATE POLICY "user_settings_self" ON user_settings
  FOR ALL USING (auth.uid() = user_id);

CREATE POLICY "bot_state_self" ON bot_state
  FOR ALL USING (auth.uid() = user_id);

CREATE POLICY "trade_log_self" ON trade_log
  FOR ALL USING (auth.uid() = user_id);

-- ─── Auto-create user_settings row on signup ─────────────────────────────
CREATE OR REPLACE FUNCTION handle_new_user()
RETURNS TRIGGER AS $$
BEGIN
  INSERT INTO user_settings (user_id, plan)
  VALUES (NEW.id, 'free')
  ON CONFLICT (user_id) DO NOTHING;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql SECURITY DEFINER;

DROP TRIGGER IF EXISTS on_auth_user_created ON auth.users;
CREATE TRIGGER on_auth_user_created
  AFTER INSERT ON auth.users
  FOR EACH ROW EXECUTE FUNCTION handle_new_user();
