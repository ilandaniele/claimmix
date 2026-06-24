-- =============================================================================
-- Migration 0006: provider_usage_events table + Vertex AI fine-tuning support
-- =============================================================================
-- 1. Add provider_usage_events for Gemini quota/rate-limit visibility.
-- 2. Add vertex_ai_* columns to model_training_jobs for Vertex AI tuning jobs.
-- =============================================================================

-- ---------------------------------------------------------------------------
-- 1. provider_usage_events
-- ---------------------------------------------------------------------------
-- Tracks every AI provider call: success, error, rate-limit, invalid JSON.
-- No PII stored — only aggregate metrics, error codes, and latency.

CREATE TABLE IF NOT EXISTS public.provider_usage_events (
  id            uuid        PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id     uuid        NOT NULL REFERENCES public.tenants(id) ON DELETE CASCADE,
  provider      text        NOT NULL,                        -- gemini | openai | mock
  model         text        NOT NULL,
  operation     text        NOT NULL DEFAULT 'extraction',   -- extraction | email_extraction | simulate
  status        text        NOT NULL,                        -- success | error | rate_limited | quota_exceeded | invalid_json | timeout
  latency_ms    integer,
  error_code    text,                                        -- HTTP status or error name
  error_message text,
  retry_count   integer     NOT NULL DEFAULT 0,
  prompt_tokens integer     NOT NULL DEFAULT 0,
  completion_tokens integer NOT NULL DEFAULT 0,
  created_at    timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_pue_tenant_created
  ON public.provider_usage_events (tenant_id, created_at DESC);

CREATE INDEX IF NOT EXISTS idx_pue_provider_status
  ON public.provider_usage_events (tenant_id, provider, status, created_at DESC);

-- ---------------------------------------------------------------------------
-- 2. Vertex AI columns on model_training_jobs
-- ---------------------------------------------------------------------------
-- Reuses openai_fine_tuning_job_id to store the Vertex AI tuning job name.
-- Adds dedicated vertex_* columns for project/location/model endpoint.

ALTER TABLE public.model_training_jobs
  ADD COLUMN IF NOT EXISTS vertex_project_id      text,
  ADD COLUMN IF NOT EXISTS vertex_location        text,
  ADD COLUMN IF NOT EXISTS vertex_tuning_job_name text,  -- full resource name
  ADD COLUMN IF NOT EXISTS vertex_tuned_model_endpoint text,  -- model endpoint after tuning
  ADD COLUMN IF NOT EXISTS validation_example_count integer NOT NULL DEFAULT 0;
