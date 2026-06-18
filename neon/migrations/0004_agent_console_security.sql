-- =============================================================================
-- ClaimMix - Agent Console, model deployment metadata, and Neon RLS scaffolding
-- =============================================================================

-- Tenant-defined custom fields that the claim agent should extract into fields[].
CREATE TABLE IF NOT EXISTS public.agent_custom_fields (
  id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id       uuid NOT NULL REFERENCES public.tenants(id) ON DELETE CASCADE,
  key             text NOT NULL,
  label           text NOT NULL,
  description     text NOT NULL DEFAULT '',
  field_type      text NOT NULL DEFAULT 'text'
                    CHECK (field_type IN ('text', 'number', 'date', 'boolean', 'enum', 'email', 'phone')),
  claim_type      text
                    CHECK (claim_type IS NULL OR claim_type IN ('choque', 'robo', 'granizo', 'incendio', 'other')),
  required        boolean NOT NULL DEFAULT false,
  ask_if_missing  boolean NOT NULL DEFAULT false,
  enum_values     jsonb NOT NULL DEFAULT '[]'::jsonb,
  active          boolean NOT NULL DEFAULT true,
  created_by      uuid REFERENCES public.users(id) ON DELETE SET NULL,
  created_at      timestamptz NOT NULL DEFAULT now(),
  updated_at      timestamptz,
  CONSTRAINT agent_custom_fields_key_format
    CHECK (key ~ '^[a-z][a-z0-9_]{1,63}$')
);

DROP TRIGGER IF EXISTS trg_agent_custom_fields_updated_at ON public.agent_custom_fields;
CREATE TRIGGER trg_agent_custom_fields_updated_at
  BEFORE UPDATE ON public.agent_custom_fields
  FOR EACH ROW EXECUTE FUNCTION public.set_updated_at();

CREATE UNIQUE INDEX IF NOT EXISTS idx_agent_custom_fields_tenant_key
  ON public.agent_custom_fields(tenant_id, key);

CREATE INDEX IF NOT EXISTS idx_agent_custom_fields_tenant_active
  ON public.agent_custom_fields(tenant_id, active, claim_type)
  WHERE active = true;

-- Fine-tuning lifecycle metadata. The job row is the audit trail for JSONL
-- export, file upload, OpenAI job id, sync state, and manual activation.
ALTER TABLE public.model_training_jobs
  ADD COLUMN IF NOT EXISTS openai_fine_tuning_job_id text,
  ADD COLUMN IF NOT EXISTS training_file_id text,
  ADD COLUMN IF NOT EXISTS validation_file_id text,
  ADD COLUMN IF NOT EXISTS result_files jsonb NOT NULL DEFAULT '[]'::jsonb,
  ADD COLUMN IF NOT EXISTS error_message text,
  ADD COLUMN IF NOT EXISTS training_jsonl text,
  ADD COLUMN IF NOT EXISTS validation_jsonl text,
  ADD COLUMN IF NOT EXISTS started_at timestamptz,
  ADD COLUMN IF NOT EXISTS activated_by uuid REFERENCES public.users(id) ON DELETE SET NULL,
  ADD COLUMN IF NOT EXISTS activated_at timestamptz;

CREATE UNIQUE INDEX IF NOT EXISTS idx_model_training_jobs_openai_job
  ON public.model_training_jobs(openai_fine_tuning_job_id)
  WHERE openai_fine_tuning_job_id IS NOT NULL;

-- Active model deployment settings. provider remains the preferred agent
-- provider; active_model allows a fine-tuned OpenAI model to be selected
-- without changing env vars. previous_model gives one-click rollback.
ALTER TABLE public.tenant_ai_settings
  ADD COLUMN IF NOT EXISTS openai_model text NOT NULL DEFAULT 'gpt-4o-mini',
  ADD COLUMN IF NOT EXISTS gemini_model text NOT NULL DEFAULT 'gemini-2.5-flash',
  ADD COLUMN IF NOT EXISTS active_model_provider text NOT NULL DEFAULT 'openai',
  ADD COLUMN IF NOT EXISTS active_model text,
  ADD COLUMN IF NOT EXISTS previous_model text,
  ADD COLUMN IF NOT EXISTS model_activated_by uuid REFERENCES public.users(id) ON DELETE SET NULL,
  ADD COLUMN IF NOT EXISTS model_activated_at timestamptz;

