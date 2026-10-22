-- =============================================================================
-- 0053 — Dar de baja a un usuario de verdad
-- =============================================================================
--
-- Hasta acá el panel de usuarios sólo podía cerrar las sesiones abiertas: la
-- persona volvía a entrar con su contraseña, con Google o con el SSO, porque su
-- fila en users seguía viva. users.dado_de_baja_en marca la baja (null = activo).
-- Con la columna puesta, filaDeUsuario no devuelve la fila, el gancho de sesión de
-- Better Auth rechaza cualquier ingreso nuevo y DELETE /api/admin/users/[id] la
-- llena y cierra las sesiones en el mismo paso.
--
-- users tiene permisos por tabla para claimmix_app: la columna nueva no pide GRANT.
-- Es aditiva, no toca datos ni políticas, y se puede repetir.
--
-- El código la lee en cada pedido y Drizzle la nombra en cada INSERT, y el espejo
-- la copia a la base del cliente: sin ella nadie entra. Aplicarla A MANO ANTES de
-- mergear, con `node scripts/migrate.mjs --apply` por TCP, en este orden:
--   1. ep-wispy-flower (QA, QA_DATABASE_URL).
--   2. ep-proud-resonance (la viva, y también la de los secretos DATABASE_URL del CI).
--   3. La rama production de Veltra (STAGING_DATABASE_URL, sólo para ci.yml).
--   4. `node scripts/migrar-bases.mjs --env prd`: control de prd, la rama ensayo y
--      las bases t_<hex>.
-- Identificar cada base por su canal de casos, no por su nombre.
--
-- Vuelta atrás: ALTER TABLE public.users DROP COLUMN IF EXISTS dado_de_baja_en;

ALTER TABLE public.users
  ADD COLUMN IF NOT EXISTS dado_de_baja_en timestamptz;
