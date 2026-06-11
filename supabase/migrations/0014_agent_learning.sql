-- =============================================================================
-- Migration 0014: agent learning & review workflow
-- =============================================================================
-- Adds the human-in-the-loop training pipeline:
--   prompt_versions      — versioned system prompts (active one injected per run)
--   agent_runs           — one row per processed email (model, payloads,
--                          confidence, trainability suggestion)
--   training_examples    — examples approved by a human; few-shot/RAG source
--   agent_feedback       — reviewer corrections on agent output
--   agent_prompt_rules   — operator-authored rules injected into the prompt
--   model_training_jobs  — batched fine-tuning queue (never auto-deployed)
-- Also widens users.role to: owner, admin, specialist, analyst, viewer.
--
-- Safety: emails are untrusted until reviewed. Nothing in this schema causes
-- automatic learning — training_examples rows are created ONLY by an explicit
-- human confirmation endpoint, and model_training_jobs are queued in 'draft'.
-- All tables are tenant-scoped with RLS (current_tenant_id()).
-- =============================================================================

-- ── 1. Widen users.role ──────────────────────────────────────────────────────
-- Existing roles ('analyst', 'admin') keep working. New: owner, specialist,
-- viewer. Role semantics are enforced at the API layer; RLS stays tenant-based.

ALTER TABLE public.users DROP CONSTRAINT IF EXISTS users_role_check;
ALTER TABLE public.users
  ADD CONSTRAINT users_role_check
  CHECK (role IN ('owner', 'admin', 'specialist', 'analyst', 'viewer'));

-- ── 2. prompt_versions ───────────────────────────────────────────────────────

CREATE TABLE IF NOT EXISTS public.prompt_versions (
  id             uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id      uuid NOT NULL REFERENCES public.tenants(id) ON DELETE CASCADE,
  version        text NOT NULL,
  system_prompt  text NOT NULL DEFAULT '',
  active         boolean NOT NULL DEFAULT false,
  created_by     uuid REFERENCES public.users(id) ON DELETE SET NULL,
  created_at     timestamptz NOT NULL DEFAULT now()
);

CREATE UNIQUE INDEX IF NOT EXISTS idx_prompt_versions_tenant_version
  ON public.prompt_versions(tenant_id, version);

-- At most one active prompt version per tenant.
CREATE UNIQUE INDEX IF NOT EXISTS idx_prompt_versions_tenant_active
  ON public.prompt_versions(tenant_id)
  WHERE active = true;

-- ── 3. agent_runs ────────────────────────────────────────────────────────────
-- One row per agent execution over an email. Append-only audit of what the
-- model saw, what it produced, and whether the run looks safe to train on.

