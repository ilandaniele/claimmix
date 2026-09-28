-- =============================================================================
-- 0034 — Avisos de casos urgentes por aseguradora, no una sola lista global
-- =============================================================================
--
-- `SPECIALIST_ALERT_EMAILS` es una única variable de entorno: sirve nada más
-- para el tenant principal, y ninguna otra aseguradora puede cargar su propia
-- lista de avisos. Esta columna guarda la lista de cada tenant; vacía, sigue
-- la regla de siempre por roles (y la variable, sólo como respaldo del tenant
-- principal). La carga un admin en /configuracion (E10).
--
-- Todo tenant arranca vacío (`DEFAULT '{}'`), así que aplicar esto antes de
-- desplegar el código es seguro: nada lee la columna todavía.
--
-- `claimmix_app` ya tiene SELECT/INSERT/UPDATE/DELETE sobre todas las tablas
-- (`scripts/create-app-role.mts`), y `tenants` no tiene RLS (`0018`), así que
-- no hace falta ningún grant ni política nueva.
--
-- Vuelta atrás:
--   1. Revertir el código, o dejarlo: tolera la columna ausente (lee `[]`,
--      escribe 400 con el mensaje de la migración).
--   2. ALTER TABLE public.tenants DROP COLUMN IF EXISTS specialist_alert_emails;
--   3. node scripts/migrate.mjs --env <VAR> --forget 0034
-- =============================================================================

ALTER TABLE public.tenants
  ADD COLUMN IF NOT EXISTS specialist_alert_emails text[] NOT NULL DEFAULT '{}'::text[];

COMMENT ON COLUMN public.tenants.specialist_alert_emails IS
  'Destinatarios de los avisos de casos derivados a especialista. Vacío: regla por roles (y SPECIALIST_ALERT_EMAILS sólo para el tenant principal). La edita un admin en /configuracion.';
