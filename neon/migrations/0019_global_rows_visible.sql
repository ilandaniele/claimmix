-- =============================================================================
-- 0019 — Que las reglas globales sigan siendo globales bajo RLS
-- =============================================================================
--
-- `known_claim_patterns` guarda dos clases de fila: las de un inquilino y las
-- **globales**, que llevan `tenant_id` nulo y valen para todos. El código lo
-- dice explícitamente:
--
--     or(isNull(knownClaimPatterns.tenant_id), eq(..., tenantId))
--     // Global rows have tenant_id = NULL (visible to all tenants)
--
-- La política que puso 0004 es `tenant_id = current_setting(...)`. Con
-- `tenant_id` nulo esa comparación da NULL, que no es TRUE, así que **la fila se
-- filtra**. O sea: en cuanto la aplicación pase al rol restringido, las reglas
-- globales dejarían de existir para todo el mundo.
--
-- Hoy no hay ninguna fila global en producción, así que esto no arregla un
-- síntoma: evita uno. El día que alguien agregue una regla global, funcionaría
-- con el rol viejo y desaparecería con el nuevo — la clase de diferencia que se
-- descubre tarde y mal.
--
-- Se toca SOLO esta tabla. En las demás, un `tenant_id` nulo no significa
-- "de todos": significa que algo se escribió mal, y ahí que la fila sea
-- invisible es el comportamiento correcto.
-- =============================================================================

DROP POLICY IF EXISTS claimmix_tenant_isolation ON public.known_claim_patterns;

CREATE POLICY claimmix_tenant_isolation ON public.known_claim_patterns
  USING (
    tenant_id IS NULL
    OR public.claimmix_tenant_matches(tenant_id)
  )
  -- WITH CHECK aparte y más estricto que el USING: se puede LEER lo global,
  -- pero no se puede ESCRIBIR una fila global desde la aplicación. Crear una
  -- regla que afecta a todas las aseguradoras es una decisión de operación, no
  -- algo que deba poder hacer una sesión de un inquilino cualquiera.
  WITH CHECK (public.claimmix_tenant_matches(tenant_id));

COMMENT ON POLICY claimmix_tenant_isolation ON public.known_claim_patterns IS
  'Lee lo propio y lo global (tenant_id nulo); escribe sólo lo propio.';
