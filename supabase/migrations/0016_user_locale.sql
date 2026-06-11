-- =============================================================================
-- 0016 — Per-account language preference
--
-- users.locale stores the analyst's UI language ('es-AR' | 'en-US').
-- NULL = no preference saved yet (falls back to the locale cookie / default).
-- Persisted from the ES/EN switcher (PATCH /api/auth/me) and applied by the
-- app layout on every device the user signs in from.
--
-- RLS: covered by the existing users_update_own policy (id = auth.uid()).
-- =============================================================================

ALTER TABLE public.users
  ADD COLUMN IF NOT EXISTS locale text
  CHECK (locale IS NULL OR locale IN ('es-AR', 'en-US'));
