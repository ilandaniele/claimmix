-- =============================================================================
-- Migration 0005: Email intake — extend cases table for email claims workflow
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
