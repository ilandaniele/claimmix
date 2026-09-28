-- =============================================================================
-- 0032 — La auditoría sólo se agrega, también para la base
-- =============================================================================
--
-- `audit_log` es de sólo-alta por convención del código: nada en `src/` la
-- actualiza ni la borra. Pero el rol con el que consulta la aplicación
-- (`claimmix_app`, lo crea `pnpm rol-app`) tiene UPDATE y DELETE sobre todas
-- las tablas, así que la convención no era una barrera: un error de código o
-- una sesión comprometida podía reescribir el rastro (auditoría, E6, #47).
--
-- El rol no lo crea ninguna migración: en una base sin él (el ensayo de CI, o
-- una rama recién hecha) no hay nada que revocar y esto no falla.
--
-- `pnpm rol-app` vuelve a conceder todo y después revoca esto mismo; `pnpm
-- permisos` comprueba que `audit_log` NO tenga UPDATE ni DELETE.
--
-- Vuelta atrás (misma guarda):
--   DO $$ BEGIN
--     IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'claimmix_app') THEN
--       GRANT UPDATE, DELETE ON public.audit_log TO claimmix_app;
--     END IF;
--   END $$;
-- =============================================================================

DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'claimmix_app') THEN
    REVOKE UPDATE, DELETE ON public.audit_log FROM claimmix_app;
  ELSE
    RAISE NOTICE 'claimmix_app no existe en esta base: nada que revocar';
  END IF;
END $$;
