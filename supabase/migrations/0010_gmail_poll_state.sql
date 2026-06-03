-- =============================================================================
-- Migration 0010: gmail_poll_state — Gmail polling watermark table
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
-- IC4: sentinel tenant pattern — the cron runs as service-role (bypasses RLS).
-- No SELECT/INSERT/UPDATE policies for authenticated/anon roles are added here.
--
-- ONLINE SAFETY
-- -------------
-- CREATE TABLE IF NOT EXISTS — additive only, safe on live traffic.
-- CREATE UNIQUE INDEX IF NOT EXISTS — does not use CONCURRENTLY because this
-- is a new table with no live traffic at migration time.
-- ALTER TABLE ENABLE ROW LEVEL SECURITY — metadata-only, safe.
--
-- ROLLBACK PLAN (manual — no down migration in this codebase)
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
  -- PII-adjacent — treat as sensitive; do not log.
  gmail_account_email  text        NOT NULL,

  -- Last Gmail API historyId successfully processed.
  -- Incremented after all messages in that history batch succeed.
  -- Default '1' allows users.history.list to start from the beginning;
  -- in practice the poller will call users.getProfile() to seed a real
  -- historyId on the first run before advancing.
  -- Non-PII — safe to log as an opaque string (no message content).
  history_id           text        NOT NULL DEFAULT '1',

  -- Timestamp of the last successful or attempted poll.
  last_polled_at       timestamptz,

  -- Last error message (non-fatal — watermark NOT advanced on error).
  -- Capped at 500 chars to prevent PII leakage from accidental error strings.
  last_error           text,

  -- Standard timestamps
  created_at           timestamptz NOT NULL DEFAULT now(),
  updated_at           timestamptz NOT NULL DEFAULT now()
);

-- =============================================================================
-- SECTION 2: Indexes
-- =============================================================================

-- Unique per Gmail account email — one watermark row per inbox.
-- Forward-compatible with multi-tenant (per-account) rows in phase 2.
CREATE UNIQUE INDEX IF NOT EXISTS idx_gmail_poll_state_account
  ON public.gmail_poll_state (gmail_account_email);

-- =============================================================================
-- SECTION 3: RLS
--
-- RLS is ENABLED. No policies for authenticated/anon roles are added:
-- the cron route uses the service-role Supabase client which bypasses RLS by
-- PostgreSQL convention (superuser-equivalent). This table is a system table —
-- it is never exposed to the UI or tenant-scoped queries.
--
-- Service role has full SELECT/INSERT/UPDATE/DELETE access by convention.
-- =============================================================================

ALTER TABLE public.gmail_poll_state ENABLE ROW LEVEL SECURITY;

-- No SELECT/INSERT/UPDATE/DELETE policies for authenticated/anon roles.
-- Service-role bypasses RLS — full access without explicit policy.

-- =============================================================================
-- SECTION 4: Column comments
-- =============================================================================

COMMENT ON COLUMN public.gmail_poll_state.history_id IS
  'Last Gmail API historyId successfully processed. Incremented after all messages in that history batch succeed. Non-PII.';

COMMENT ON COLUMN public.gmail_poll_state.gmail_account_email IS
  'The Gmail address being polled. PII-adjacent — treat as sensitive.';

COMMENT ON COLUMN public.gmail_poll_state.last_error IS
  'Last non-fatal error string (capped at 500 chars). Watermark is NOT advanced when this is set.';
