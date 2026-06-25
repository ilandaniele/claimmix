-- =============================================================================
-- Migration 0007: Expand agent_custom_fields claim_type CHECK constraint
-- =============================================================================
-- Adds the four new claim types (cristales, rc, robo_contenido, accidente_personal)
-- to the claim_type CHECK constraint so custom fields can be scoped to them.
-- =============================================================================

ALTER TABLE public.agent_custom_fields
  DROP CONSTRAINT IF EXISTS agent_custom_fields_claim_type_check;

ALTER TABLE public.agent_custom_fields
  ADD CONSTRAINT agent_custom_fields_claim_type_check
    CHECK (
      claim_type IS NULL
      OR claim_type IN (
        'choque', 'robo', 'granizo', 'incendio', 'other',
        'cristales', 'rc', 'robo_contenido', 'accidente_personal'
      )
    );
