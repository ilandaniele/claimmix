-- =============================================================================
-- 0033 — Las reglas globales se leen, no se tocan
-- =============================================================================
--
-- `known_claim_patterns` tiene tres políticas permisivas, que Postgres suma
-- con OR: las dos de 0004 (`claimmix_known_patterns_read`, SELECT sobre lo
-- propio y lo global; `claimmix_known_patterns_write`, FOR ALL sobre lo
-- propio) y la de 0018/0019 (`claimmix_tenant_isolation`, FOR ALL con USING
-- sobre lo propio y lo global). En FOR ALL el USING también decide qué filas
-- alcanza un UPDATE o un DELETE: por esa última, un inquilino podía borrar una
-- regla global (WITH CHECK sólo mira la fila nueva de un UPDATE; un DELETE no
-- tiene fila nueva). Auditoría E5, #43.
--
-- Queda una política por comando: SELECT ve lo propio y lo global; INSERT,
-- UPDATE y DELETE alcanzan sólo lo propio. Se borran las tres viejas, así el
-- estado final es el mismo en una base nueva y en las vivas. Hoy la aplicación
-- sólo lee esta tabla.
--
-- Orden: primero las cuatro nuevas, después se borran las viejas. Con FORCE
-- ROW LEVEL SECURITY (0018) una tabla sin política no devuelve nada, y esto
-- corre en una transacción (migrate.mjs); a mano, envolverlo en BEGIN/COMMIT.
-- Volver a correrla es inocuo.
--
-- Vuelta atrás (mismo orden: crear antes de borrar):
--   BEGIN;
--   CREATE POLICY claimmix_known_patterns_read ON public.known_claim_patterns
--     FOR SELECT USING (tenant_id IS NULL OR public.claimmix_tenant_matches(tenant_id));
--   CREATE POLICY claimmix_known_patterns_write ON public.known_claim_patterns
--     USING (public.claimmix_tenant_matches(tenant_id))
--     WITH CHECK (public.claimmix_tenant_matches(tenant_id));
--   CREATE POLICY claimmix_tenant_isolation ON public.known_claim_patterns
--     USING (tenant_id IS NULL OR public.claimmix_tenant_matches(tenant_id))
--     WITH CHECK (public.claimmix_tenant_matches(tenant_id));
--   COMMENT ON POLICY claimmix_tenant_isolation ON public.known_claim_patterns IS
--     'Lee lo propio y lo global (tenant_id nulo); escribe sólo lo propio.';
--   DROP POLICY IF EXISTS claimmix_tenant_isolation_select ON public.known_claim_patterns;
--   DROP POLICY IF EXISTS claimmix_tenant_isolation_insert ON public.known_claim_patterns;
--   DROP POLICY IF EXISTS claimmix_tenant_isolation_update ON public.known_claim_patterns;
--   DROP POLICY IF EXISTS claimmix_tenant_isolation_delete ON public.known_claim_patterns;
--   COMMIT;
--   y después `node scripts/migrate.mjs --forget 0033`.
-- =============================================================================

DROP POLICY IF EXISTS claimmix_tenant_isolation_select ON public.known_claim_patterns;
CREATE POLICY claimmix_tenant_isolation_select ON public.known_claim_patterns
  FOR SELECT
  USING (tenant_id IS NULL OR public.claimmix_tenant_matches(tenant_id));

DROP POLICY IF EXISTS claimmix_tenant_isolation_insert ON public.known_claim_patterns;
CREATE POLICY claimmix_tenant_isolation_insert ON public.known_claim_patterns
  FOR INSERT
  WITH CHECK (public.claimmix_tenant_matches(tenant_id));

DROP POLICY IF EXISTS claimmix_tenant_isolation_update ON public.known_claim_patterns;
CREATE POLICY claimmix_tenant_isolation_update ON public.known_claim_patterns
  FOR UPDATE
  USING (public.claimmix_tenant_matches(tenant_id))
  WITH CHECK (public.claimmix_tenant_matches(tenant_id));

DROP POLICY IF EXISTS claimmix_tenant_isolation_delete ON public.known_claim_patterns;
CREATE POLICY claimmix_tenant_isolation_delete ON public.known_claim_patterns
  FOR DELETE
  USING (public.claimmix_tenant_matches(tenant_id));

DROP POLICY IF EXISTS claimmix_tenant_isolation ON public.known_claim_patterns;
DROP POLICY IF EXISTS claimmix_known_patterns_read ON public.known_claim_patterns;
DROP POLICY IF EXISTS claimmix_known_patterns_write ON public.known_claim_patterns;

COMMENT ON POLICY claimmix_tenant_isolation_select ON public.known_claim_patterns IS
  'Lee lo propio y lo global (tenant_id nulo).';
COMMENT ON POLICY claimmix_tenant_isolation_insert ON public.known_claim_patterns IS
  'Escribe sólo lo propio; una regla global se crea como dueño.';
COMMENT ON POLICY claimmix_tenant_isolation_update ON public.known_claim_patterns IS
  'Cambia sólo lo propio.';
COMMENT ON POLICY claimmix_tenant_isolation_delete ON public.known_claim_patterns IS
  'Borra sólo lo propio: lo global no se alcanza.';