ALTER TABLE public.tenant_ai_settings
  DROP CONSTRAINT IF EXISTS tenant_ai_settings_active_model_provider_check;

ALTER TABLE public.tenant_ai_settings
  ADD CONSTRAINT tenant_ai_settings_active_model_provider_check
  CHECK (active_model_provider IN ('openai', 'gemini'));

-- Prevent duplicate missing-doc rows now that missing_docs is a live workflow
-- table, not just a legacy gap-analysis artifact.
CREATE UNIQUE INDEX IF NOT EXISTS idx_missing_docs_tenant_case_doc
  ON public.missing_docs(tenant_id, case_id, doc_key);

-- =============================================================================
-- Neon/Postgres RLS scaffolding
-- =============================================================================
-- Neon is plain Postgres, so RLS works natively. The app still filters every
-- tenant-owned query by tenant_id. These policies add a DB-level guard for any
-- future non-owner app role that sets:
--   SET LOCAL claimmix.tenant_id = '<tenant uuid>';
-- The table owner still bypasses RLS unless FORCE ROW LEVEL SECURITY is enabled,
-- so this migration is intentionally compatible with the current Neon HTTP role.

CREATE OR REPLACE FUNCTION public.claimmix_current_tenant_id()
RETURNS uuid
LANGUAGE sql
STABLE
AS $$
  SELECT NULLIF(current_setting('claimmix.tenant_id', true), '')::uuid
$$;

CREATE OR REPLACE FUNCTION public.claimmix_tenant_matches(row_tenant_id uuid)
RETURNS boolean
LANGUAGE sql
STABLE
AS $$
  SELECT row_tenant_id = public.claimmix_current_tenant_id()
$$;

DO $$
DECLARE
  table_name text;
  tables_with_tenant text[] := ARRAY[
    'users',
    'customers',
    'customer_contacts',
    'policies',
    'insured_assets',
    'cases',
    'raw_messages',
    'extracted_fields',
    'missing_docs',
    'outbound_messages',
    'audit_log',
    'ai_usage',
    'claim_messages',
    'claim_attachments',
    'claim_field_confirmations',
    'claim_memory',
    'gmail_poll_state',
    'gmail_watch_state',
    'gmail_accounts',
    'agent_training',
    'prompt_versions',
    'agent_runs',
    'training_examples',
    'agent_feedback',
    'agent_prompt_rules',
    'agent_custom_fields',
    'model_training_jobs',
    'tenant_ai_settings'
  ];
BEGIN
  FOREACH table_name IN ARRAY tables_with_tenant LOOP
    EXECUTE format('ALTER TABLE public.%I ENABLE ROW LEVEL SECURITY', table_name);
    EXECUTE format('DROP POLICY IF EXISTS claimmix_tenant_isolation ON public.%I', table_name);
    EXECUTE format(
      'CREATE POLICY claimmix_tenant_isolation ON public.%I
       USING (public.claimmix_tenant_matches(%I))
       WITH CHECK (public.claimmix_tenant_matches(%I))',
      table_name,
      CASE WHEN table_name = 'tenant_ai_settings' THEN 'tenant_id' ELSE 'tenant_id' END,
      CASE WHEN table_name = 'tenant_ai_settings' THEN 'tenant_id' ELSE 'tenant_id' END
    );
  END LOOP;
END $$;

-- known_claim_patterns can contain global rows (tenant_id IS NULL), so it needs
-- a policy that allows global reads and tenant-owned writes.
ALTER TABLE public.known_claim_patterns ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS claimmix_known_patterns_read ON public.known_claim_patterns;
DROP POLICY IF EXISTS claimmix_known_patterns_write ON public.known_claim_patterns;
CREATE POLICY claimmix_known_patterns_read ON public.known_claim_patterns
  FOR SELECT USING (
    tenant_id IS NULL OR public.claimmix_tenant_matches(tenant_id)
  );
CREATE POLICY claimmix_known_patterns_write ON public.known_claim_patterns
  USING (public.claimmix_tenant_matches(tenant_id))
  WITH CHECK (public.claimmix_tenant_matches(tenant_id));
