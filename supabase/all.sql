-- =============================================================================
-- ClaimMix consolidated Supabase SQL
-- Generated from supabase/migrations/*.sql followed by supabase/seed.sql.
-- Use this for one-shot/manual database setup. Keep numbered migrations for
-- Supabase migration history and future db push operations.
-- =============================================================================


-- =============================================================================
-- BEGIN: supabase\migrations\0001_init.sql
-- =============================================================================

-- =============================================================================
-- Migration 0001: Initial schema for ClaimMix
-- =============================================================================
-- Creates all domain tables. RLS is enabled in 0002_rls.sql.
-- Required docs config is seeded in 0003_seed_required_docs.sql.
-- =============================================================================

-- Required extensions
CREATE EXTENSION IF NOT EXISTS "uuid-ossp";
CREATE EXTENSION IF NOT EXISTS "pgcrypto";

-- =============================================================================
-- tenants
-- =============================================================================
CREATE TABLE IF NOT EXISTS public.tenants (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  name        text NOT NULL,
  created_at  timestamptz NOT NULL DEFAULT now()
);

-- =============================================================================
-- users (extends auth.users)
-- =============================================================================
CREATE TABLE IF NOT EXISTS public.users (
  id          uuid PRIMARY KEY REFERENCES auth.users(id) ON DELETE CASCADE,
  tenant_id   uuid NOT NULL REFERENCES public.tenants(id) ON DELETE CASCADE,
  full_name   text NOT NULL,
  role        text NOT NULL DEFAULT 'analyst'
                CHECK (role IN ('analyst', 'admin')),
  created_at  timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_users_tenant_role ON public.users(tenant_id, role);

-- =============================================================================
-- Helper function: current_tenant_id()
-- Returns the tenant_id for the currently authenticated user.
-- Must be defined AFTER public.users exists (SQL functions validate at creation).
-- Used by RLS policies in 0002_rls.sql.
-- =============================================================================
CREATE OR REPLACE FUNCTION public.current_tenant_id()
RETURNS uuid
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = public
AS $$
  SELECT tenant_id FROM public.users WHERE id = auth.uid() LIMIT 1;
$$;

-- =============================================================================
-- cases
-- =============================================================================
CREATE TABLE IF NOT EXISTS public.cases (
  id                 uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id          uuid NOT NULL REFERENCES public.tenants(id) ON DELETE CASCADE,
  policy_number      text,
  policyholder_name  text,
  claim_type         text NOT NULL
                       CHECK (claim_type IN ('choque', 'robo', 'granizo', 'incendio')),
  status             text NOT NULL DEFAULT 'procesando'
                       CHECK (status IN ('procesando', 'listo', 'esperando', 'escalado', 'cerrado')),
  confidence_min     numeric(3, 2)
                       CHECK (confidence_min IS NULL OR (confidence_min >= 0 AND confidence_min <= 1)),
  assigned_to        uuid REFERENCES public.users(id) ON DELETE SET NULL,
  channel            text NOT NULL DEFAULT 'email_sim'
                       CHECK (channel IN ('email_sim', 'email', 'whatsapp_sim', 'whatsapp')),
  created_at         timestamptz NOT NULL DEFAULT now(),
  updated_at         timestamptz,
  closed_at          timestamptz
);

CREATE INDEX IF NOT EXISTS idx_cases_tenant_status    ON public.cases(tenant_id, status);
CREATE INDEX IF NOT EXISTS idx_cases_tenant_type      ON public.cases(tenant_id, claim_type);
CREATE INDEX IF NOT EXISTS idx_cases_tenant_created   ON public.cases(tenant_id, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_cases_assigned_to      ON public.cases(assigned_to);

-- Trigger: auto-update updated_at on cases
CREATE OR REPLACE FUNCTION public.set_updated_at()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
  NEW.updated_at = now();
  RETURN NEW;
END;
$$;

CREATE TRIGGER trg_cases_updated_at
  BEFORE UPDATE ON public.cases
  FOR EACH ROW EXECUTE FUNCTION public.set_updated_at();

-- =============================================================================
-- raw_messages (inbound email/whatsapp bodies â€” stored verbatim, PII tagged)
-- =============================================================================
CREATE TABLE IF NOT EXISTS public.raw_messages (
  id           uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  case_id      uuid NOT NULL REFERENCES public.cases(id) ON DELETE CASCADE,
  tenant_id    uuid NOT NULL REFERENCES public.tenants(id) ON DELETE CASCADE,
  channel      text NOT NULL,
  from_addr    text,    -- [PII]
  subject      text,    -- [PII]
  body         text NOT NULL, -- [PII] full email body, stored verbatim
  received_at  timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_raw_messages_case_id ON public.raw_messages(case_id);

-- =============================================================================
-- extracted_fields (per-field AI extraction results)
-- =============================================================================
CREATE TABLE IF NOT EXISTS public.extracted_fields (
  id               uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  case_id          uuid NOT NULL REFERENCES public.cases(id) ON DELETE CASCADE,
  tenant_id        uuid NOT NULL REFERENCES public.tenants(id) ON DELETE CASCADE,
  field_key        text NOT NULL,  -- e.g. 'date', 'location', 'party_a_plate'
  field_value      text NOT NULL,  -- [PII]
  confidence       numeric(3, 2) NOT NULL
                     CHECK (confidence >= 0 AND confidence <= 1),
  extracted_at     timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT uq_extracted_field UNIQUE (case_id, field_key)
);

CREATE INDEX IF NOT EXISTS idx_extracted_fields_case_id ON public.extracted_fields(case_id);

-- =============================================================================
-- missing_docs (gap analysis results)
-- =============================================================================
CREATE TABLE IF NOT EXISTS public.missing_docs (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  case_id       uuid NOT NULL REFERENCES public.cases(id) ON DELETE CASCADE,
  tenant_id     uuid NOT NULL REFERENCES public.tenants(id) ON DELETE CASCADE,
  doc_key       text NOT NULL,  -- e.g. 'foto_oblea_vtv', 'denuncia_policial'
  requested_at  timestamptz,
  satisfied_at  timestamptz
);

CREATE INDEX IF NOT EXISTS idx_missing_docs_case_id ON public.missing_docs(case_id);

-- =============================================================================
-- outbound_messages (stub â€” rows created, no real send in MVP)
-- =============================================================================
CREATE TABLE IF NOT EXISTS public.outbound_messages (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  case_id       uuid NOT NULL REFERENCES public.cases(id) ON DELETE CASCADE,
  tenant_id     uuid NOT NULL REFERENCES public.tenants(id) ON DELETE CASCADE,
  channel       text NOT NULL,
  template      text NOT NULL,  -- e.g. 'request_missing_docs'
  rendered_body text NOT NULL,
  status        text NOT NULL DEFAULT 'queued'
                  CHECK (status IN ('queued', 'sent', 'failed')),
  created_at    timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_outbound_messages_case_id ON public.outbound_messages(case_id);

-- =============================================================================
-- audit_log (immutable audit trail â€” append-only; no UPDATE/DELETE RLS)
-- =============================================================================
CREATE TABLE IF NOT EXISTS public.audit_log (
  id           bigserial PRIMARY KEY,
  tenant_id    uuid NOT NULL,  -- not FK'd to allow logging even on tenant delete events
  actor_id     uuid REFERENCES public.users(id) ON DELETE SET NULL,
  event_type   text NOT NULL,  -- e.g. 'auth.success', 'case.closed', 'ai.extracted'
  target_type  text,           -- e.g. 'case'
  target_id    text,
  payload      jsonb NOT NULL DEFAULT '{}',  -- NEVER include DNI/policy/full_name
  ip           inet,
  ua           text,
  created_at   timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_audit_log_tenant_created  ON public.audit_log(tenant_id, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_audit_log_target          ON public.audit_log(target_type, target_id);

-- =============================================================================
-- ai_usage (token budget tracking â€” immutable)
-- =============================================================================
CREATE TABLE IF NOT EXISTS public.ai_usage (
  id                bigserial PRIMARY KEY,
  tenant_id         uuid NOT NULL,
  user_id           uuid REFERENCES public.users(id) ON DELETE SET NULL,
  model             text NOT NULL,
  prompt_tokens     integer NOT NULL DEFAULT 0,
  completion_tokens integer NOT NULL DEFAULT 0,
  cost_usd          numeric(10, 4) NOT NULL DEFAULT 0,
  created_at        timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_ai_usage_tenant_created ON public.ai_usage(tenant_id, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_ai_usage_user_created   ON public.ai_usage(user_id, created_at DESC);

-- =============================================================================
-- required_docs_config (seed/config table â€” not user data; no RLS needed)
-- =============================================================================
CREATE TABLE IF NOT EXISTS public.required_docs_config (
  claim_type  text NOT NULL,
  doc_key     text NOT NULL,
  label_es    text NOT NULL,
  required    boolean NOT NULL DEFAULT true,
  PRIMARY KEY (claim_type, doc_key)
);

-- =============================================================================
-- END: supabase\migrations\0001_init.sql
-- =============================================================================


-- =============================================================================
-- BEGIN: supabase\migrations\0002_rls.sql
-- =============================================================================

-- =============================================================================
-- Migration 0002: Row Level Security policies for ClaimMix
-- =============================================================================
-- RLS strategy: tenant isolation via current_tenant_id() helper function.
-- All authenticated users can access only rows in their own tenant.
-- Service-role key bypasses RLS entirely (used only server-side in worker).
-- audit_log is append-only: INSERT allowed, no UPDATE/DELETE policies.
-- required_docs_config has no RLS (it is a config seed table, not user data).
-- =============================================================================

-- =============================================================================
-- tenants
-- =============================================================================
ALTER TABLE public.tenants ENABLE ROW LEVEL SECURITY;

-- Analysts can only read their own tenant's row.
CREATE POLICY "tenants_read_own"
  ON public.tenants
  FOR SELECT
  USING (id = public.current_tenant_id());

-- =============================================================================
-- users
-- =============================================================================
ALTER TABLE public.users ENABLE ROW LEVEL SECURITY;

-- Analysts can read other analysts in the same tenant.
CREATE POLICY "users_read_same_tenant"
  ON public.users
  FOR SELECT
  USING (tenant_id = public.current_tenant_id());

-- Analysts can update their own profile only (no tenant hop).
CREATE POLICY "users_update_own"
  ON public.users
  FOR UPDATE
  USING (id = auth.uid())
  WITH CHECK (tenant_id = public.current_tenant_id());

-- =============================================================================
-- cases
-- =============================================================================
ALTER TABLE public.cases ENABLE ROW LEVEL SECURITY;

CREATE POLICY "cases_tenant_all"
  ON public.cases
  FOR ALL
  USING (tenant_id = public.current_tenant_id())
  WITH CHECK (tenant_id = public.current_tenant_id());

-- =============================================================================
-- raw_messages
-- =============================================================================
ALTER TABLE public.raw_messages ENABLE ROW LEVEL SECURITY;

CREATE POLICY "raw_messages_tenant_all"
  ON public.raw_messages
  FOR ALL
  USING (tenant_id = public.current_tenant_id())
  WITH CHECK (tenant_id = public.current_tenant_id());

-- =============================================================================
-- extracted_fields
-- =============================================================================
ALTER TABLE public.extracted_fields ENABLE ROW LEVEL SECURITY;

CREATE POLICY "extracted_fields_tenant_all"
  ON public.extracted_fields
  FOR ALL
  USING (tenant_id = public.current_tenant_id())
  WITH CHECK (tenant_id = public.current_tenant_id());

-- =============================================================================
-- missing_docs
-- =============================================================================
ALTER TABLE public.missing_docs ENABLE ROW LEVEL SECURITY;

CREATE POLICY "missing_docs_tenant_all"
  ON public.missing_docs
  FOR ALL
  USING (tenant_id = public.current_tenant_id())
  WITH CHECK (tenant_id = public.current_tenant_id());

-- =============================================================================
-- outbound_messages
-- =============================================================================
ALTER TABLE public.outbound_messages ENABLE ROW LEVEL SECURITY;

CREATE POLICY "outbound_messages_tenant_all"
  ON public.outbound_messages
  FOR ALL
  USING (tenant_id = public.current_tenant_id())
  WITH CHECK (tenant_id = public.current_tenant_id());

-- =============================================================================
-- audit_log â€” APPEND ONLY
-- Analysts can read their tenant's audit log.
-- No UPDATE or DELETE policies â€” audit records are immutable.
-- System (service role) writes to audit_log; RLS is bypassed by service role.
-- =============================================================================
ALTER TABLE public.audit_log ENABLE ROW LEVEL SECURITY;

CREATE POLICY "audit_log_tenant_read"
  ON public.audit_log
  FOR SELECT
  USING (tenant_id = public.current_tenant_id());

-- INSERT only â€” no UPDATE/DELETE policy means those operations are denied for
-- row-level-security-respecting clients (anon + authenticated).
CREATE POLICY "audit_log_tenant_insert"
  ON public.audit_log
  FOR INSERT
  WITH CHECK (tenant_id = public.current_tenant_id());

-- =============================================================================
-- ai_usage
-- =============================================================================
ALTER TABLE public.ai_usage ENABLE ROW LEVEL SECURITY;

CREATE POLICY "ai_usage_tenant_read"
  ON public.ai_usage
  FOR SELECT
  USING (tenant_id = public.current_tenant_id());

-- INSERT only â€” usage records are immutable.
CREATE POLICY "ai_usage_tenant_insert"
  ON public.ai_usage
  FOR INSERT
  WITH CHECK (tenant_id = public.current_tenant_id());

-- =============================================================================
-- required_docs_config â€” no RLS
-- This is a config/seed table; all authenticated users can read it.
-- No user data stored here; no tenant scoping needed.
-- =============================================================================
-- (Intentionally left without RLS â€” public read for authenticated users)

-- =============================================================================
-- END: supabase\migrations\0002_rls.sql
-- =============================================================================


-- =============================================================================
-- BEGIN: supabase\migrations\0003_seed_required_docs.sql
-- =============================================================================

-- =============================================================================
-- Migration 0003: Seed required_docs_config
-- =============================================================================
-- This is a config/reference table. Not user data. No RLS.
-- Required documents per claim type for gap-analysis logic.
-- =============================================================================

INSERT INTO public.required_docs_config (claim_type, doc_key, label_es, required) VALUES
  -- choque (collision)
  ('choque', 'parte_amistoso',   'Parte de accidente amistoso',        true),
  ('choque', 'fotos_danos',      'FotografÃ­as de los daÃ±os',           true),
  ('choque', 'licencia_conducir','Licencia de conducir del asegurado', true),

  -- robo (theft)
  ('robo',   'denuncia_policial','Denuncia policial',                  true),
  ('robo',   'fotos_lugar',      'FotografÃ­as del lugar del hecho',    true),

  -- granizo (hail)
  ('granizo','foto_oblea_vtv',   'FotografÃ­a de la oblea VTV',         true),
  ('granizo','fotos_danos',      'FotografÃ­as de los daÃ±os por granizo',true),

  -- incendio (fire)
  ('incendio','informe_bomberos','Informe de bomberos',                true),
  ('incendio','fotos_danos',     'FotografÃ­as de los daÃ±os por incendio',true),
  ('incendio','denuncia_policial','Denuncia policial (si aplica)',      true)

ON CONFLICT (claim_type, doc_key) DO UPDATE
  SET label_es = EXCLUDED.label_es,
      required = EXCLUDED.required;

-- =============================================================================
-- END: supabase\migrations\0003_seed_required_docs.sql
-- =============================================================================


-- =============================================================================
-- BEGIN: supabase\migrations\0004_admin_user_setup.sql
-- =============================================================================

-- =============================================================================
-- Migration 0004: Create default tenant and link admin user
-- =============================================================================
-- Run once after creating the first auth user in Supabase dashboard.
-- Safe to re-run (ON CONFLICT DO NOTHING / DO UPDATE).
-- =============================================================================

-- 1. Create the default tenant
INSERT INTO public.tenants (id, name, created_at)
VALUES (
  '10000000-0000-0000-0000-000000000001',
  'Mi Aseguradora',
  now()
)
ON CONFLICT (id) DO NOTHING;

-- 2. Link the admin user (finds by email, sets role = admin)
INSERT INTO public.users (id, tenant_id, full_name, role, created_at)
SELECT
  au.id,
  '10000000-0000-0000-0000-000000000001',
  COALESCE(au.raw_user_meta_data->>'full_name', split_part(au.email, '@', 1)),
  'admin',
  now()
FROM auth.users au
WHERE au.email = 'ilan.daniele@gmail.com'
ON CONFLICT (id) DO UPDATE
  SET role = 'admin',
      tenant_id = EXCLUDED.tenant_id;

-- =============================================================================
-- END: supabase\migrations\0004_admin_user_setup.sql
-- =============================================================================


-- =============================================================================
-- BEGIN: supabase\migrations\0005_email_intake.sql
-- =============================================================================

-- =============================================================================
-- Migration 0005: Email intake â€” extend cases table for email claims workflow
-- =============================================================================
-- Adds new columns required by the email claims intake pipeline:
--   - email_message_id: Postmark MessageID for idempotency (UNIQUE per tenant)
--   - email_thread_id:  thread grouping via In-Reply-To / References headers
--   - is_claim:         NULL=not yet determined, true=claim, false=not relevant
--   - not_relevant_reason: classifier reason when is_claim=false
--   - requires_specialist: escalation flag set by severity classifier
--   - customer_id:      FK to customers table (added after 0006 creates that table)
--   - policy_id:        FK to policies table (added after 0006 creates that table)
--   - severity:         CHECK ('low','medium','high','critical')
--   - core_*:           fields for CoreSyncService integration
--   - fields_pending_confirmation: JSONB list of field keys awaiting user confirmation
--
-- Also extends the status CHECK constraint to include new FSM states:
--   recibido, info_faltante, confirmacion_pendiente, requiere_especialista,
--   listo_para_core, enviado_a_core, error_core, no_relevante
--
-- Existing statuses are preserved:
--   procesando, listo, esperando, escalado, cerrado
-- =============================================================================

-- Step 1: Drop and recreate status CHECK with the extended list.
-- PostgreSQL does not support ALTER CONSTRAINT ... so we drop + recreate.
ALTER TABLE public.cases
  DROP CONSTRAINT IF EXISTS cases_status_check;

ALTER TABLE public.cases
  ADD CONSTRAINT cases_status_check
    CHECK (status IN (
      -- Original statuses (must be kept intact)
      'procesando',
      'listo',
      'esperando',
      'escalado',
      'cerrado',
      -- New email-intake statuses (IC6)
      'recibido',
      'info_faltante',
      'confirmacion_pendiente',
      'requiere_especialista',
      'listo_para_core',
      'enviado_a_core',
      'error_core',
      'no_relevante'
    ));

-- Step 2: Add new columns to cases.
-- All are nullable so existing rows are unaffected.

ALTER TABLE public.cases
  ADD COLUMN IF NOT EXISTS email_message_id      text,
  ADD COLUMN IF NOT EXISTS email_thread_id       text,
  ADD COLUMN IF NOT EXISTS is_claim              boolean DEFAULT NULL,
  ADD COLUMN IF NOT EXISTS not_relevant_reason   text,
  ADD COLUMN IF NOT EXISTS requires_specialist   boolean NOT NULL DEFAULT false,
  ADD COLUMN IF NOT EXISTS severity              text
    CHECK (severity IS NULL OR severity IN ('low', 'medium', 'high', 'critical')),
  ADD COLUMN IF NOT EXISTS core_external_id      text,
  ADD COLUMN IF NOT EXISTS core_error_message    text,
  ADD COLUMN IF NOT EXISTS core_sent_at          timestamptz,
  ADD COLUMN IF NOT EXISTS fields_pending_confirmation jsonb NOT NULL DEFAULT '[]';

-- Step 3: Indexes for email lookup.

-- Unique index: ensures idempotency for Postmark MessageID per tenant.
-- Partial index (WHERE NOT NULL) avoids conflicts on non-email cases.
CREATE UNIQUE INDEX IF NOT EXISTS idx_cases_tenant_email_message_id
  ON public.cases(tenant_id, email_message_id)
  WHERE email_message_id IS NOT NULL;

-- Non-unique index: thread lookup via In-Reply-To / References headers.
CREATE INDEX IF NOT EXISTS idx_cases_tenant_email_thread_id
  ON public.cases(tenant_id, email_thread_id)
  WHERE email_thread_id IS NOT NULL;

-- Index for severity filter (used in GET /api/cases?severity=high queries).
CREATE INDEX IF NOT EXISTS idx_cases_tenant_severity
  ON public.cases(tenant_id, severity)
  WHERE severity IS NOT NULL;

-- Note: customer_id and policy_id FKs are added in 0006_customers_policies.sql
-- after those tables are created. Adding them here would fail because the
-- referenced tables do not yet exist at this point in the migration sequence.

-- =============================================================================
-- END: supabase\migrations\0005_email_intake.sql
-- =============================================================================


-- =============================================================================
-- BEGIN: supabase\migrations\0006_customers_policies.sql
-- =============================================================================

-- =============================================================================
-- Migration 0006: customers, customer_contacts, policies, insured_assets
-- =============================================================================
-- Creates tables for customer/policy preloaded data that the AI extraction
-- pipeline matches against. All tables are tenant-scoped with RLS.
--
-- RLS strategy: tenant_id = current_tenant_id() on all SELECT/INSERT/UPDATE/DELETE.
-- Service-role key bypasses RLS for admin bulk import and worker writes.
--
-- IC5: These tables are mandatory (not optional) per spec interpretation contract.
-- AC22: Customer matching priority: policy > dni > email.
-- =============================================================================

-- =============================================================================
-- customers
-- =============================================================================
CREATE TABLE IF NOT EXISTS public.customers (
  id           uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id    uuid NOT NULL REFERENCES public.tenants(id) ON DELETE CASCADE,
  full_name    text NOT NULL,                -- [PII]
  email        text,                         -- [PII]
  dni          text,                         -- [PII] Argentine national ID
  phone        text,                         -- [PII]
  birth_date   date,                         -- [PII]
  address      text,                         -- [PII]
  notes        text,
  created_at   timestamptz NOT NULL DEFAULT now(),
  updated_at   timestamptz
);

-- Trigger: auto-update updated_at on customers
CREATE TRIGGER trg_customers_updated_at
  BEFORE UPDATE ON public.customers
  FOR EACH ROW EXECUTE FUNCTION public.set_updated_at();

-- Indexes for matching (AC22)
CREATE INDEX IF NOT EXISTS idx_customers_tenant_email
  ON public.customers(tenant_id, email)
  WHERE email IS NOT NULL;

CREATE UNIQUE INDEX IF NOT EXISTS idx_customers_tenant_dni
  ON public.customers(tenant_id, dni)
  WHERE dni IS NOT NULL;

-- RLS
ALTER TABLE public.customers ENABLE ROW LEVEL SECURITY;

CREATE POLICY "customers_tenant_all"
  ON public.customers
  FOR ALL
  USING (tenant_id = public.current_tenant_id())
  WITH CHECK (tenant_id = public.current_tenant_id());

-- =============================================================================
-- customer_contacts
-- =============================================================================
-- Stores alternate contact points for a customer (multiple emails, phones, etc.)
-- The main customer.email / customer.phone fields are the primary contacts.
CREATE TABLE IF NOT EXISTS public.customer_contacts (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id     uuid NOT NULL REFERENCES public.tenants(id) ON DELETE CASCADE,
  customer_id   uuid NOT NULL REFERENCES public.customers(id) ON DELETE CASCADE,
  contact_type  text NOT NULL
                  CHECK (contact_type IN ('email', 'phone', 'address', 'dni')),
  value         text NOT NULL,               -- [PII]
  is_primary    boolean NOT NULL DEFAULT false,
  verified_at   timestamptz,
  created_at    timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_customer_contacts_customer_id
  ON public.customer_contacts(customer_id);

CREATE INDEX IF NOT EXISTS idx_customer_contacts_tenant_type_value
  ON public.customer_contacts(tenant_id, contact_type, value);

-- RLS
ALTER TABLE public.customer_contacts ENABLE ROW LEVEL SECURITY;

CREATE POLICY "customer_contacts_tenant_all"
  ON public.customer_contacts
  FOR ALL
  USING (tenant_id = public.current_tenant_id())
  WITH CHECK (tenant_id = public.current_tenant_id());

-- =============================================================================
-- policies
-- =============================================================================
CREATE TABLE IF NOT EXISTS public.policies (
  id             uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id      uuid NOT NULL REFERENCES public.tenants(id) ON DELETE CASCADE,
  customer_id    uuid NOT NULL REFERENCES public.customers(id) ON DELETE CASCADE,
  policy_number  text NOT NULL,              -- [PII]
  policy_type    text NOT NULL DEFAULT 'auto'
                   CHECK (policy_type IN ('auto', 'home', 'life', 'business', 'other')),
  status         text NOT NULL DEFAULT 'active'
                   CHECK (status IN ('active', 'expired', 'cancelled')),
  start_date     date,
  end_date       date,
  premium_amount numeric(12, 2),
  created_at     timestamptz NOT NULL DEFAULT now(),
  updated_at     timestamptz
);

CREATE TRIGGER trg_policies_updated_at
  BEFORE UPDATE ON public.policies
  FOR EACH ROW EXECUTE FUNCTION public.set_updated_at();

-- UNIQUE: one policy_number per tenant (policy numbers are tenant-scoped)
CREATE UNIQUE INDEX IF NOT EXISTS idx_policies_tenant_policy_number
  ON public.policies(tenant_id, policy_number);

CREATE INDEX IF NOT EXISTS idx_policies_tenant_customer
  ON public.policies(tenant_id, customer_id);

-- RLS
ALTER TABLE public.policies ENABLE ROW LEVEL SECURITY;

CREATE POLICY "policies_tenant_all"
  ON public.policies
  FOR ALL
  USING (tenant_id = public.current_tenant_id())
  WITH CHECK (tenant_id = public.current_tenant_id());

-- =============================================================================
-- insured_assets
-- =============================================================================
-- Assets covered by a policy (vehicles, properties, persons).
-- One policy may cover multiple assets.
CREATE TABLE IF NOT EXISTS public.insured_assets (
  id           uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id    uuid NOT NULL REFERENCES public.tenants(id) ON DELETE CASCADE,
  policy_id    uuid NOT NULL REFERENCES public.policies(id) ON DELETE CASCADE,
  asset_type   text NOT NULL
                 CHECK (asset_type IN ('vehicle', 'property', 'person', 'other')),
  make         text,           -- vehicle make (e.g. "Ford")
  model        text,           -- vehicle model (e.g. "Focus")
  year         smallint,       -- model year
  plate        text,           -- [PII] license plate
  vin          text,           -- [PII] vehicle identification number
  description  text,           -- free-text description for non-vehicle assets [PII]
  created_at   timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_insured_assets_tenant_policy
  ON public.insured_assets(tenant_id, policy_id);

-- RLS
ALTER TABLE public.insured_assets ENABLE ROW LEVEL SECURITY;

CREATE POLICY "insured_assets_tenant_all"
  ON public.insured_assets
  FOR ALL
  USING (tenant_id = public.current_tenant_id())
  WITH CHECK (tenant_id = public.current_tenant_id());

-- =============================================================================
-- Add FK columns from cases â†’ customers and cases â†’ policies
-- =============================================================================
-- These are added here (not in 0005) because customers and policies tables
-- must exist before the FK constraints can be defined.

ALTER TABLE public.cases
  ADD COLUMN IF NOT EXISTS customer_id uuid REFERENCES public.customers(id) ON DELETE SET NULL,
  ADD COLUMN IF NOT EXISTS policy_id   uuid REFERENCES public.policies(id) ON DELETE SET NULL;

CREATE INDEX IF NOT EXISTS idx_cases_customer_id
  ON public.cases(customer_id)
  WHERE customer_id IS NOT NULL;

CREATE INDEX IF NOT EXISTS idx_cases_policy_id
  ON public.cases(policy_id)
  WHERE policy_id IS NOT NULL;

-- =============================================================================
-- END: supabase\migrations\0006_customers_policies.sql
-- =============================================================================


-- =============================================================================
-- BEGIN: supabase\migrations\0007_claim_extras.sql
-- =============================================================================

-- =============================================================================
-- Migration 0007: claim_attachments, claim_field_confirmations,
--                 claim_memory, known_claim_patterns
-- =============================================================================
-- These four tables support:
--   - Attachment storage (AC23): PDF/image refs from Postmark inbound webhook
--   - Field confirmation workflow (AC7, AC9, AC14, AC21): analyst review of
--     AI-extracted fields with medium confidence or conflicts vs stored data
--   - Smart memory (AC13, AC14): sender-level learning to improve extraction
--     accuracy on repeat submissions from the same email address
--   - Claim pattern matching (AC11, AC15): keyword/regex signals for severity
--     classification and claim detection before LLM call
--
-- All tables: tenant_id = current_tenant_id() RLS.
-- =============================================================================

-- =============================================================================
-- claim_attachments
-- =============================================================================
-- Stores metadata for email attachments received via Postmark inbound webhook.
-- The actual file content is hosted on Postmark's CDN (external_url).
-- content_hash (SHA-256) enables deduplication and integrity verification.
--
-- NOTE: Postmark CDN URLs expire after ~7 days. A follow-up job should
-- download and re-host to Supabase Storage. See implementation-notes.md.
CREATE TABLE IF NOT EXISTS public.claim_attachments (
  id                 uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id          uuid NOT NULL REFERENCES public.tenants(id) ON DELETE CASCADE,
  case_id            uuid NOT NULL REFERENCES public.cases(id) ON DELETE CASCADE,
  created_at         timestamptz NOT NULL DEFAULT now(),
  file_name          text NOT NULL,
  content_type       text NOT NULL,
  size_bytes         integer NOT NULL CHECK (size_bytes >= 0),
  external_url       text,           -- Postmark CDN URL (expires ~7 days)
  storage_path       text,           -- Supabase Storage path (after re-host)
  content_hash       text,           -- SHA-256 hex of file content
  source_message_id  text            -- Postmark MessageID this attachment came from
);

CREATE INDEX IF NOT EXISTS idx_claim_attachments_case_id
  ON public.claim_attachments(case_id);

CREATE INDEX IF NOT EXISTS idx_claim_attachments_tenant_case
  ON public.claim_attachments(tenant_id, case_id);

ALTER TABLE public.claim_attachments ENABLE ROW LEVEL SECURITY;

CREATE POLICY "claim_attachments_tenant_all"
  ON public.claim_attachments
  FOR ALL
  USING (tenant_id = public.current_tenant_id())
  WITH CHECK (tenant_id = public.current_tenant_id());

-- =============================================================================
-- claim_field_confirmations
-- =============================================================================
-- Tracks extracted fields that require analyst review before the case can proceed.
-- Created when:
--   - Extraction confidence is medium (0.60â€“0.85) â†’ AC7
--   - Extracted value conflicts with stored customer record â†’ AC9
--   - A confirmed memory field has a new high-confidence alternative â†’ AC14
--
-- Status lifecycle: pending â†’ confirmed | rejected | corrected
-- (corrected: analyst provides a different value than either proposed or stored)
CREATE TABLE IF NOT EXISTS public.claim_field_confirmations (
  id                  uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id           uuid NOT NULL REFERENCES public.tenants(id) ON DELETE CASCADE,
  case_id             uuid NOT NULL REFERENCES public.cases(id) ON DELETE CASCADE,
  created_at          timestamptz NOT NULL DEFAULT now(),
  updated_at          timestamptz,
  field_name          text NOT NULL,       -- e.g. 'full_name', 'dni', 'policy_number'
  suggested_value     text,                -- [PII] AI-extracted value
  conflict_with_value text,               -- [PII] existing stored value (if conflict)
  confidence          numeric(3, 2) NOT NULL
                        CHECK (confidence >= 0 AND confidence <= 1),
  status              text NOT NULL DEFAULT 'pending'
                        CHECK (status IN ('pending', 'confirmed', 'rejected', 'corrected')),
  confirmed_by        uuid REFERENCES public.users(id) ON DELETE SET NULL,
  confirmed_at        timestamptz,
  notes               text
);

CREATE TRIGGER trg_claim_field_confirmations_updated_at
  BEFORE UPDATE ON public.claim_field_confirmations
  FOR EACH ROW EXECUTE FUNCTION public.set_updated_at();

CREATE INDEX IF NOT EXISTS idx_claim_field_confirmations_case_id
  ON public.claim_field_confirmations(case_id);

CREATE INDEX IF NOT EXISTS idx_claim_field_confirmations_tenant_status
  ON public.claim_field_confirmations(tenant_id, status)
  WHERE status = 'pending';

ALTER TABLE public.claim_field_confirmations ENABLE ROW LEVEL SECURITY;

CREATE POLICY "claim_field_confirmations_tenant_all"
  ON public.claim_field_confirmations
  FOR ALL
  USING (tenant_id = public.current_tenant_id())
  WITH CHECK (tenant_id = public.current_tenant_id());

-- =============================================================================
-- claim_memory
-- =============================================================================
-- Per-sender memory store. Accumulates confirmed extraction results for a
-- sender email address so future emails from the same sender benefit from
-- pre-filled context injected into the LLM prompt.
--
-- confirmed_fields: { field_key: { value, confirmed_at, confirmed_by } }
-- correction_history: [ { field_key, old_value, new_value, changed_at } ]
-- sender_patterns: arbitrary JSONB for structural patterns (subject prefix, etc.)
--
-- UNIQUE(tenant_id, sender_email): one memory record per sender per tenant.
-- Memory is NEVER auto-overwritten â€” analyst must explicitly confirm (AC14).
CREATE TABLE IF NOT EXISTS public.claim_memory (
  id                   uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id            uuid NOT NULL REFERENCES public.tenants(id) ON DELETE CASCADE,
  created_at           timestamptz NOT NULL DEFAULT now(),
  updated_at           timestamptz,
  memory_type          text NOT NULL DEFAULT 'sender_profile'
                         CHECK (memory_type IN (
                           'sender_profile',   -- per-sender confirmed fields
                           'field_correction', -- analyst-corrected field history
                           'pattern',          -- observed email structural patterns
                           'policy_link'       -- confirmed senderâ†’policy association
                         )),
  key                  text NOT NULL,   -- typically sender_email (or pattern key)
  value                jsonb NOT NULL DEFAULT '{}',
  confidence           double precision CHECK (confidence IS NULL OR (confidence >= 0 AND confidence <= 1)),
  source               text,           -- e.g. 'manual', 'ai', 'confirmation'
  last_used_at         timestamptz,
  use_count            integer NOT NULL DEFAULT 0 CHECK (use_count >= 0)
);

CREATE TRIGGER trg_claim_memory_updated_at
  BEFORE UPDATE ON public.claim_memory
  FOR EACH ROW EXECUTE FUNCTION public.set_updated_at();

-- Unique sender profile per tenant
CREATE UNIQUE INDEX IF NOT EXISTS idx_claim_memory_tenant_type_key
  ON public.claim_memory(tenant_id, memory_type, key);

CREATE INDEX IF NOT EXISTS idx_claim_memory_tenant
  ON public.claim_memory(tenant_id);

ALTER TABLE public.claim_memory ENABLE ROW LEVEL SECURITY;

CREATE POLICY "claim_memory_tenant_all"
  ON public.claim_memory
  FOR ALL
  USING (tenant_id = public.current_tenant_id())
  WITH CHECK (tenant_id = public.current_tenant_id());

-- =============================================================================
-- known_claim_patterns
-- =============================================================================
-- Keyword/phrase/regex signals for pre-LLM claim and severity classification.
-- Global seed rows have tenant_id = NULL (visible to all tenants).
-- Tenant-specific overrides have tenant_id set.
--
-- RLS: tenant rows visible to that tenant; global rows (tenant_id IS NULL)
-- visible to all authenticated users.
--
-- signal: what this pattern indicates when matched
-- weight: relative importance (0.00â€“1.00) for combining multiple signals
CREATE TABLE IF NOT EXISTS public.known_claim_patterns (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id     uuid REFERENCES public.tenants(id) ON DELETE CASCADE,  -- NULL = global
  created_at    timestamptz NOT NULL DEFAULT now(),
  pattern_text  text NOT NULL,
  pattern_type  text NOT NULL DEFAULT 'keyword'
                  CHECK (pattern_type IN ('keyword', 'phrase', 'regex')),
  claim_type    text,          -- e.g. 'auto', 'incendio', 'robo'; NULL = any
  severity_hint text
                  CHECK (severity_hint IS NULL OR severity_hint IN (
                    'low', 'medium', 'high', 'critical'
                  )),
  language      text NOT NULL DEFAULT 'es-AR',
  enabled       boolean NOT NULL DEFAULT true
);

CREATE INDEX IF NOT EXISTS idx_known_claim_patterns_tenant
  ON public.known_claim_patterns(tenant_id)
  WHERE tenant_id IS NOT NULL;

CREATE INDEX IF NOT EXISTS idx_known_claim_patterns_global
  ON public.known_claim_patterns(enabled)
  WHERE tenant_id IS NULL AND enabled = true;

ALTER TABLE public.known_claim_patterns ENABLE ROW LEVEL SECURITY;

-- Tenant-specific patterns: visible only to that tenant
CREATE POLICY "known_claim_patterns_tenant"
  ON public.known_claim_patterns
  FOR ALL
  USING (
    tenant_id = public.current_tenant_id()
    OR tenant_id IS NULL  -- global patterns visible to all
  )
  WITH CHECK (tenant_id = public.current_tenant_id());

-- =============================================================================
-- END: supabase\migrations\0007_claim_extras.sql
-- =============================================================================


-- =============================================================================
-- BEGIN: supabase\migrations\0008_seed_patterns.sql
-- =============================================================================

-- =============================================================================
-- Migration 0008: Seed known_claim_patterns with es-AR insurance claim signals
-- =============================================================================
-- Global seed rows (tenant_id = NULL) provide baseline signal detection for
-- all tenants. These are keyword/phrase patterns common in Argentine Spanish
-- insurance claims.
--
-- Signal mapping:
--   severity_hint = 'critical' â†’ death, fire, armed robbery, threat
--   severity_hint = 'high'     â†’ injuries, ambulance, police, hospitalization
--   severity_hint = 'medium'   â†’ collision, accident, hail
--   severity_hint = 'low'      â†’ minor scratches, light bumps, cosmetic damage
--
-- AC11, AC15: These patterns feed the keyword-based severity classifier
-- (src/server/ai/severity-classifier.ts) which runs before/alongside LLM.
-- =============================================================================

INSERT INTO public.known_claim_patterns
  (tenant_id, pattern_text, pattern_type, severity_hint, language, enabled)
VALUES
  -- â”€â”€ CRITICAL â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€
  (NULL, 'fallecido',              'keyword', 'critical', 'es-AR', true),
  (NULL, 'fallecimiento',          'keyword', 'critical', 'es-AR', true),
  (NULL, 'muerte',                 'keyword', 'critical', 'es-AR', true),
  (NULL, 'muerto',                 'keyword', 'critical', 'es-AR', true),
  (NULL, 'muerta',                 'keyword', 'critical', 'es-AR', true),
  (NULL, 'incendio',               'keyword', 'critical', 'es-AR', true),
  (NULL, 'robo a mano armada',     'phrase',  'critical', 'es-AR', true),
  (NULL, 'amenaza con arma',       'phrase',  'critical', 'es-AR', true),
  (NULL, 'amenaza',                'keyword', 'critical', 'es-AR', true),
  (NULL, 'explosiÃ³n',              'keyword', 'critical', 'es-AR', true),
  (NULL, 'explosion',              'keyword', 'critical', 'es-AR', true),

  -- â”€â”€ HIGH â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€
  (NULL, 'ambulancia',             'keyword', 'high', 'es-AR', true),
  (NULL, 'hospitalizado',          'keyword', 'high', 'es-AR', true),
  (NULL, 'hospitalizada',          'keyword', 'high', 'es-AR', true),
  (NULL, 'herido',                 'keyword', 'high', 'es-AR', true),
  (NULL, 'herida',                 'keyword', 'high', 'es-AR', true),
  (NULL, 'lesiones',               'keyword', 'high', 'es-AR', true),
  (NULL, 'lesionado',              'keyword', 'high', 'es-AR', true),
  (NULL, 'lesionada',              'keyword', 'high', 'es-AR', true),
  (NULL, 'policÃ­a',                'keyword', 'high', 'es-AR', true),
  (NULL, 'policia',                'keyword', 'high', 'es-AR', true),
  (NULL, 'urgencia',               'keyword', 'high', 'es-AR', true),
  (NULL, 'robo',                   'keyword', 'high', 'es-AR', true),
  (NULL, 'hurto',                  'keyword', 'high', 'es-AR', true),

  -- â”€â”€ MEDIUM â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€
  (NULL, 'choque',                 'keyword', 'medium', 'es-AR', true),
  (NULL, 'colisiÃ³n',               'keyword', 'medium', 'es-AR', true),
  (NULL, 'colision',               'keyword', 'medium', 'es-AR', true),
  (NULL, 'accidente',              'keyword', 'medium', 'es-AR', true),
  (NULL, 'granizo',                'keyword', 'medium', 'es-AR', true),
  (NULL, 'inundaciÃ³n',             'keyword', 'medium', 'es-AR', true),
  (NULL, 'inundacion',             'keyword', 'medium', 'es-AR', true),
  (NULL, 'chocaron',               'keyword', 'medium', 'es-AR', true),

  -- â”€â”€ LOW â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€
  (NULL, 'rayones',                'keyword', 'low', 'es-AR', true),
  (NULL, 'rayÃ³n',                  'keyword', 'low', 'es-AR', true),
  (NULL, 'golpe leve',             'phrase',  'low', 'es-AR', true),
  (NULL, 'daÃ±o menor',             'phrase',  'low', 'es-AR', true),
  (NULL, 'raspÃ³n',                 'keyword', 'low', 'es-AR', true),
  (NULL, 'raspones',               'keyword', 'low', 'es-AR', true),
  (NULL, 'abolladura leve',        'phrase',  'low', 'es-AR', true),
  (NULL, 'daÃ±o estÃ©tico',          'phrase',  'low', 'es-AR', true),
  (NULL, 'sin heridos',            'phrase',  'low', 'es-AR', true)
ON CONFLICT DO NOTHING;

-- =============================================================================
-- END: supabase\migrations\0008_seed_patterns.sql
-- =============================================================================


-- =============================================================================
-- BEGIN: supabase\migrations\0009_claim_messages.sql
-- =============================================================================

-- =============================================================================
-- Migration 0009: claim_messages unified table + claim_attachments extensions
--                 + claim-attachments Supabase Storage bucket
-- =============================================================================
--
-- PURPOSE
-- -------
-- Introduces the unified claim_messages table that persists BOTH inbound
-- (direction='inbound') and outbound (direction='outbound') email records,
-- replacing the split raw_messages / outbound_messages model for new writes.
-- A dual-write window is maintained: existing raw_messages and
-- outbound_messages inserts are preserved until backfill (migration 0010)
-- and a follow-up migration confirm parity and drop the legacy tables.
--
-- ONLINE SAFETY
-- -------------
-- All statements are additive-only and table-locking-free:
--   CREATE TABLE       â€” new table, no lock on existing tables
--   CREATE INDEX CONCURRENTLY â€” does not hold a share lock on the table;
--                               safe on live traffic (Supabase supports this)
--   ALTER TABLE â€¦ ADD COLUMN IF NOT EXISTS â€” fast metadata-only in Postgres 11+
--   INSERT INTO storage.buckets â€¦ ON CONFLICT DO NOTHING â€” idempotent
--   CREATE POLICY â€” no table lock
-- No DROP TABLE, DROP COLUMN, or ALTER COLUMN TYPE statements are present.
--
-- PII COLUMNS
-- -----------
-- Columns that contain personally identifiable information are marked [PII]
-- in their inline comments. These columns must never appear in structured
-- application logs (stdout JSON). They are stored encrypted at rest by
-- Supabase and are accessible only to tenant-scoped clients and the
-- service-role system actor.
--
-- ROLLBACK PLAN (manual â€” no down migration in this codebase)
-- -----------------------------------------------------------
-- To reverse this migration execute the following statements in order
-- (requires service-role access; stops dual-write first):
--
--   1. DROP INDEX CONCURRENTLY IF EXISTS idx_claim_messages_tenant_provider_msgid;
--   2. DROP INDEX CONCURRENTLY IF EXISTS idx_claim_messages_case_received;
--   3. DROP INDEX CONCURRENTLY IF EXISTS idx_claim_messages_tenant_thread;
--   4. DROP INDEX CONCURRENTLY IF EXISTS idx_claim_messages_direction_status;
--   5. DROP TABLE IF EXISTS public.claim_messages CASCADE;
--      (CASCADE drops the FK from claim_attachments.claim_message_id automatically)
--   6. ALTER TABLE public.claim_attachments
--        DROP COLUMN IF EXISTS claim_message_id,
--        DROP COLUMN IF EXISTS rejected_reason;
--   7. DELETE FROM storage.buckets WHERE id = 'claim-attachments';
--      (only if the bucket is empty; Supabase will refuse otherwise)
--
-- Estimate: < 1 minute on an empty or low-traffic database.
-- On a populated database step 5 is still fast because CASCADE only drops
-- the FK constraint and the column from claim_attachments â€” it does not
-- touch claim_attachments rows (ON DELETE CASCADE is on the column, not the
-- table drop).
-- =============================================================================

-- =============================================================================
-- SECTION 1: claim_messages table
-- =============================================================================
-- Unified store for all email messages processed by the system.
-- direction='inbound'  â†’ received from Postmark webhook
-- direction='outbound' â†’ sent via Postmark outbound API
--
-- The table is append-only by RLS convention (no DELETE policy).
-- Service-role client bypasses RLS for system actor writes (same as
-- raw_messages and outbound_messages).
-- =============================================================================

CREATE TABLE IF NOT EXISTS public.claim_messages (
  -- Primary key
  id                   uuid        PRIMARY KEY DEFAULT gen_random_uuid(),

  -- Tenant + case scoping (FK to cases cascades deletes)
  tenant_id            uuid        NOT NULL REFERENCES public.tenants(id) ON DELETE CASCADE,
  case_id              uuid        NOT NULL REFERENCES public.cases(id) ON DELETE CASCADE,

  -- Direction enum: inbound (received) or outbound (sent)
  direction            text        NOT NULL
                         CHECK (direction IN ('inbound', 'outbound')),

  -- Provider identifier â€” 'postmark' for all rows in this PR;
  -- stored as text (not enum) to allow future providers without a migration.
  provider             text        NOT NULL DEFAULT 'postmark',

  -- provider_message_id: Postmark MessageID (e.g. "abc@mail.postmarkapp.com").
  -- NULL only for direction='outbound' rows in status='queued' (set after send).
  -- Uniqueness per (tenant_id, provider_message_id) is enforced by the partial
  -- unique index below; the column is intentionally nullable at the DB level
  -- to accommodate the outbound queued state without a race condition.
  -- [PII-adjacent] â€” do not log this value.
  provider_message_id  text,

  -- thread_id: matches cases.email_thread_id semantics.
  -- Populated from extractThreadId() on the inbound side; copied from the
  -- inbound thread on the outbound side.
  thread_id            text,

  -- in_reply_to: normalized Postmark MessageID this message replies to
  -- (angle brackets stripped at application layer before storage).
  in_reply_to          text,

  -- Addressing fields â€” present only for the relevant direction.
  from_addr            text,        -- [PII] inbound: claimant address
  to_addr              text,        -- [PII] outbound: claimant address; inbound: intake inbox
  subject              text,        -- [PII]

  -- Body fields â€” at least one populated per message.
  body_text            text,        -- [PII] inbound: plaintext; outbound: rendered text
  body_html            text,        -- [PII]

  -- headers: full Postmark Headers array (array of {Name, Value} objects).
  -- Defaults to empty array so legacy code paths can insert without specifying it.
  -- [PII] â€” may contain sender email addresses in Received / X-Forwarded-To headers.
  headers              jsonb       NOT NULL DEFAULT '[]'::jsonb,

  -- raw_payload: verbatim parsed Postmark inbound JSON (direction='inbound' only).
  -- NULL for outbound rows; never logged.
  -- [PII] â€” contains full email body, from_addr, and attachment metadata.
  raw_payload          jsonb,

  -- template: outbound template key (e.g. 'confirmation-received').
  -- NULL for inbound rows.
  template             text,

  -- status lifecycle:
  --   inbound:  always 'received' on insert
  --   outbound: 'queued' â†’ 'sent' on Postmark success
  --             'queued' â†’ 'failed' on Postmark error
  status               text        NOT NULL
                         CHECK (status IN ('received', 'queued', 'sent', 'failed')),

  -- error_code: populated when status='failed' (e.g. 'POSTMARK_SEND_FAILED').
  -- NULL when status != 'failed'.
  error_code           text,

  -- Timestamps
  received_at          timestamptz NOT NULL DEFAULT now(),
  sent_at              timestamptz                       -- NULL until outbound send completes
);

-- =============================================================================
-- SECTION 2: Indexes on claim_messages
--
-- Note: CONCURRENTLY is omitted here because Supabase's migration runner
-- executes statements in a pipeline context, which forbids CONCURRENTLY.
-- Safe to omit: the table is new in this migration, so no live traffic hits it.
-- =============================================================================

-- Deduplication index (both directions):
-- Prevents double-processing of the same provider MessageID per tenant.
-- Partial index (WHERE NOT NULL) avoids blocking outbound queued rows.
CREATE UNIQUE INDEX IF NOT EXISTS idx_claim_messages_tenant_provider_msgid
  ON public.claim_messages (tenant_id, provider_message_id)
  WHERE provider_message_id IS NOT NULL;

-- Case timeline index:
-- Efficient retrieval of all messages for a case sorted by arrival time.
CREATE INDEX IF NOT EXISTS idx_claim_messages_case_received
  ON public.claim_messages (case_id, received_at DESC);

-- Thread lookup index:
-- Used by threadLookup() to find the case for a reply.
-- Partial index (WHERE NOT NULL) skips rows without a thread_id.
CREATE INDEX IF NOT EXISTS idx_claim_messages_tenant_thread
  ON public.claim_messages (tenant_id, thread_id)
  WHERE thread_id IS NOT NULL;

-- Operational query index:
-- Used to query all queued outbound messages or all failed inbound messages.
CREATE INDEX IF NOT EXISTS idx_claim_messages_direction_status
  ON public.claim_messages (direction, status);

-- =============================================================================
-- SECTION 3: RLS for claim_messages
--
-- Mirrors the existing raw_messages and outbound_messages RLS patterns.
-- The table is append-only: no DELETE policy â†’ DELETE is denied for all
-- RLS-respecting clients (authenticated + anon).
-- Service-role bypasses RLS (existing convention for the email pipeline).
-- =============================================================================

ALTER TABLE public.claim_messages ENABLE ROW LEVEL SECURITY;

-- SELECT: tenant-scoped read
CREATE POLICY "claim_messages_tenant_select"
  ON public.claim_messages
  FOR SELECT
  USING (tenant_id = public.current_tenant_id());

-- INSERT: tenant-scoped write (service-role bypasses RLS)
CREATE POLICY "claim_messages_tenant_insert"
  ON public.claim_messages
  FOR INSERT
  WITH CHECK (tenant_id = public.current_tenant_id());

-- UPDATE: tenant-scoped update â€” required by the outbound dispatcher to
-- transition status from 'queued' â†’ 'sent'|'failed' and set provider_message_id.
CREATE POLICY "claim_messages_tenant_update"
  ON public.claim_messages
  FOR UPDATE
  USING (tenant_id = public.current_tenant_id())
  WITH CHECK (tenant_id = public.current_tenant_id());

-- No DELETE policy â€” claim_messages is append-only.

-- =============================================================================
-- SECTION 4: Extend claim_attachments
--
-- Adds two columns to the existing claim_attachments table:
--   claim_message_id â€” FK to claim_messages; links each attachment to the
--                      specific message that carried it. Nullable for rows
--                      created before this migration (dual-write window).
--   rejected_reason  â€” reason text when an attachment is rejected by the
--                      content-type allowlist or size cap. NULL = accepted.
-- =============================================================================

ALTER TABLE public.claim_attachments
  ADD COLUMN IF NOT EXISTS claim_message_id uuid
    REFERENCES public.claim_messages(id) ON DELETE CASCADE,
  ADD COLUMN IF NOT EXISTS rejected_reason text;

-- Index for looking up all attachments belonging to a specific message.
CREATE INDEX IF NOT EXISTS idx_claim_attachments_claim_message_id
  ON public.claim_attachments (claim_message_id)
  WHERE claim_message_id IS NOT NULL;

-- =============================================================================
-- SECTION 5: Supabase Storage bucket â€” claim-attachments
--
-- Creates the private storage bucket used to re-host Postmark CDN attachments.
-- The bucket is private (public = false): files are accessible only via
-- service-role uploads and time-limited signed URLs generated by the backend.
--
-- ON CONFLICT DO NOTHING makes this statement idempotent â€” safe to run
-- multiple times (e.g. on a reset + re-apply workflow).
-- =============================================================================

INSERT INTO storage.buckets (id, name, public)
  VALUES ('claim-attachments', 'claim-attachments', false)
  ON CONFLICT (id) DO NOTHING;

-- =============================================================================
-- SECTION 6: RLS for storage.objects in the claim-attachments bucket
--
-- Bucket is private. All reads and writes go through the service-role client
-- (backend only). No anon or authenticated-role access is granted here.
--
-- Future UI work (signed URL generation) is handled at the application layer
-- via supabase.storage.from('claim-attachments').createSignedUrl(...) with the
-- service-role client â€” it does not need a permissive RLS policy here.
--
-- The SELECT policy for service-role-only is implicit (service role bypasses
-- RLS). We add an explicit DENY for authenticated users to be fail-closed,
-- ensuring that even if a service-role key leaks to client code the bucket
-- contents are not accessible via the anon/authenticated Supabase client.
--
-- Note: storage.objects RLS is separate from public.claim_attachments RLS.
-- Metadata (storage_path, content_hash) lives in claim_attachments (tenant-
-- scoped via RLS above). The actual file bytes live in storage.objects below.
-- =============================================================================

-- Authenticated users cannot directly access objects in this bucket.
-- (Service-role bypasses RLS; upload and signed-URL generation are server-only.)
CREATE POLICY "claim_attachments_bucket_service_only_select"
  ON storage.objects
  FOR SELECT
  USING (
    bucket_id = 'claim-attachments'
    AND false  -- deny all authenticated/anon access; service-role bypasses this
  );

CREATE POLICY "claim_attachments_bucket_service_only_insert"
  ON storage.objects
  FOR INSERT
  WITH CHECK (
    bucket_id = 'claim-attachments'
    AND false  -- deny all authenticated/anon access; service-role bypasses this
  );

-- =============================================================================
-- END: supabase\migrations\0009_claim_messages.sql
-- =============================================================================


-- =============================================================================
-- BEGIN: supabase\migrations\0010_gmail_poll_state.sql
-- =============================================================================

-- =============================================================================
-- Migration 0010: gmail_poll_state â€” Gmail polling watermark table
-- =============================================================================
--
-- PURPOSE
-- -------
-- Stores the last processed Gmail historyId per configured inbox.
-- One row per Gmail account (MVP: single row with sentinel gmail_account_email).
-- The watermark advances only after all messages in a history batch are
-- successfully processed; per-message errors hold the watermark back so the
-- next cron run retries the failed messages (AC8, AC13).
--
-- SCHEMA DESIGN
-- -------------
-- Keyed by gmail_account_email (UNIQUE index) for forward-compatibility with
-- per-tenant inboxes (phase 2). For MVP, one row:
--   gmail_account_email = <GMAIL_FROM_ADDRESS env var>
--
-- IC4: sentinel tenant pattern â€” the cron runs as service-role (bypasses RLS).
-- No SELECT/INSERT/UPDATE policies for authenticated/anon roles are added here.
--
-- ONLINE SAFETY
-- -------------
-- CREATE TABLE IF NOT EXISTS â€” additive only, safe on live traffic.
-- CREATE UNIQUE INDEX IF NOT EXISTS â€” does not use CONCURRENTLY because this
-- is a new table with no live traffic at migration time.
-- ALTER TABLE ENABLE ROW LEVEL SECURITY â€” metadata-only, safe.
--
-- ROLLBACK PLAN (manual â€” no down migration in this codebase)
-- -----------------------------------------------------------
--   DROP TABLE IF EXISTS public.gmail_poll_state;
--   DROP INDEX IF EXISTS idx_gmail_poll_state_account;
-- (The index is owned by the table; DROP TABLE CASCADE drops it automatically.
--  The explicit DROP INDEX is listed for clarity in a partial rollback scenario.)
-- =============================================================================

-- =============================================================================
-- SECTION 1: gmail_poll_state table
-- =============================================================================

CREATE TABLE IF NOT EXISTS public.gmail_poll_state (
  -- Primary key
  id                   uuid        PRIMARY KEY DEFAULT gen_random_uuid(),

  -- The Gmail address being polled.
  -- PII-adjacent â€” treat as sensitive; do not log.
  gmail_account_email  text        NOT NULL,

  -- Last Gmail API historyId successfully processed.
  -- Incremented after all messages in that history batch succeed.
  -- Default '1' allows users.history.list to start from the beginning;
  -- in practice the poller will call users.getProfile() to seed a real
  -- historyId on the first run before advancing.
  -- Non-PII â€” safe to log as an opaque string (no message content).
  history_id           text        NOT NULL DEFAULT '1',

  -- Timestamp of the last successful or attempted poll.
  last_polled_at       timestamptz,

  -- Last error message (non-fatal â€” watermark NOT advanced on error).
  -- Capped at 500 chars to prevent PII leakage from accidental error strings.
  last_error           text,

  -- Standard timestamps
  created_at           timestamptz NOT NULL DEFAULT now(),
  updated_at           timestamptz NOT NULL DEFAULT now()
);

-- =============================================================================
-- SECTION 2: Indexes
-- =============================================================================

-- Unique per Gmail account email â€” one watermark row per inbox.
-- Forward-compatible with multi-tenant (per-account) rows in phase 2.
CREATE UNIQUE INDEX IF NOT EXISTS idx_gmail_poll_state_account
  ON public.gmail_poll_state (gmail_account_email);

-- =============================================================================
-- SECTION 3: RLS
--
-- RLS is ENABLED. No policies for authenticated/anon roles are added:
-- the cron route uses the service-role Supabase client which bypasses RLS by
-- PostgreSQL convention (superuser-equivalent). This table is a system table â€”
-- it is never exposed to the UI or tenant-scoped queries.
--
-- Service role has full SELECT/INSERT/UPDATE/DELETE access by convention.
-- =============================================================================

ALTER TABLE public.gmail_poll_state ENABLE ROW LEVEL SECURITY;

-- No SELECT/INSERT/UPDATE/DELETE policies for authenticated/anon roles.
-- Service-role bypasses RLS â€” full access without explicit policy.

-- =============================================================================
-- SECTION 4: Column comments
-- =============================================================================

COMMENT ON COLUMN public.gmail_poll_state.history_id IS
  'Last Gmail API historyId successfully processed. Incremented after all messages in that history batch succeed. Non-PII.';

COMMENT ON COLUMN public.gmail_poll_state.gmail_account_email IS
  'The Gmail address being polled. PII-adjacent â€” treat as sensitive.';

COMMENT ON COLUMN public.gmail_poll_state.last_error IS
  'Last non-fatal error string (capped at 500 chars). Watermark is NOT advanced when this is set.';

-- =============================================================================
-- END: supabase\migrations\0010_gmail_poll_state.sql
-- =============================================================================


-- =============================================================================
-- BEGIN: supabase\migrations\0011_gmail_watch_state.sql
-- =============================================================================

-- =============================================================================
-- Migration 0011: gmail_watch_state â€” Gmail watch subscription columns
-- =============================================================================
--
-- PURPOSE
-- -------
-- Extends gmail_poll_state with two columns to track the active Gmail push
-- notification subscription registered via users.watch():
--
--   watch_expiration   â€” ISO-8601 / timestamptz when the watch expires (7 days max).
--                        Used by the cron route to decide whether to renew.
--   watch_history_id   â€” historyId returned by users.watch(); used as the starting
--                        point for history.list when the first Pub/Sub push arrives.
--
-- DESIGN
-- ------
-- Both columns are NULLABLE so that:
--   - Existing rows (before watch is first registered) remain valid (AC17).
--   - The cron route can distinguish "watch never registered" from "watch expired".
--   - Application code returns null from getWatchExpiration() until a watch is set
--     (AC2 / AC3), avoiding false-positive renewal decisions.
--
-- No RLS changes needed â€” this table is service-role only (set in migration 0010).
-- The service-role client bypasses RLS by PostgreSQL convention.
--
-- ONLINE SAFETY
-- -------------
-- ADD COLUMN IF NOT EXISTS â€” additive only; existing rows gain NULL values.
-- Safe on live traffic with no table lock beyond metadata update (in Postgres 11+).
--
-- ROLLBACK PLAN (manual â€” no down migration in this codebase)
-- -----------------------------------------------------------
--   ALTER TABLE public.gmail_poll_state DROP COLUMN IF EXISTS watch_expiration;
--   ALTER TABLE public.gmail_poll_state DROP COLUMN IF EXISTS watch_history_id;
-- =============================================================================

-- =============================================================================
-- SECTION 1: Add watch subscription columns
-- =============================================================================

ALTER TABLE public.gmail_poll_state
  ADD COLUMN IF NOT EXISTS watch_expiration  timestamptz  NULL,
  ADD COLUMN IF NOT EXISTS watch_history_id  text         NULL;

-- =============================================================================
-- SECTION 2: Column comments
-- =============================================================================

COMMENT ON COLUMN public.gmail_poll_state.watch_expiration IS
  'Timestamp when the active Gmail watch subscription expires (returned by users.watch() as ms epoch, converted to timestamptz). NULL means no active watch. Non-PII.';

COMMENT ON COLUMN public.gmail_poll_state.watch_history_id IS
  'historyId returned by users.watch() at subscription time. Used as starting watermark for the first Pub/Sub-triggered history.list call. NULL means no active watch. Non-PII.';

-- =============================================================================
-- END: supabase\migrations\0011_gmail_watch_state.sql
-- =============================================================================


-- =============================================================================
-- Multi Gmail intake accounts
-- =============================================================================

CREATE TABLE IF NOT EXISTS public.gmail_accounts (
  id                      uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id               uuid NOT NULL REFERENCES public.tenants(id) ON DELETE CASCADE,
  email                   text NOT NULL,
  refresh_token_encrypted text NOT NULL,
  enabled                 boolean NOT NULL DEFAULT true,
  connected_by            uuid REFERENCES public.users(id) ON DELETE SET NULL,
  last_connected_at       timestamptz,
  last_error              text,
  created_at              timestamptz NOT NULL DEFAULT now(),
  updated_at              timestamptz
);

DROP TRIGGER IF EXISTS trg_gmail_accounts_updated_at ON public.gmail_accounts;

CREATE TRIGGER trg_gmail_accounts_updated_at
  BEFORE UPDATE ON public.gmail_accounts
  FOR EACH ROW EXECUTE FUNCTION public.set_updated_at();

CREATE UNIQUE INDEX IF NOT EXISTS idx_gmail_accounts_tenant_email
  ON public.gmail_accounts(tenant_id, email);

CREATE INDEX IF NOT EXISTS idx_gmail_accounts_enabled
  ON public.gmail_accounts(enabled)
  WHERE enabled = true;

ALTER TABLE public.gmail_accounts ENABLE ROW LEVEL SECURITY;

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1
    FROM pg_policies
    WHERE schemaname = 'public'
      AND tablename = 'gmail_accounts'
      AND policyname = 'gmail_accounts_tenant_all'
  ) THEN
    CREATE POLICY "gmail_accounts_tenant_all"
      ON public.gmail_accounts
      FOR ALL
      USING (tenant_id = public.current_tenant_id())
      WITH CHECK (tenant_id = public.current_tenant_id());
  END IF;
END $$;


-- =============================================================================
-- BEGIN: supabase\migrations\0012_cases_claim_type_nullable.sql
-- =============================================================================

-- =============================================================================
-- Migration 0012: Make cases.claim_type nullable + add 'other' to CHECK
-- =============================================================================
-- W1 (PR #25 NB3) changed the gmail-poller to insert claim_type=NULL for
-- pre-classification cases (AI classifies later via the extraction worker).
-- The column was NOT NULL with no 'other' value, causing 23502 errors.
--
-- 1. DROP NOT NULL so newly-ingested email cases can start unclassified.
-- 2. Recreate the CHECK constraint to allow NULL and the new 'other' value
--    (added to the TypeScript ClaimType enum in the same PR).
-- =============================================================================

ALTER TABLE public.cases
  ALTER COLUMN claim_type DROP NOT NULL;

ALTER TABLE public.cases
  DROP CONSTRAINT IF EXISTS cases_claim_type_check;

ALTER TABLE public.cases
  ADD CONSTRAINT cases_claim_type_check
    CHECK (
      claim_type IS NULL
      OR claim_type IN ('choque', 'robo', 'granizo', 'incendio', 'other')
    );

-- =============================================================================
-- END: supabase\migrations\0012_cases_claim_type_nullable.sql
-- =============================================================================


-- =============================================================================
-- BEGIN: supabase\migrations\0013_agent_training.sql
-- =============================================================================

-- =============================================================================
-- Migration 0013: tenant-level mutable agent training instructions
-- =============================================================================
-- Stores operator-authored guidance/examples for the email intake agent.
-- The extraction worker injects enabled rows into the OpenAI prompt, so changes
-- made in the app affect future production extractions without code deploys.

CREATE TABLE IF NOT EXISTS public.agent_training (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id   uuid NOT NULL REFERENCES public.tenants(id) ON DELETE CASCADE,
  created_at  timestamptz NOT NULL DEFAULT now(),
  updated_at  timestamptz,
  title       text NOT NULL DEFAULT 'Email intake agent training',
  content     text NOT NULL DEFAULT '',
  enabled     boolean NOT NULL DEFAULT true,
  updated_by  uuid REFERENCES public.users(id) ON DELETE SET NULL
);

DROP TRIGGER IF EXISTS trg_agent_training_updated_at ON public.agent_training;

CREATE TRIGGER trg_agent_training_updated_at
  BEFORE UPDATE ON public.agent_training
  FOR EACH ROW EXECUTE FUNCTION public.set_updated_at();

CREATE UNIQUE INDEX IF NOT EXISTS idx_agent_training_tenant_title
  ON public.agent_training(tenant_id, title);

CREATE INDEX IF NOT EXISTS idx_agent_training_tenant_enabled
  ON public.agent_training(tenant_id, enabled)
  WHERE enabled = true;

ALTER TABLE public.agent_training ENABLE ROW LEVEL SECURITY;

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1
    FROM pg_policies
    WHERE schemaname = 'public'
      AND tablename = 'agent_training'
      AND policyname = 'agent_training_tenant_all'
  ) THEN
    CREATE POLICY "agent_training_tenant_all"
      ON public.agent_training
      FOR ALL
      USING (tenant_id = public.current_tenant_id())
      WITH CHECK (tenant_id = public.current_tenant_id());
  END IF;
END $$;

-- =============================================================================
-- END: supabase\migrations\0013_agent_training.sql
-- =============================================================================


-- =============================================================================
-- BEGIN: supabase\seed.sql
-- =============================================================================

-- =============================================================================
-- ClaimMix â€” Development seed data
-- =============================================================================
-- Run with: supabase db reset --local (resets + runs migrations + this seed)
-- Or manually: psql <connection> -f supabase/seed.sql
--
-- HUMAN STEP REQUIRED for auth.users:
--   Supabase does not allow inserting into auth.users via SQL from the client.
--   Use the Supabase Auth Admin API or the dashboard to create users, then
--   run supabase/seed-auth.sql (below) to link them to public.users.
--
--   For local dev with `supabase start`, you CAN insert directly into auth.users.
--   This seed file includes those inserts for local dev only.
-- =============================================================================

-- Guard: only run this seed in local/dev environments.
-- In production, apply migrations via `supabase db push` and create users manually.

-- =============================================================================
-- 1. Tenant
-- =============================================================================
INSERT INTO public.tenants (id, name, created_at)
VALUES (
  '10000000-0000-0000-0000-000000000001',
  'Seguros del Sur S.A.',
  now() - INTERVAL '30 days'
)
ON CONFLICT (id) DO NOTHING;

-- =============================================================================
-- 2. Auth users (local dev only â€” insert into auth schema)
-- =============================================================================
-- Analyst 1: LucÃ­a Ramallo (analyst)
INSERT INTO auth.users (
  id, email, encrypted_password, email_confirmed_at,
  created_at, updated_at,
  raw_app_meta_data, raw_user_meta_data
)
VALUES (
  '20000000-0000-0000-0000-000000000001',
  'lucia@seguros-del-sur.com.ar',
  crypt('Analyst123!', gen_salt('bf', 12)),
  now(),
  now() - INTERVAL '20 days',
  now() - INTERVAL '20 days',
  '{"provider":"email","providers":["email"]}',
  '{"full_name":"LucÃ­a Ramallo"}'
)
ON CONFLICT (id) DO NOTHING;

-- Analyst 2: Carlos Medina (admin)
INSERT INTO auth.users (
  id, email, encrypted_password, email_confirmed_at,
  created_at, updated_at,
  raw_app_meta_data, raw_user_meta_data
)
VALUES (
  '20000000-0000-0000-0000-000000000002',
  'carlos@seguros-del-sur.com.ar',
  crypt('Admin456!', gen_salt('bf', 12)),
  now(),
  now() - INTERVAL '25 days',
  now() - INTERVAL '25 days',
  '{"provider":"email","providers":["email"]}',
  '{"full_name":"Carlos Medina"}'
)
ON CONFLICT (id) DO NOTHING;

-- =============================================================================
-- 3. Public users (link auth.users to tenants)
-- =============================================================================
INSERT INTO public.users (id, tenant_id, full_name, role, created_at)
VALUES
  (
    '20000000-0000-0000-0000-000000000001',
    '10000000-0000-0000-0000-000000000001',
    'LucÃ­a Ramallo',
    'analyst',
    now() - INTERVAL '20 days'
  ),
  (
    '20000000-0000-0000-0000-000000000002',
    '10000000-0000-0000-0000-000000000001',
    'Carlos Medina',
    'admin',
    now() - INTERVAL '25 days'
  )
ON CONFLICT (id) DO NOTHING;

-- =============================================================================
-- 4. Cases â€” 20 realistic Argentine insurance scenarios
--    Mix: 5 choque, 5 robo, 5 granizo, 5 incendio
--    Statuses: 4 procesando, 4 listo, 4 esperando, 4 escalado, 4 cerrado
-- =============================================================================

INSERT INTO public.cases (
  id, tenant_id, policy_number, policyholder_name, claim_type,
  status, confidence_min, assigned_to, channel, created_at, updated_at, closed_at
) VALUES

-- CHOQUE 1 â€” listo, assigned to LucÃ­a
(
  '30000000-0000-0000-0000-000000000001',
  '10000000-0000-0000-0000-000000000001',
  'POL-2024-001',
  'Juan GarcÃ­a',
  'choque', 'listo', 0.89,
  '20000000-0000-0000-0000-000000000001',
  'email_sim',
  now() - INTERVAL '7 days',
  now() - INTERVAL '6 days 23 hours',
  NULL
),

-- CHOQUE 2 â€” procesando, unassigned
(
  '30000000-0000-0000-0000-000000000002',
  '10000000-0000-0000-0000-000000000001',
  'POL-2024-002',
  'MarÃ­a LÃ³pez',
  'choque', 'procesando', NULL,
  NULL,
  'email_sim',
  now() - INTERVAL '1 hour',
  NULL,
  NULL
),

-- CHOQUE 3 â€” escalado (low confidence), assigned to Carlos
(
  '30000000-0000-0000-0000-000000000003',
  '10000000-0000-0000-0000-000000000001',
  'POL-2024-003',
  'Roberto FernÃ¡ndez',
  'choque', 'escalado', 0.52,
  '20000000-0000-0000-0000-000000000002',
  'email_sim',
  now() - INTERVAL '5 days',
  now() - INTERVAL '4 days 20 hours',
  NULL
),

-- CHOQUE 4 â€” cerrado
(
  '30000000-0000-0000-0000-000000000004',
  '10000000-0000-0000-0000-000000000001',
  'POL-2024-004',
  'Marta SÃ¡nchez',
  'choque', 'cerrado', 0.91,
  '20000000-0000-0000-0000-000000000001',
  'email_sim',
  now() - INTERVAL '8 days',
  now() - INTERVAL '3 days',
  now() - INTERVAL '3 days'
),

-- CHOQUE 5 â€” esperando (parte_amistoso faltante)
(
  '30000000-0000-0000-0000-000000000005',
  '10000000-0000-0000-0000-000000000001',
  'POL-2024-005',
  'AndrÃ©s Romero',
  'choque', 'esperando', 0.74,
  '20000000-0000-0000-0000-000000000001',
  'email_sim',
  now() - INTERVAL '4 days',
  now() - INTERVAL '3 days 22 hours',
  NULL
),

-- ROBO 1 â€” listo, high confidence
(
  '30000000-0000-0000-0000-000000000006',
  '10000000-0000-0000-0000-000000000001',
  'POL-2024-006',
  'Silvina Torres',
  'robo', 'listo', 0.93,
  '20000000-0000-0000-0000-000000000002',
  'email_sim',
  now() - INTERVAL '6 days',
  now() - INTERVAL '5 days 23 hours',
  NULL
),

-- ROBO 2 â€” procesando
(
  '30000000-0000-0000-0000-000000000007',
  '10000000-0000-0000-0000-000000000001',
  'POL-2024-007',
  'Pablo MartÃ­nez',
  'robo', 'procesando', NULL,
  NULL,
  'email_sim',
  now() - INTERVAL '2 hours',
  NULL,
  NULL
),

-- ROBO 3 â€” esperando (denuncia_policial faltante)
(
  '30000000-0000-0000-0000-000000000008',
  '10000000-0000-0000-0000-000000000001',
  'POL-2024-008',
  'Ana GonzÃ¡lez',
  'robo', 'esperando', 0.77,
  '20000000-0000-0000-0000-000000000001',
  'email_sim',
  now() - INTERVAL '3 days',
  now() - INTERVAL '2 days 18 hours',
  NULL
),

-- ROBO 4 â€” escalado
(
  '30000000-0000-0000-0000-000000000009',
  '10000000-0000-0000-0000-000000000001',
  'POL-2024-009',
  'Diego Herrera',
  'robo', 'escalado', 0.42,
  '20000000-0000-0000-0000-000000000002',
  'email_sim',
  now() - INTERVAL '4 days',
  now() - INTERVAL '3 days 15 hours',
  NULL
),

-- ROBO 5 â€” cerrado
(
  '30000000-0000-0000-0000-000000000010',
  '10000000-0000-0000-0000-000000000001',
  'POL-2024-010',
  'Laura DÃ­az',
  'robo', 'cerrado', 0.85,
  '20000000-0000-0000-0000-000000000001',
  'email_sim',
  now() - INTERVAL '7 days',
  now() - INTERVAL '2 days',
  now() - INTERVAL '2 days'
),

-- GRANIZO 1 â€” procesando
(
  '30000000-0000-0000-0000-000000000011',
  '10000000-0000-0000-0000-000000000001',
  'POL-2024-011',
  'Eduardo MuÃ±oz',
  'granizo', 'procesando', NULL,
  NULL,
  'email_sim',
  now() - INTERVAL '3 hours',
  NULL,
  NULL
),

-- GRANIZO 2 â€” listo
(
  '30000000-0000-0000-0000-000000000012',
  '10000000-0000-0000-0000-000000000001',
  'POL-2024-012',
  'Natalia PÃ©rez',
  'granizo', 'listo', 0.97,
  '20000000-0000-0000-0000-000000000002',
  'email_sim',
  now() - INTERVAL '5 days',
  now() - INTERVAL '4 days 22 hours',
  NULL
),

-- GRANIZO 3 â€” esperando (foto_oblea_vtv faltante)
(
  '30000000-0000-0000-0000-000000000013',
  '10000000-0000-0000-0000-000000000001',
  'POL-2024-013',
  'HernÃ¡n Castro',
  'granizo', 'esperando', 0.71,
  '20000000-0000-0000-0000-000000000001',
  'email_sim',
  now() - INTERVAL '2 days',
  now() - INTERVAL '1 day 20 hours',
  NULL
),

-- GRANIZO 4 â€” escalado
(
  '30000000-0000-0000-0000-000000000014',
  '10000000-0000-0000-0000-000000000001',
  'POL-2024-014',
  'VerÃ³nica Silva',
  'granizo', 'escalado', 0.48,
  '20000000-0000-0000-0000-000000000002',
  'email_sim',
  now() - INTERVAL '3 days',
  now() - INTERVAL '2 days 12 hours',
  NULL
),

-- GRANIZO 5 â€” cerrado
(
  '30000000-0000-0000-0000-000000000015',
  '10000000-0000-0000-0000-000000000001',
  'POL-2024-015',
  'Marcelo Acosta',
  'granizo', 'cerrado', 0.88,
  '20000000-0000-0000-0000-000000000001',
  'email_sim',
  now() - INTERVAL '8 days',
  now() - INTERVAL '4 days',
  now() - INTERVAL '4 days'
),

-- INCENDIO 1 â€” procesando
(
  '30000000-0000-0000-0000-000000000016',
  '10000000-0000-0000-0000-000000000001',
  'POL-2024-016',
  'Graciela RÃ­os',
  'incendio', 'procesando', NULL,
  NULL,
  'email_sim',
  now() - INTERVAL '30 minutes',
  NULL,
  NULL
),

-- INCENDIO 2 â€” listo
(
  '30000000-0000-0000-0000-000000000017',
  '10000000-0000-0000-0000-000000000001',
  'POL-2024-017',
  'Fernando Blanco',
  'incendio', 'listo', 0.82,
  '20000000-0000-0000-0000-000000000002',
  'email_sim',
  now() - INTERVAL '6 days',
  now() - INTERVAL '5 days 20 hours',
  NULL
),

-- INCENDIO 3 â€” esperando (informe_bomberos faltante)
(
  '30000000-0000-0000-0000-000000000018',
  '10000000-0000-0000-0000-000000000001',
  'POL-2024-018',
  'Claudia Morales',
  'incendio', 'esperando', 0.73,
  '20000000-0000-0000-0000-000000000001',
  'email_sim',
  now() - INTERVAL '3 days',
  now() - INTERVAL '2 days 15 hours',
  NULL
),

-- INCENDIO 4 â€” escalado
(
  '30000000-0000-0000-0000-000000000019',
  '10000000-0000-0000-0000-000000000001',
  'POL-2024-019',
  'Gustavo Vega',
  'incendio', 'escalado', 0.61,
  '20000000-0000-0000-0000-000000000002',
  'email_sim',
  now() - INTERVAL '4 days',
  now() - INTERVAL '3 days 18 hours',
  NULL
),

-- INCENDIO 5 â€” cerrado
(
  '30000000-0000-0000-0000-000000000020',
  '10000000-0000-0000-0000-000000000001',
  'POL-2024-020',
  'Patricia Leiva',
  'incendio', 'cerrado', 0.95,
  '20000000-0000-0000-0000-000000000001',
  'email_sim',
  now() - INTERVAL '7 days',
  now() - INTERVAL '1 day',
  now() - INTERVAL '1 day'
)

ON CONFLICT (id) DO NOTHING;

-- =============================================================================
-- 5. Raw messages â€” realistic es-AR claim narratives
-- =============================================================================
INSERT INTO public.raw_messages (id, case_id, tenant_id, channel, from_addr, subject, body, received_at)
VALUES

-- CHOQUE 1
(
  '40000000-0000-0000-0000-000000000001',
  '30000000-0000-0000-0000-000000000001',
  '10000000-0000-0000-0000-000000000001',
  'email_sim',
  'juan.garcia@gmail.com',
  'Denuncia de siniestro - Choque - PÃ³liza POL-2024-001',
  'Estimados seÃ±ores,
Me dirijo a ustedes para informar el siniestro ocurrido el dÃ­a 25 de mayo de 2024
a las 14:30 hs en la intersecciÃ³n de Av. Corrientes 3400 y Av. Medrano, Ciudad
AutÃ³noma de Buenos Aires.

Mi vehÃ­culo (Toyota Corolla 2022, patente ABC 123) fue impactado por un Fiat
Cronos 2021 (patente XYZ 789) conducido por el Sr. HÃ©ctor SuÃ¡rez (DNI 28.456.123)
quien circulaba por Medrano sin respetar la seÃ±al de PARE.

Los daÃ±os en mi vehÃ­culo incluyen: paragolpe delantero destruido, capot abollado y
faro izquierdo roto. El otro vehÃ­culo sufriÃ³ daÃ±os en su paragolpe trasero.

Adjunto el parte de accidente amistoso firmado por ambas partes y las fotografÃ­as
de los daÃ±os. Mi licencia de conducir nÃºmero 12.345.678 tiene vigencia hasta
diciembre de 2025.

Quedo a disposiciÃ³n para cualquier consulta.
Juan GarcÃ­a
DNI 32.567.890',
  now() - INTERVAL '7 days'
),

-- CHOQUE 2 (procesando â€” mensaje recibido hace 1 hora)
(
  '40000000-0000-0000-0000-000000000002',
  '30000000-0000-0000-0000-000000000002',
  '10000000-0000-0000-0000-000000000001',
  'email_sim',
  'mlopez@hotmail.com',
  'Siniestro auto - colisiÃ³n - MarÃ­a LÃ³pez',
  'Buenos dÃ­as,
Ayer a las 19:15 hs tuve un accidente en la Ruta Nacional 9, km 47, en la localidad
de ZÃ¡rate, Provincia de Buenos Aires. Mi Ford Focus 2020 (patente QRS 456) fue
golpeado por detrÃ¡s por un camiÃ³n de carga que no mantuvo distancia de seguridad.

El conductor del camiÃ³n se retirÃ³ del lugar antes de que pudiera tomar sus datos
completos. Solo tengo la patente del camiÃ³n: TUV 012. LlamÃ© al 911 y levantaron
el acta. El nÃºmero de acta policial es 2024-44567-ZAR.

Los daÃ±os son severos: toda la parte trasera del vehÃ­culo deformada, luneta rota,
y el baÃºl no cierra. El auto fue remolcado al taller mecÃ¡nico "El TucÃ¡n" en ZÃ¡rate.

Necesito orientaciÃ³n sobre los prÃ³ximos pasos.
MarÃ­a LÃ³pez
DNI 29.876.543',
  now() - INTERVAL '1 hour'
),

-- CHOQUE 3 (escalado â€” informaciÃ³n incompleta/confusa)
(
  '40000000-0000-0000-0000-000000000003',
  '30000000-0000-0000-0000-000000000003',
  '10000000-0000-0000-0000-000000000001',
  'email_sim',
  'rfernandez@yahoo.com.ar',
  'accidente',
  'hola tube un choque no se bien donde fue creo que fue en palermo o en recoleta
el otro auto se fue. mi auto es un auto rojo. no tengo los papeles acÃ¡. porfavor
ayudenme. fue ayer o anteayer no recuerdo bien. los daÃ±os son varios.
roberto',
  now() - INTERVAL '5 days'
),

-- CHOQUE 5 (esperando â€” falta parte amistoso)
(
  '40000000-0000-0000-0000-000000000005',
  '30000000-0000-0000-0000-000000000005',
  '10000000-0000-0000-0000-000000000001',
  'email_sim',
  'aromero@gmail.com',
  'Siniestro choque - PÃ³liza POL-2024-005',
  'Buenas tardes,
Informo siniestro ocurrido el 28/05/2024 a las 08:45 en la esquina de Rivadavia y
Nazca, CABA. Mi Chevrolet Onix 2023 (patente LMN 234) recibiÃ³ un impacto lateral
de un Honda Civic 2019 (patente OPQ 567) que saltÃ³ un semÃ¡foro en rojo.

El conductor del otro vehÃ­culo, Sr. MatÃ­as GÃ³mez, manifestÃ³ no tener el parte
amistoso consigo. Quedamos en que me lo enviarÃ­a por correo electrÃ³nico pero aÃºn
no lo recibÃ­. SÃ­ cuento con fotografÃ­as de los daÃ±os y mi licencia de conducir.

DaÃ±os en mi vehÃ­culo: puerta trasera derecha abollada, espejo retrovisor roto.

Â¿Pueden iniciar el trÃ¡mite sin el parte amistoso y agregar luego?

AndrÃ©s Romero
DNI 31.234.567',
  now() - INTERVAL '4 days'
),

-- ROBO 1
(
  '40000000-0000-0000-0000-000000000006',
  '30000000-0000-0000-0000-000000000006',
  '10000000-0000-0000-0000-000000000001',
  'email_sim',
  'storres@gmail.com',
  'Robo de vehÃ­culo - Denuncia - PÃ³liza POL-2024-006',
  'Estimados,
Con mucho pesar les comunico el robo de mi vehÃ­culo Volkswagen Polo 2021 (patente
RST 890) ocurrido en la noche del 26 al 27 de mayo de 2024.

El vehÃ­culo estaba estacionado en la calle Scalabrini Ortiz 2100, Palermo, CABA.
Al salir de mi domicilio a las 07:30 del dÃ­a 27/05 notÃ© la ausencia del mismo.
Inmediatamente realicÃ© la denuncia en la ComisarÃ­a 20 de CABA, nÃºmero de denuncia:
2024-20-001234.

Adjunto copia escaneada de la denuncia policial y fotografÃ­as del lugar donde
estaba estacionado el vehÃ­culo. El valor de mercado actual del automÃ³vil es de
aproximadamente $18.500.000 pesos.

Silvina Torres
DNI 27.890.123
Tel: 011-4567-8901',
  now() - INTERVAL '6 days'
),

-- ROBO 3 (esperando â€” falta denuncia policial)
(
  '40000000-0000-0000-0000-000000000008',
  '30000000-0000-0000-0000-000000000008',
  '10000000-0000-0000-0000-000000000001',
  'email_sim',
  'agonzalez@outlook.com',
  'Robo parcial de vehÃ­culo - PÃ³liza POL-2024-008',
  'Hola,
Me robaron las ruedas y la baterÃ­a de mi Renault Sandero 2020 (patente GHI 345)
que estaba en el garage del consorcio de Corrientes 5500, piso 1, CABA.
El hecho ocurriÃ³ entre el sÃ¡bado 25 y el domingo 26 de mayo de 2024.

TomÃ© conocimiento el domingo a las 12:00 cuando fui a buscar el auto. TodavÃ­a
no pude ir a hacer la denuncia policial porque el lunes fue feriado y el martes
trabajÃ© hasta tarde. Voy a ir esta semana.

Las fotografÃ­as del auto sin ruedas las adjunto.

Ana GonzÃ¡lez
DNI 33.456.789',
  now() - INTERVAL '3 days'
),

-- GRANIZO 2
(
  '40000000-0000-0000-0000-000000000012',
  '30000000-0000-0000-0000-000000000012',
  '10000000-0000-0000-0000-000000000001',
  'email_sim',
  'nperez@hotmail.com',
  'DaÃ±os por granizo - PÃ³liza POL-2024-012',
  'Estimados seÃ±ores,
El dÃ­a 24 de mayo de 2024 se registrÃ³ una tormenta de granizo en la ciudad de
Rosario, Provincia de Santa Fe, que causÃ³ graves daÃ±os en mi vehÃ­culo Peugeot
208 2022 (patente JKL 678) que se encontraba en la vÃ­a pÃºblica frente a mi
domicilio en Bv. OroÃ±o 1200.

Los daÃ±os son extensos: capot con mÃºltiples abolladuras, techo deformado, parabrisas
con una fisura, y espejo retrovisor izquierdo partido.

Adjunto a este correo:
1. FotografÃ­as de todos los daÃ±os
2. FotografÃ­a de la oblea VTV vigente (vence en octubre 2024)

Quedo a la espera de instrucciones para el peritaje.
Natalia PÃ©rez
DNI 30.123.456',
  now() - INTERVAL '5 days'
),

-- GRANIZO 3 (esperando â€” falta foto_oblea_vtv)
(
  '40000000-0000-0000-0000-000000000013',
  '30000000-0000-0000-0000-000000000013',
  '10000000-0000-0000-0000-000000000001',
  'email_sim',
  'hcastro@gmail.com',
  'Siniestro granizo CÃ³rdoba - PÃ³liza POL-2024-013',
  'Buenos dÃ­as,
Me comunico para reportar los daÃ±os sufridos por mi Honda City 2021 (patente MNO 901)
durante la granizada del 27 de mayo en CÃ³rdoba Capital, barrio Cerro de las Rosas.

El vehÃ­culo quedÃ³ muy golpeado: capot, techo y aletas deformadas por el granizo.
El parabrisas tiene varias fisuras. Adjunto fotos de los daÃ±os.

HernÃ¡n Castro
DNI 28.901.234
Tel: 0351-456-7890',
  now() - INTERVAL '2 days'
),

-- INCENDIO 2
(
  '40000000-0000-0000-0000-000000000017',
  '30000000-0000-0000-0000-000000000017',
  '10000000-0000-0000-0000-000000000001',
  'email_sim',
  'fblanco@gmail.com',
  'Incendio de vehÃ­culo - PÃ³liza POL-2024-017',
  'Estimados,
El dÃ­a 26 de mayo de 2024 a las 23:15 hs se incendiÃ³ mi Toyota Hilux 2020 (patente
PQR 234) mientras circulaba por la autopista Panamericana a la altura del km 25,
sentido norte, en la localidad de Del Viso, Buenos Aires.

El vehÃ­culo comenzÃ³ a humear repentinamente y detuve la marcha en la banquina.
En cuestiÃ³n de minutos las llamas consumieron el motor y se extendieron hacia el
habitÃ¡culo. Los bomberos de Pilar acudieron al lugar (Cuartel 01 de Pilar,
nÃºmero de intervenciÃ³n: 2024-PI-0892).

El vehÃ­culo quedÃ³ completamente destruido. La denuncia policial fue realizada en
la DelegaciÃ³n Comunal del Parque Industrial de Pilar, acta NÂ° 2024-78923.

Adjunto: informe de bomberos, denuncia policial, fotografÃ­as del vehÃ­culo calcinado.

Fernando Blanco
DNI 26.345.678',
  now() - INTERVAL '6 days'
),

-- INCENDIO 3 (esperando â€” falta informe_bomberos)
(
  '40000000-0000-0000-0000-000000000018',
  '30000000-0000-0000-0000-000000000018',
  '10000000-0000-0000-0000-000000000001',
  'email_sim',
  'cmorales@yahoo.com.ar',
  'Incendio - consulta - PÃ³liza POL-2024-018',
  'Hola,
Me llamo Claudia Morales y el 28 de mayo se incendiÃ³ mi auto Volkswagen Gol 2019
(patente STU 567) en la cochera de mi edificio en Mendoza 1800, Congreso, CABA.

Fue a las 3 de la maÃ±ana, intervinieron los Bomberos Voluntarios de Villa del Parque.
Ellos me dijeron que el informe oficial puede tardar hasta 15 dÃ­as hÃ¡biles en estar
disponible.

RealicÃ© la denuncia policial en la seccional 7ma (acta 2024-07-004567).

Â¿Puedo iniciar el trÃ¡mite sin el informe de bomberos y agregarlo despuÃ©s cuando
lo tenga?

Claudia Morales
DNI 34.567.890',
  now() - INTERVAL '3 days'
)

ON CONFLICT (id) DO NOTHING;

-- =============================================================================
-- 6. Extracted fields â€” for listo and escalado cases
-- =============================================================================
INSERT INTO public.extracted_fields (
  id, case_id, tenant_id, field_key, field_value, confidence, extracted_at
) VALUES

-- CHOQUE 1 (listo â€” alta confianza)
('50000000-0000-0000-0000-000000000001','30000000-0000-0000-0000-000000000001','10000000-0000-0000-0000-000000000001','date','2024-05-25',0.97,now() - INTERVAL '6 days 23 hours'),
('50000000-0000-0000-0000-000000000002','30000000-0000-0000-0000-000000000001','10000000-0000-0000-0000-000000000001','time','14:30',0.95,now() - INTERVAL '6 days 23 hours'),
('50000000-0000-0000-0000-000000000003','30000000-0000-0000-0000-000000000001','10000000-0000-0000-0000-000000000001','location','Av. Corrientes 3400 y Av. Medrano, CABA',0.93,now() - INTERVAL '6 days 23 hours'),
('50000000-0000-0000-0000-000000000004','30000000-0000-0000-0000-000000000001','10000000-0000-0000-0000-000000000001','party_a_name','Juan GarcÃ­a',0.98,now() - INTERVAL '6 days 23 hours'),
('50000000-0000-0000-0000-000000000005','30000000-0000-0000-0000-000000000001','10000000-0000-0000-0000-000000000001','party_a_plate','ABC 123',0.97,now() - INTERVAL '6 days 23 hours'),
('50000000-0000-0000-0000-000000000006','30000000-0000-0000-0000-000000000001','10000000-0000-0000-0000-000000000001','party_b_name','HÃ©ctor SuÃ¡rez',0.92,now() - INTERVAL '6 days 23 hours'),
('50000000-0000-0000-0000-000000000007','30000000-0000-0000-0000-000000000001','10000000-0000-0000-0000-000000000001','party_b_plate','XYZ 789',0.96,now() - INTERVAL '6 days 23 hours'),
('50000000-0000-0000-0000-000000000008','30000000-0000-0000-0000-000000000001','10000000-0000-0000-0000-000000000001','declared_damage','Paragolpe delantero destruido, capot abollado, faro izquierdo roto',0.89,now() - INTERVAL '6 days 23 hours'),

-- CHOQUE 3 (escalado â€” baja confianza)
('50000000-0000-0000-0000-000000000020','30000000-0000-0000-0000-000000000003','10000000-0000-0000-0000-000000000001','date','desconocida',0.42,now() - INTERVAL '4 days 20 hours'),
('50000000-0000-0000-0000-000000000021','30000000-0000-0000-0000-000000000003','10000000-0000-0000-0000-000000000001','location','Palermo o Recoleta, CABA',0.35,now() - INTERVAL '4 days 20 hours'),
('50000000-0000-0000-0000-000000000022','30000000-0000-0000-0000-000000000003','10000000-0000-0000-0000-000000000001','party_a_name','Roberto FernÃ¡ndez',0.71,now() - INTERVAL '4 days 20 hours'),
('50000000-0000-0000-0000-000000000023','30000000-0000-0000-0000-000000000003','10000000-0000-0000-0000-000000000001','party_a_plate','desconocida',0.52,now() - INTERVAL '4 days 20 hours'),

-- ROBO 1 (listo)
('50000000-0000-0000-0000-000000000030','30000000-0000-0000-0000-000000000006','10000000-0000-0000-0000-000000000001','date','2024-05-27',0.96,now() - INTERVAL '5 days 23 hours'),
('50000000-0000-0000-0000-000000000031','30000000-0000-0000-0000-000000000006','10000000-0000-0000-0000-000000000001','location','Scalabrini Ortiz 2100, Palermo, CABA',0.98,now() - INTERVAL '5 days 23 hours'),
('50000000-0000-0000-0000-000000000032','30000000-0000-0000-0000-000000000006','10000000-0000-0000-0000-000000000001','party_a_plate','RST 890',0.97,now() - INTERVAL '5 days 23 hours'),
('50000000-0000-0000-0000-000000000033','30000000-0000-0000-0000-000000000006','10000000-0000-0000-0000-000000000001','police_report_number','2024-20-001234',0.95,now() - INTERVAL '5 days 23 hours'),
('50000000-0000-0000-0000-000000000034','30000000-0000-0000-0000-000000000006','10000000-0000-0000-0000-000000000001','vehicle_value_ars','18500000',0.88,now() - INTERVAL '5 days 23 hours'),

-- GRANIZO 2 (listo)
('50000000-0000-0000-0000-000000000050','30000000-0000-0000-0000-000000000012','10000000-0000-0000-0000-000000000001','date','2024-05-24',0.98,now() - INTERVAL '4 days 22 hours'),
('50000000-0000-0000-0000-000000000051','30000000-0000-0000-0000-000000000012','10000000-0000-0000-0000-000000000001','location','Bv. OroÃ±o 1200, Rosario, Santa Fe',0.97,now() - INTERVAL '4 days 22 hours'),
('50000000-0000-0000-0000-000000000052','30000000-0000-0000-0000-000000000012','10000000-0000-0000-0000-000000000001','party_a_plate','JKL 678',0.99,now() - INTERVAL '4 days 22 hours'),
('50000000-0000-0000-0000-000000000053','30000000-0000-0000-0000-000000000012','10000000-0000-0000-0000-000000000001','declared_damage','Capot con abolladuras, techo deformado, parabrisas fisurado, espejo partido',0.97,now() - INTERVAL '4 days 22 hours'),
('50000000-0000-0000-0000-000000000054','30000000-0000-0000-0000-000000000012','10000000-0000-0000-0000-000000000001','vtv_expiry','2024-10',0.95,now() - INTERVAL '4 days 22 hours'),

-- INCENDIO 2 (listo)
('50000000-0000-0000-0000-000000000070','30000000-0000-0000-0000-000000000017','10000000-0000-0000-0000-000000000001','date','2024-05-26',0.97,now() - INTERVAL '5 days 20 hours'),
('50000000-0000-0000-0000-000000000071','30000000-0000-0000-0000-000000000017','10000000-0000-0000-0000-000000000001','time','23:15',0.95,now() - INTERVAL '5 days 20 hours'),
('50000000-0000-0000-0000-000000000072','30000000-0000-0000-0000-000000000017','10000000-0000-0000-0000-000000000001','location','Autopista Panamericana km 25, Del Viso, Buenos Aires',0.96,now() - INTERVAL '5 days 20 hours'),
('50000000-0000-0000-0000-000000000073','30000000-0000-0000-0000-000000000017','10000000-0000-0000-0000-000000000001','party_a_plate','PQR 234',0.98,now() - INTERVAL '5 days 20 hours'),
('50000000-0000-0000-0000-000000000074','30000000-0000-0000-0000-000000000017','10000000-0000-0000-0000-000000000001','fire_report_number','2024-PI-0892',0.92,now() - INTERVAL '5 days 20 hours'),
('50000000-0000-0000-0000-000000000075','30000000-0000-0000-0000-000000000017','10000000-0000-0000-0000-000000000001','police_report_number','2024-78923',0.91,now() - INTERVAL '5 days 20 hours'),
('50000000-0000-0000-0000-000000000076','30000000-0000-0000-0000-000000000017','10000000-0000-0000-0000-000000000001','declared_damage','VehÃ­culo completamente destruido por incendio',0.98,now() - INTERVAL '5 days 20 hours')

ON CONFLICT (case_id, field_key) DO NOTHING;

-- =============================================================================
-- 7. Missing docs â€” for cases in 'esperando' status
-- =============================================================================
INSERT INTO public.missing_docs (id, case_id, tenant_id, doc_key, requested_at, satisfied_at)
VALUES

-- CHOQUE 5 esperando â€” falta parte_amistoso
(
  '60000000-0000-0000-0000-000000000001',
  '30000000-0000-0000-0000-000000000005',
  '10000000-0000-0000-0000-000000000001',
  'parte_amistoso',
  now() - INTERVAL '3 days 22 hours',
  NULL
),

-- ROBO 3 esperando â€” falta denuncia_policial
(
  '60000000-0000-0000-0000-000000000002',
  '30000000-0000-0000-0000-000000000008',
  '10000000-0000-0000-0000-000000000001',
  'denuncia_policial',
  now() - INTERVAL '2 days 18 hours',
  NULL
),

-- GRANIZO 3 esperando â€” falta foto_oblea_vtv
(
  '60000000-0000-0000-0000-000000000003',
  '30000000-0000-0000-0000-000000000013',
  '10000000-0000-0000-0000-000000000001',
  'foto_oblea_vtv',
  now() - INTERVAL '1 day 20 hours',
  NULL
),

-- INCENDIO 3 esperando â€” falta informe_bomberos
(
  '60000000-0000-0000-0000-000000000004',
  '30000000-0000-0000-0000-000000000018',
  '10000000-0000-0000-0000-000000000001',
  'informe_bomberos',
  now() - INTERVAL '2 days 15 hours',
  NULL
)

ON CONFLICT (id) DO NOTHING;

-- =============================================================================
-- 8. Audit log entries â€” representative sample
-- =============================================================================
INSERT INTO public.audit_log (
  tenant_id, actor_id, event_type, target_type, target_id, payload, created_at
) VALUES

-- Auth success
(
  '10000000-0000-0000-0000-000000000001',
  '20000000-0000-0000-0000-000000000001',
  'auth.success',
  'user',
  '20000000-0000-0000-0000-000000000001',
  '{"role":"analyst"}',
  now() - INTERVAL '7 days'
),

-- Case created via simulation
(
  '10000000-0000-0000-0000-000000000001',
  '20000000-0000-0000-0000-000000000001',
  'case.created',
  'case',
  '30000000-0000-0000-0000-000000000001',
  '{"claim_type":"choque","channel":"email_sim"}',
  now() - INTERVAL '7 days'
),

-- AI extracted choque 1
(
  '10000000-0000-0000-0000-000000000001',
  NULL,
  'ai.extracted',
  'case',
  '30000000-0000-0000-0000-000000000001',
  '{"model":"gpt-4o-mini","confidence_min":0.89,"status_after":"listo"}',
  now() - INTERVAL '6 days 23 hours'
),

-- Case closed
(
  '10000000-0000-0000-0000-000000000001',
  '20000000-0000-0000-0000-000000000001',
  'case.closed',
  'case',
  '30000000-0000-0000-0000-000000000004',
  '{"reason":"paid_out","status_before":"listo"}',
  now() - INTERVAL '3 days'
),

-- Escalated (low confidence)
(
  '10000000-0000-0000-0000-000000000001',
  NULL,
  'ai.extracted',
  'case',
  '30000000-0000-0000-0000-000000000003',
  '{"reason":"low_confidence","confidence_min":0.52,"low_confidence_fields":["date","location","party_a_plate"]}',
  now() - INTERVAL '4 days 20 hours'
);

-- =============================================================================
-- END: supabase\seed.sql
-- =============================================================================

