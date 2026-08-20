-- A document the claimant says they do not have.
--
-- Every required document had exactly two states: waiting, or arrived. Most
-- crashes have no friendly accident report — the request itself says "si lo
-- completaron" — and a person who answers "no completamos ninguno" had no way
-- to be heard. The claim sat in confirmacion_pendiente until the abandonment
-- sweep closed it two weeks later, as though they had never replied.
--
-- Declined is deliberately NOT satisfied_at. A document marked as received
-- disappears from the analyst's list and reads as "we have it"; this one has
-- to read as "they told us there isn't one", which is a different fact and
-- sometimes one worth pushing back on.

ALTER TABLE missing_docs
  ADD COLUMN IF NOT EXISTS declined_at   timestamptz,
  ADD COLUMN IF NOT EXISTS declined_note text;

COMMENT ON COLUMN missing_docs.declined_at IS
  'When the claimant said this document does not exist. Distinct from satisfied_at: nothing was received.';
COMMENT ON COLUMN missing_docs.declined_note IS
  'What they said, verbatim-ish, so an analyst can judge whether to insist.';

-- Outstanding = neither received nor declined. This is the shape every read
-- filters on, and it is what the agent asks about on the next round.
CREATE INDEX IF NOT EXISTS idx_missing_docs_outstanding
  ON missing_docs (case_id)
  WHERE satisfied_at IS NULL AND declined_at IS NULL;
