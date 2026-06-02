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
--   - Extraction confidence is medium (0.60–0.85) → AC7
--   - Extracted value conflicts with stored customer record → AC9
--   - A confirmed memory field has a new high-confidence alternative → AC14
--
-- Status lifecycle: pending → confirmed | rejected | corrected
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
-- Memory is NEVER auto-overwritten — analyst must explicitly confirm (AC14).
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
                           'policy_link'       -- confirmed sender→policy association
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
-- weight: relative importance (0.00–1.00) for combining multiple signals
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