CREATE TABLE IF NOT EXISTS public.agent_runs (
  id                       uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id                uuid NOT NULL REFERENCES public.tenants(id) ON DELETE CASCADE,
  case_id                  uuid REFERENCES public.cases(id) ON DELETE CASCADE,
  claim_message_id         uuid REFERENCES public.claim_messages(id) ON DELETE SET NULL,
  provider_message_id      text,
  model_provider           text NOT NULL DEFAULT 'openai',
  model_name               text NOT NULL,
  prompt_version_id        uuid REFERENCES public.prompt_versions(id) ON DELETE SET NULL,
  prompt_version           text NOT NULL DEFAULT 'builtin-v1',
  input_payload            jsonb NOT NULL DEFAULT '{}'::jsonb,
  output_payload           jsonb NOT NULL DEFAULT '{}'::jsonb,
  confidence_payload       jsonb NOT NULL DEFAULT '{}'::jsonb,
  missing_fields           jsonb NOT NULL DEFAULT '[]'::jsonb,
  is_trainable_suggestion  boolean NOT NULL DEFAULT false,
  trainability_score       numeric(4,3) NOT NULL DEFAULT 0,
  trainability_reasons     jsonb NOT NULL DEFAULT '[]'::jsonb,
  blocking_reasons         jsonb NOT NULL DEFAULT '[]'::jsonb,
  created_at               timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_agent_runs_case_created
  ON public.agent_runs(case_id, created_at DESC);

CREATE INDEX IF NOT EXISTS idx_agent_runs_tenant_created
  ON public.agent_runs(tenant_id, created_at DESC);

-- ── 4. training_examples ─────────────────────────────────────────────────────
-- Created ONLY via explicit human approval ("Confirm as safe training example").
-- Unique per agent_run and per inbound message — duplicates are impossible.

CREATE TABLE IF NOT EXISTS public.training_examples (
  id                uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id         uuid NOT NULL REFERENCES public.tenants(id) ON DELETE CASCADE,
  agent_run_id      uuid NOT NULL REFERENCES public.agent_runs(id) ON DELETE CASCADE,
  case_id           uuid REFERENCES public.cases(id) ON DELETE CASCADE,
  claim_message_id  uuid REFERENCES public.claim_messages(id) ON DELETE SET NULL,
  claim_type        text,
  input_payload     jsonb NOT NULL DEFAULT '{}'::jsonb,
  expected_output   jsonb NOT NULL DEFAULT '{}'::jsonb,
  status            text NOT NULL DEFAULT 'approved'
                      CHECK (status IN ('suggested', 'approved', 'rejected',
                                        'exported', 'queued_for_finetune', 'trained')),
  approved_by       uuid REFERENCES public.users(id) ON DELETE SET NULL,
  approved_at       timestamptz,
  created_at        timestamptz NOT NULL DEFAULT now()
);

CREATE UNIQUE INDEX IF NOT EXISTS idx_training_examples_agent_run
  ON public.training_examples(tenant_id, agent_run_id);

CREATE UNIQUE INDEX IF NOT EXISTS idx_training_examples_message
  ON public.training_examples(tenant_id, claim_message_id)
  WHERE claim_message_id IS NOT NULL;

CREATE INDEX IF NOT EXISTS idx_training_examples_tenant_status
  ON public.training_examples(tenant_id, status, created_at DESC);

-- ── 5. agent_feedback ────────────────────────────────────────────────────────

CREATE TABLE IF NOT EXISTS public.agent_feedback (
  id                     uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id              uuid NOT NULL REFERENCES public.tenants(id) ON DELETE CASCADE,
  agent_run_id           uuid NOT NULL REFERENCES public.agent_runs(id) ON DELETE CASCADE,
  reviewer_id            uuid REFERENCES public.users(id) ON DELETE SET NULL,
  original_output        jsonb NOT NULL DEFAULT '{}'::jsonb,
  corrected_output       jsonb NOT NULL DEFAULT '{}'::jsonb,
  feedback_type          text NOT NULL DEFAULT 'correction',
  approved_for_training  boolean NOT NULL DEFAULT false,
  created_at             timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_agent_feedback_run
  ON public.agent_feedback(agent_run_id, created_at DESC);

-- ── 6. agent_prompt_rules ────────────────────────────────────────────────────
-- Operator-authored rules ("If the user mentions choque, classify as
-- vehicle_collision"). Active rules are injected into the extraction prompt.
-- Versioned via updated_at + audit_log events; never overwrite source code.

CREATE TABLE IF NOT EXISTS public.agent_prompt_rules (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id   uuid NOT NULL REFERENCES public.tenants(id) ON DELETE CASCADE,
  title       text NOT NULL,
  rule_text   text NOT NULL,
  rule_type   text NOT NULL DEFAULT 'extraction'
                CHECK (rule_type IN ('extraction', 'classification', 'severity',
                                     'missing_fields', 'reply_style', 'core_mapping')),
  active      boolean NOT NULL DEFAULT true,
  created_by  uuid REFERENCES public.users(id) ON DELETE SET NULL,
  created_at  timestamptz NOT NULL DEFAULT now(),
  updated_at  timestamptz
);

DROP TRIGGER IF EXISTS trg_agent_prompt_rules_updated_at ON public.agent_prompt_rules;
CREATE TRIGGER trg_agent_prompt_rules_updated_at
  BEFORE UPDATE ON public.agent_prompt_rules
  FOR EACH ROW EXECUTE FUNCTION public.set_updated_at();

CREATE INDEX IF NOT EXISTS idx_agent_prompt_rules_tenant_active
  ON public.agent_prompt_rules(tenant_id, active)
  WHERE active = true;

-- ── 7. model_training_jobs ───────────────────────────────────────────────────
-- Batched fine-tuning queue. Jobs are created in 'draft' when enough approved
-- examples exist; they require explicit human approval ('approved') and a
-- separate manual activation before any model is deployed. Rollback is always
-- possible because the previous model id is never overwritten here.

CREATE TABLE IF NOT EXISTS public.model_training_jobs (
  id                      uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id               uuid NOT NULL REFERENCES public.tenants(id) ON DELETE CASCADE,
  status                  text NOT NULL DEFAULT 'draft'
                            CHECK (status IN ('draft', 'queued', 'running', 'eval_pending',
                                              'approved', 'rejected', 'deployed', 'failed')),
  provider                text NOT NULL DEFAULT 'openai',
  base_model              text NOT NULL DEFAULT '',
  fine_tuned_model_id     text,
  training_example_count  integer NOT NULL DEFAULT 0,
  eval_result             jsonb,
  created_by              uuid REFERENCES public.users(id) ON DELETE SET NULL,
  created_at              timestamptz NOT NULL DEFAULT now(),
  completed_at            timestamptz
);

CREATE INDEX IF NOT EXISTS idx_model_training_jobs_tenant_status
  ON public.model_training_jobs(tenant_id, status, created_at DESC);

-- ── 8. RLS — tenant isolation on every new table ─────────────────────────────

ALTER TABLE public.prompt_versions     ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.agent_runs          ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.training_examples   ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.agent_feedback      ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.agent_prompt_rules  ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.model_training_jobs ENABLE ROW LEVEL SECURITY;

DO $$
DECLARE
  tbl text;
BEGIN
  FOREACH tbl IN ARRAY ARRAY[
    'prompt_versions',
    'agent_runs',
    'training_examples',
    'agent_feedback',
    'agent_prompt_rules',
    'model_training_jobs'
  ] LOOP
    IF NOT EXISTS (
      SELECT 1 FROM pg_policies
      WHERE schemaname = 'public'
        AND tablename = tbl
        AND policyname = tbl || '_tenant_all'
    ) THEN
      EXECUTE format(
        'CREATE POLICY %I ON public.%I FOR ALL
           USING (tenant_id = public.current_tenant_id())
           WITH CHECK (tenant_id = public.current_tenant_id())',
        tbl || '_tenant_all', tbl
      );
    END IF;
  END LOOP;
END $$;
