-- =============================================================================
-- Migration 0012: Make cases.claim_type nullable + add 'other' to CHECK
-- =============================================================================
-- W1 (PR #25 NB3) changed the gmail-poller to insert claim_type=NULL for
-- pre-classification cases (AI classifies later via the extraction worker).
-- The column was NOT NULL with no 'other' value, causing 23502 errors.
--
-- 1. DROP NOT NULL so newly-ingested email cases can start unclassified.
-- 2. Recreate the CHECK constraint to allow NULL and the new 'other' value
--    (added to the TypeScript ClaimType enum in the same PR).
-- =============================================================================

ALTER TABLE public.cases
  ALTER COLUMN claim_type DROP NOT NULL;

ALTER TABLE public.cases
  DROP CONSTRAINT IF EXISTS cases_claim_type_check;

ALTER TABLE public.cases
  ADD CONSTRAINT cases_claim_type_check
    CHECK (
      claim_type IS NULL
      OR claim_type IN ('choque', 'robo', 'granizo', 'incendio', 'other')
    );
