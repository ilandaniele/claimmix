-- Migration 0012: serialise extraction per case.
--
-- Two replies arriving one second apart produced two concurrent extraction
-- runs on the same case. Both read the conversation before either had written,
-- so both emailed the claimant asking for the policy number and DNI they had
-- just sent — 528 ms apart — and the overlapping upserts collided, leaving
-- neither value stored. The claimant answered correctly and the data vanished.
--
-- extraction_lease_at is a lease, not a lock: a crashed run must not wedge the
-- case forever, so it is taken with a timeout rather than held until released.
-- extraction_pending records that a message arrived while a run was in flight,
-- so the holder can re-run instead of that message going unread.

ALTER TABLE cases
  ADD COLUMN IF NOT EXISTS extraction_lease_at TIMESTAMPTZ,
  ADD COLUMN IF NOT EXISTS extraction_pending BOOLEAN NOT NULL DEFAULT FALSE;

-- Partial index: only leased rows are ever scanned by the reaper.
CREATE INDEX IF NOT EXISTS idx_cases_extraction_lease
  ON cases (extraction_lease_at)
  WHERE extraction_lease_at IS NOT NULL;
