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
-- Helper function: current_tenant_id()
-- Returns the tenant_id from the authenticated user's JWT claim.
-- Used by RLS policies to scope queries to the user's tenant.
-- =============================================================================
CREATE OR REPLACE FUNCTION public.current_tenant_id()
RETURNS uuid
LANGUAGE sql
STABLE
SECURITY DEFINER
AS $$
  SELECT id FROM public.users WHERE id = auth.uid()
  RETURNING tenant_id
$$;

-- Simpler and more reliable implementation:
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
-- raw_messages (inbound email/whatsapp bodies — stored verbatim, PII tagged)
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
-- outbound_messages (stub — rows created, no real send in MVP)
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
-- audit_log (immutable audit trail — append-only; no UPDATE/DELETE RLS)
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
-- ai_usage (token budget tracking — immutable)
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
-- required_docs_config (seed/config table — not user data; no RLS needed)
-- =============================================================================
CREATE TABLE IF NOT EXISTS public.required_docs_config (
  claim_type  text NOT NULL,
  doc_key     text NOT NULL,
  label_es    text NOT NULL,
  required    boolean NOT NULL DEFAULT true,
  PRIMARY KEY (claim_type, doc_key)
);
