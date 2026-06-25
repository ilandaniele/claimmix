-- =============================================================================
-- Migration 0008: Expand cases.claim_type CHECK constraint
-- =============================================================================
-- The original constraint only allowed the 5 initial types. Simulating or
-- processing emails with the four new types (cristales, rc, robo_contenido,
-- accidente_personal) caused a PostgreSQL 23514 CHECK violation.
-- =============================================================================

ALTER TABLE public.cases
  DROP CONSTRAINT IF EXISTS cases_claim_type_check;

ALTER TABLE public.cases
  ADD CONSTRAINT cases_claim_type_check
    CHECK (
      claim_type IS NULL
      OR claim_type IN (
        'choque', 'robo', 'granizo', 'incendio', 'other',
        'cristales', 'rc', 'robo_contenido', 'accidente_personal'
      )
    );
