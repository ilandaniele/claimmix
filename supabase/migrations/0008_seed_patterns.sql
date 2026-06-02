-- =============================================================================
-- Migration 0008: Seed known_claim_patterns with es-AR insurance claim signals
-- =============================================================================
-- Global seed rows (tenant_id = NULL) provide baseline signal detection for
-- all tenants. These are keyword/phrase patterns common in Argentine Spanish
-- insurance claims.
--
-- Signal mapping:
--   severity_hint = 'critical' → death, fire, armed robbery, threat
--   severity_hint = 'high'     → injuries, ambulance, police, hospitalization
--   severity_hint = 'medium'   → collision, accident, hail
--   severity_hint = 'low'      → minor scratches, light bumps, cosmetic damage
--
-- AC11, AC15: These patterns feed the keyword-based severity classifier
-- (src/server/ai/severity-classifier.ts) which runs before/alongside LLM.
-- =============================================================================

INSERT INTO public.known_claim_patterns
  (tenant_id, pattern_text, pattern_type, severity_hint, language, enabled)
VALUES
  -- ── CRITICAL ──────────────────────────────────────────────────────────────
  (NULL, 'fallecido',              'keyword', 'critical', 'es-AR', true),
  (NULL, 'fallecimiento',          'keyword', 'critical', 'es-AR', true),
  (NULL, 'muerte',                 'keyword', 'critical', 'es-AR', true),
  (NULL, 'muerto',                 'keyword', 'critical', 'es-AR', true),
  (NULL, 'muerta',                 'keyword', 'critical', 'es-AR', true),
  (NULL, 'incendio',               'keyword', 'critical', 'es-AR', true),
  (NULL, 'robo a mano armada',     'phrase',  'critical', 'es-AR', true),
  (NULL, 'amenaza con arma',       'phrase',  'critical', 'es-AR', true),
  (NULL, 'amenaza',                'keyword', 'critical', 'es-AR', true),
  (NULL, 'explosión',              'keyword', 'critical', 'es-AR', true),
  (NULL, 'explosion',              'keyword', 'critical', 'es-AR', true),

  -- ── HIGH ──────────────────────────────────────────────────────────────────
  (NULL, 'ambulancia',             'keyword', 'high', 'es-AR', true),
  (NULL, 'hospitalizado',          'keyword', 'high', 'es-AR', true),
  (NULL, 'hospitalizada',          'keyword', 'high', 'es-AR', true),
  (NULL, 'herido',                 'keyword', 'high', 'es-AR', true),
  (NULL, 'herida',                 'keyword', 'high', 'es-AR', true),
  (NULL, 'lesiones',               'keyword', 'high', 'es-AR', true),
  (NULL, 'lesionado',              'keyword', 'high', 'es-AR', true),
  (NULL, 'lesionada',              'keyword', 'high', 'es-AR', true),
  (NULL, 'policía',                'keyword', 'high', 'es-AR', true),
  (NULL, 'policia',                'keyword', 'high', 'es-AR', true),
  (NULL, 'urgencia',               'keyword', 'high', 'es-AR', true),
  (NULL, 'robo',                   'keyword', 'high', 'es-AR', true),
  (NULL, 'hurto',                  'keyword', 'high', 'es-AR', true),

  -- ── MEDIUM ────────────────────────────────────────────────────────────────
  (NULL, 'choque',                 'keyword', 'medium', 'es-AR', true),
  (NULL, 'colisión',               'keyword', 'medium', 'es-AR', true),
  (NULL, 'colision',               'keyword', 'medium', 'es-AR', true),
  (NULL, 'accidente',              'keyword', 'medium', 'es-AR', true),
  (NULL, 'granizo',                'keyword', 'medium', 'es-AR', true),
  (NULL, 'inundación',             'keyword', 'medium', 'es-AR', true),
  (NULL, 'inundacion',             'keyword', 'medium', 'es-AR', true),
  (NULL, 'chocaron',               'keyword', 'medium', 'es-AR', true),

  -- ── LOW ───────────────────────────────────────────────────────────────────
  (NULL, 'rayones',                'keyword', 'low', 'es-AR', true),
  (NULL, 'rayón',                  'keyword', 'low', 'es-AR', true),
  (NULL, 'golpe leve',             'phrase',  'low', 'es-AR', true),
  (NULL, 'daño menor',             'phrase',  'low', 'es-AR', true),
  (NULL, 'raspón',                 'keyword', 'low', 'es-AR', true),
  (NULL, 'raspones',               'keyword', 'low', 'es-AR', true),
  (NULL, 'abolladura leve',        'phrase',  'low', 'es-AR', true),
  (NULL, 'daño estético',          'phrase',  'low', 'es-AR', true),
  (NULL, 'sin heridos',            'phrase',  'low', 'es-AR', true)
ON CONFLICT DO NOTHING;
