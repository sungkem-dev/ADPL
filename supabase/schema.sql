-- =============================================================================
-- AETHERGYM SUITE — SUPABASE DATABASE SCHEMA
-- =============================================================================
-- INSTRUCTIONS:
-- 1. Open your Supabase project dashboard
-- 2. Go to SQL Editor > New Query
-- 3. Paste this entire file and click "Run"
-- 4. Enable RLS on each table from the Authentication > Policies menu
--    OR via the "ALTER TABLE ... ENABLE ROW LEVEL SECURITY" statements below
-- =============================================================================


-- -----------------------------------------------------------------------------
-- EXTENSIONS
-- -----------------------------------------------------------------------------
CREATE EXTENSION IF NOT EXISTS "uuid-ossp";


-- =============================================================================
-- TABLE 1: users
-- Extends Supabase auth.users. The `id` column mirrors auth.users.id (UUID).
-- A trigger automatically inserts a row here upon new user signup.
-- =============================================================================
CREATE TABLE IF NOT EXISTS public.users (
  id              UUID PRIMARY KEY REFERENCES auth.users(id) ON DELETE CASCADE,
  email           TEXT NOT NULL UNIQUE,
  name            TEXT,
  role            TEXT NOT NULL DEFAULT 'guest' CHECK (role IN ('guest', 'member', 'admin')),
  target_calories INTEGER DEFAULT 2000,
  height          NUMERIC(5,2),
  weight          NUMERIC(5,2),
  age             INTEGER,
  gender          TEXT CHECK (gender IN ('male', 'female')),
  activity_level  TEXT CHECK (activity_level IN ('sedentary', 'light', 'moderate', 'active', 'very_active')),
  daily_calories  INTEGER,
  daily_protein   INTEGER,
  daily_carbs     INTEGER,
  daily_fat       INTEGER,
  created_at      TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at      TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- Trigger: auto-insert into public.users after Supabase auth signup
CREATE OR REPLACE FUNCTION public.handle_new_user()
RETURNS TRIGGER AS $$
BEGIN
  INSERT INTO public.users (id, email, name, role)
  VALUES (
    NEW.id,
    NEW.email,
    NEW.raw_user_meta_data->>'name',
    'guest'
  );
  RETURN NEW;
END;
$$ LANGUAGE plpgsql SECURITY DEFINER;

DROP TRIGGER IF EXISTS on_auth_user_created ON auth.users;
CREATE TRIGGER on_auth_user_created
  AFTER INSERT ON auth.users
  FOR EACH ROW EXECUTE PROCEDURE public.handle_new_user();

-- Trigger: auto-update updated_at on any row change
CREATE OR REPLACE FUNCTION public.set_updated_at()
RETURNS TRIGGER AS $$
BEGIN
  NEW.updated_at = NOW();
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER update_users_updated_at
  BEFORE UPDATE ON public.users
  FOR EACH ROW EXECUTE PROCEDURE public.set_updated_at();


-- =============================================================================
-- TABLE 2: memberships
-- Tracks a user's gym membership status & validity period.
-- =============================================================================
CREATE TABLE IF NOT EXISTS public.memberships (
  id         UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  user_id    UUID NOT NULL REFERENCES public.users(id) ON DELETE CASCADE,
  status     TEXT NOT NULL DEFAULT 'inactive' CHECK (status IN ('active', 'expired', 'inactive', 'cancelled')),
  plan_name  TEXT,                 -- e.g. 'Monthly', 'Quarterly', 'Annual'
  start_date DATE,
  end_date   DATE,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_memberships_user_id ON public.memberships(user_id);

CREATE TRIGGER update_memberships_updated_at
  BEFORE UPDATE ON public.memberships
  FOR EACH ROW EXECUTE PROCEDURE public.set_updated_at();


-- =============================================================================
-- TABLE 3: payment_receipts
-- Records each Midtrans transaction received via webhook.
-- =============================================================================
CREATE TABLE IF NOT EXISTS public.payment_receipts (
  id              UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  user_id         UUID NOT NULL REFERENCES public.users(id) ON DELETE CASCADE,
  transaction_id  TEXT NOT NULL UNIQUE,   -- Midtrans order_id
  amount          NUMERIC(12, 2) NOT NULL,
  payment_method  TEXT,                   -- e.g. 'bank_transfer', 'qris', 'gopay'
  payment_status  TEXT NOT NULL DEFAULT 'pending'
                  CHECK (payment_status IN ('pending', 'settlement', 'expire', 'cancel', 'deny')),
  raw_webhook     JSONB,                  -- full Midtrans webhook payload for audit
  paid_at         TIMESTAMPTZ,
  created_at      TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_payment_receipts_user_id ON public.payment_receipts(user_id);
CREATE INDEX IF NOT EXISTS idx_payment_receipts_transaction_id ON public.payment_receipts(transaction_id);


-- =============================================================================
-- TABLE 4: master_foods
-- Admin-curated food database. Members can browse; only admins can modify.
-- =============================================================================
CREATE TABLE IF NOT EXISTS public.master_foods (
  id           UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  name         TEXT NOT NULL,
  calories     NUMERIC(8, 2) NOT NULL DEFAULT 0,
  protein      NUMERIC(8, 2) NOT NULL DEFAULT 0,   -- grams
  carbs        NUMERIC(8, 2) NOT NULL DEFAULT 0,   -- grams
  fat          NUMERIC(8, 2) NOT NULL DEFAULT 0,   -- grams
  fiber        NUMERIC(8, 2) DEFAULT 0,            -- grams
  serving_size TEXT DEFAULT '100g',
  image_url    TEXT,
  created_at   TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at   TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_master_foods_name ON public.master_foods USING gin(to_tsvector('simple', name));

CREATE TRIGGER update_master_foods_updated_at
  BEFORE UPDATE ON public.master_foods
  FOR EACH ROW EXECUTE PROCEDURE public.set_updated_at();


-- =============================================================================
-- TABLE 5: food_logs
-- Daily nutrition log per user. Populated by AI scan or manual entry.
-- =============================================================================
CREATE TABLE IF NOT EXISTS public.food_logs (
  id          UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  user_id     UUID NOT NULL REFERENCES public.users(id) ON DELETE CASCADE,
  food_name   TEXT NOT NULL,
  calories    NUMERIC(8, 2) NOT NULL DEFAULT 0,
  protein     NUMERIC(8, 2) NOT NULL DEFAULT 0,   -- grams
  carbs       NUMERIC(8, 2) NOT NULL DEFAULT 0,   -- grams
  fat         NUMERIC(8, 2) NOT NULL DEFAULT 0,   -- grams
  fiber       NUMERIC(8, 2) DEFAULT 0,
  meal_type   TEXT DEFAULT 'snack'
              CHECK (meal_type IN ('breakfast', 'lunch', 'dinner', 'snack')),
  source      TEXT DEFAULT 'manual'
              CHECK (source IN ('manual', 'ai_scan', 'master_food')),
  consumed_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  created_at  TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_food_logs_user_id ON public.food_logs(user_id);
CREATE INDEX IF NOT EXISTS idx_food_logs_consumed_at ON public.food_logs(consumed_at);
-- Composite index for the analytics query (user + date range)
CREATE INDEX IF NOT EXISTS idx_food_logs_user_consumed
  ON public.food_logs(user_id, consumed_at DESC);


-- =============================================================================
-- TABLE 6: ai_scan_results
-- Stores the raw LogMeal API response and links it back to food_logs.
-- =============================================================================
CREATE TABLE IF NOT EXISTS public.ai_scan_results (
  id                    UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  user_id               UUID NOT NULL REFERENCES public.users(id) ON DELETE CASCADE,
  food_log_id           UUID REFERENCES public.food_logs(id) ON DELETE SET NULL,
  image_url             TEXT NOT NULL,    -- Supabase Storage public URL
  raw_api_response_json JSONB,            -- full raw API response for debugging (provider-agnostic)
  detected_foods        JSONB,            -- parsed array of detected food items
  confidence_score      NUMERIC(5, 4),    -- overall recognition confidence
  created_at            TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_ai_scan_results_user_id ON public.ai_scan_results(user_id);
CREATE INDEX IF NOT EXISTS idx_ai_scan_results_food_log_id ON public.ai_scan_results(food_log_id);


-- =============================================================================
-- TABLE 7: diet_plans
-- User's meal planning schedule. Links user + food item + date/meal slot.
-- =============================================================================
CREATE TABLE IF NOT EXISTS public.diet_plans (
  id            UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  user_id       UUID NOT NULL REFERENCES public.users(id) ON DELETE CASCADE,
  food_log_id   UUID REFERENCES public.food_logs(id) ON DELETE SET NULL,
  master_food_id UUID REFERENCES public.master_foods(id) ON DELETE SET NULL,
  food_name     TEXT NOT NULL,           -- denormalized for quick display
  calories      NUMERIC(8, 2) DEFAULT 0,
  planned_date  DATE NOT NULL,
  meal_type     TEXT NOT NULL DEFAULT 'snack'
                CHECK (meal_type IN ('breakfast', 'lunch', 'dinner', 'snack')),
  is_consumed   BOOLEAN NOT NULL DEFAULT FALSE,
  notes         TEXT,
  created_at    TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at    TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_diet_plans_user_id ON public.diet_plans(user_id);
CREATE INDEX IF NOT EXISTS idx_diet_plans_planned_date ON public.diet_plans(user_id, planned_date);

CREATE TRIGGER update_diet_plans_updated_at
  BEFORE UPDATE ON public.diet_plans
  FOR EACH ROW EXECUTE PROCEDURE public.set_updated_at();


-- =============================================================================
-- TABLE 8: complaints
-- User feedback/complaints for Admin review.
-- =============================================================================
CREATE TABLE IF NOT EXISTS public.complaints (
  id          UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  user_id     UUID NOT NULL REFERENCES public.users(id) ON DELETE CASCADE,
  subject     TEXT NOT NULL,
  message     TEXT NOT NULL,
  status      TEXT NOT NULL DEFAULT 'open' CHECK (status IN ('open', 'resolved')),
  created_at  TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_complaints_user_id ON public.complaints(user_id);



-- =============================================================================
-- ROW LEVEL SECURITY (RLS) POLICIES
-- =============================================================================

-- Enable RLS on all tables
ALTER TABLE public.users            ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.memberships      ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.payment_receipts ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.master_foods     ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.food_logs        ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.ai_scan_results  ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.diet_plans       ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.complaints       ENABLE ROW LEVEL SECURITY;


-- ----- public.users -----

-- Users can view and update only their own profile
CREATE POLICY "users_select_own" ON public.users
  FOR SELECT USING (auth.uid() = id);

CREATE POLICY "users_update_own" ON public.users
  FOR UPDATE USING (auth.uid() = id);

-- Admins can see all users
CREATE POLICY "users_admin_select_all" ON public.users
  FOR SELECT USING (
    EXISTS (SELECT 1 FROM public.users u WHERE u.id = auth.uid() AND u.role = 'admin')
  );

CREATE POLICY "users_admin_update_all" ON public.users
  FOR UPDATE USING (
    EXISTS (SELECT 1 FROM public.users u WHERE u.id = auth.uid() AND u.role = 'admin')
  );


-- ----- public.memberships -----

CREATE POLICY "memberships_select_own" ON public.memberships
  FOR SELECT USING (auth.uid() = user_id);

CREATE POLICY "memberships_insert_own" ON public.memberships
  FOR INSERT WITH CHECK (auth.uid() = user_id);

CREATE POLICY "memberships_update_own" ON public.memberships
  FOR UPDATE USING (auth.uid() = user_id);

CREATE POLICY "memberships_admin_all" ON public.memberships
  FOR ALL USING (
    EXISTS (SELECT 1 FROM public.users u WHERE u.id = auth.uid() AND u.role = 'admin')
  );


-- ----- public.payment_receipts -----

CREATE POLICY "payments_select_own" ON public.payment_receipts
  FOR SELECT USING (auth.uid() = user_id);

CREATE POLICY "payments_admin_all" ON public.payment_receipts
  FOR ALL USING (
    EXISTS (SELECT 1 FROM public.users u WHERE u.id = auth.uid() AND u.role = 'admin')
  );

-- Note: INSERT is done by the backend using service_role key (bypasses RLS)
-- so no INSERT policy is needed for regular users


-- ----- public.master_foods -----

-- Everyone (authenticated or not) can read master foods
CREATE POLICY "master_foods_public_select" ON public.master_foods
  FOR SELECT USING (TRUE);

-- Only admins can write
CREATE POLICY "master_foods_admin_write" ON public.master_foods
  FOR ALL USING (
    EXISTS (SELECT 1 FROM public.users u WHERE u.id = auth.uid() AND u.role = 'admin')
  );


-- ----- public.food_logs -----

CREATE POLICY "food_logs_select_own" ON public.food_logs
  FOR SELECT USING (auth.uid() = user_id);

CREATE POLICY "food_logs_insert_own" ON public.food_logs
  FOR INSERT WITH CHECK (auth.uid() = user_id);

CREATE POLICY "food_logs_update_own" ON public.food_logs
  FOR UPDATE USING (auth.uid() = user_id);

CREATE POLICY "food_logs_delete_own" ON public.food_logs
  FOR DELETE USING (auth.uid() = user_id);

CREATE POLICY "food_logs_admin_all" ON public.food_logs
  FOR ALL USING (
    EXISTS (SELECT 1 FROM public.users u WHERE u.id = auth.uid() AND u.role = 'admin')
  );


-- ----- public.ai_scan_results -----

CREATE POLICY "ai_scans_select_own" ON public.ai_scan_results
  FOR SELECT USING (auth.uid() = user_id);

CREATE POLICY "ai_scans_insert_own" ON public.ai_scan_results
  FOR INSERT WITH CHECK (auth.uid() = user_id);

CREATE POLICY "ai_scans_admin_all" ON public.ai_scan_results
  FOR ALL USING (
    EXISTS (SELECT 1 FROM public.users u WHERE u.id = auth.uid() AND u.role = 'admin')
  );


-- ----- public.diet_plans -----

CREATE POLICY "diet_plans_select_own" ON public.diet_plans
  FOR SELECT USING (auth.uid() = user_id);

CREATE POLICY "diet_plans_insert_own" ON public.diet_plans
  FOR INSERT WITH CHECK (auth.uid() = user_id);

CREATE POLICY "diet_plans_update_own" ON public.diet_plans
  FOR UPDATE USING (auth.uid() = user_id);

CREATE POLICY "diet_plans_delete_own" ON public.diet_plans
  FOR DELETE USING (auth.uid() = user_id);


-- ----- public.complaints -----

CREATE POLICY "complaints_select_own" ON public.complaints
  FOR SELECT USING (auth.uid() = user_id);

CREATE POLICY "complaints_insert_own" ON public.complaints
  FOR INSERT WITH CHECK (auth.uid() = user_id);

CREATE POLICY "complaints_admin_all" ON public.complaints
  FOR ALL USING (
    EXISTS (SELECT 1 FROM public.users u WHERE u.id = auth.uid() AND u.role = 'admin')
  );


-- =============================================================================
-- SUPABASE STORAGE — BUCKET SETUP
-- =============================================================================
-- Run this AFTER creating the bucket named 'food-images' in your Supabase
-- Storage dashboard (Storage > New Bucket > Name: food-images > Public: true)
--
-- Then run these policies:

INSERT INTO storage.buckets (id, name, public)
VALUES ('food-images', 'food-images', true)
ON CONFLICT (id) DO NOTHING;

CREATE POLICY "food_images_upload_authenticated" ON storage.objects
  FOR INSERT TO authenticated
  WITH CHECK (bucket_id = 'food-images');

CREATE POLICY "food_images_read_public" ON storage.objects
  FOR SELECT USING (bucket_id = 'food-images');

CREATE POLICY "food_images_delete_own" ON storage.objects
  FOR DELETE TO authenticated
  USING (bucket_id = 'food-images' AND auth.uid()::text = (storage.foldername(name))[1]);


-- =============================================================================
-- SEED DATA (Optional — master food examples)
-- =============================================================================
INSERT INTO public.master_foods (name, calories, protein, carbs, fat, fiber, serving_size)
VALUES
  ('Nasi Putih',        130, 2.7,  28.0, 0.3, 0.4, '100g'),
  ('Nasi Goreng',       246, 6.3,  36.0, 8.0, 1.2, '200g'),
  ('Ayam Bakar',        165, 31.0, 0.0,  3.6, 0.0, '100g'),
  ('Tempe Goreng',      195, 14.0, 10.0, 11.0, 3.0, '100g'),
  ('Tahu Goreng',       110, 7.0,  3.0,  7.0,  0.5, '100g'),
  ('Gado-Gado',         280, 12.0, 22.0, 16.0, 4.0, '250g'),
  ('Soto Ayam',         185, 14.0, 12.0, 8.0,  1.0, '350ml'),
  ('Rendang Sapi',      468, 33.0, 8.0,  35.0, 1.5, '150g'),
  ('Oatmeal',           150, 5.0,  27.0, 3.0,  4.0, '100g'),
  ('Telur Rebus',       78,  6.3,  0.6,  5.3,  0.0, '1 butir')
ON CONFLICT DO NOTHING;
