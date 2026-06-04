-- =============================================================================
-- Migration 0011: gmail_watch_state — Gmail watch subscription columns
-- =============================================================================
--
-- PURPOSE
-- -------
-- Extends gmail_poll_state with two columns to track the active Gmail push
-- notification subscription registered via users.watch():
--
--   watch_expiration   — ISO-8601 / timestamptz when the watch expires (7 days max).
--                        Used by the cron route to decide whether to renew.
--   watch_history_id   — historyId returned by users.watch(); used as the starting
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
-- No RLS changes needed — this table is service-role only (set in migration 0010).
-- The service-role client bypasses RLS by PostgreSQL convention.
--
-- ONLINE SAFETY
-- -------------
-- ADD COLUMN IF NOT EXISTS — additive only; existing rows gain NULL values.
-- Safe on live traffic with no table lock beyond metadata update (in Postgres 11+).
--
-- ROLLBACK PLAN (manual — no down migration in this codebase)
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
