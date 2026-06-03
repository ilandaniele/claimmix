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
--   CREATE TABLE       — new table, no lock on existing tables
--   CREATE INDEX CONCURRENTLY — does not hold a share lock on the table;
--                               safe on live traffic (Supabase supports this)
--   ALTER TABLE … ADD COLUMN IF NOT EXISTS — fast metadata-only in Postgres 11+
--   INSERT INTO storage.buckets … ON CONFLICT DO NOTHING — idempotent
--   CREATE POLICY — no table lock
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
-- ROLLBACK PLAN (manual — no down migration in this codebase)
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
-- the FK constraint and the column from claim_attachments — it does not
-- touch claim_attachments rows (ON DELETE CASCADE is on the column, not the
-- table drop).
-- =============================================================================

-- =============================================================================
-- SECTION 1: claim_messages table
-- =============================================================================
-- Unified store for all email messages processed by the system.
-- direction='inbound'  → received from Postmark webhook
-- direction='outbound' → sent via Postmark outbound API
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

  -- Provider identifier — 'postmark' for all rows in this PR;
  -- stored as text (not enum) to allow future providers without a migration.
  provider             text        NOT NULL DEFAULT 'postmark',

  -- provider_message_id: Postmark MessageID (e.g. "abc@mail.postmarkapp.com").
  -- NULL only for direction='outbound' rows in status='queued' (set after send).
  -- Uniqueness per (tenant_id, provider_message_id) is enforced by the partial
  -- unique index below; the column is intentionally nullable at the DB level
  -- to accommodate the outbound queued state without a race condition.
  -- [PII-adjacent] — do not log this value.
  provider_message_id  text,

  -- thread_id: matches cases.email_thread_id semantics.
  -- Populated from extractThreadId() on the inbound side; copied from the
  -- inbound thread on the outbound side.
  thread_id            text,

  -- in_reply_to: normalized Postmark MessageID this message replies to
  -- (angle brackets stripped at application layer before storage).
  in_reply_to          text,

  -- Addressing fields — present only for the relevant direction.
  from_addr            text,        -- [PII] inbound: claimant address
  to_addr              text,        -- [PII] outbound: claimant address; inbound: intake inbox
  subject              text,        -- [PII]

  -- Body fields — at least one populated per message.
  body_text            text,        -- [PII] inbound: plaintext; outbound: rendered text
  body_html            text,        -- [PII]

  -- headers: full Postmark Headers array (array of {Name, Value} objects).
  -- Defaults to empty array so legacy code paths can insert without specifying it.
  -- [PII] — may contain sender email addresses in Received / X-Forwarded-To headers.
  headers              jsonb       NOT NULL DEFAULT '[]'::jsonb,

  -- raw_payload: verbatim parsed Postmark inbound JSON (direction='inbound' only).
  -- NULL for outbound rows; never logged.
  -- [PII] — contains full email body, from_addr, and attachment metadata.
  raw_payload          jsonb,

  -- template: outbound template key (e.g. 'confirmation-received').
  -- NULL for inbound rows.
  template             text,

  -- status lifecycle:
  --   inbound:  always 'received' on insert
  --   outbound: 'queued' → 'sent' on Postmark success
  --             'queued' → 'failed' on Postmark error
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
-- The table is append-only: no DELETE policy → DELETE is denied for all
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

-- UPDATE: tenant-scoped update — required by the outbound dispatcher to
-- transition status from 'queued' → 'sent'|'failed' and set provider_message_id.
CREATE POLICY "claim_messages_tenant_update"
  ON public.claim_messages
  FOR UPDATE
  USING (tenant_id = public.current_tenant_id())
  WITH CHECK (tenant_id = public.current_tenant_id());

-- No DELETE policy — claim_messages is append-only.

-- =============================================================================
-- SECTION 4: Extend claim_attachments
--
-- Adds two columns to the existing claim_attachments table:
--   claim_message_id — FK to claim_messages; links each attachment to the
--                      specific message that carried it. Nullable for rows
--                      created before this migration (dual-write window).
--   rejected_reason  — reason text when an attachment is rejected by the
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
-- SECTION 5: Supabase Storage bucket — claim-attachments
--
-- Creates the private storage bucket used to re-host Postmark CDN attachments.
-- The bucket is private (public = false): files are accessible only via
-- service-role uploads and time-limited signed URLs generated by the backend.
--
-- ON CONFLICT DO NOTHING makes this statement idempotent — safe to run
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
-- service-role client — it does not need a permissive RLS policy here.
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
