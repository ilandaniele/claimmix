-- =============================================================================
-- 0035 — Estados de liquidación: en_liquidacion, pagado, rechazado (B25)
-- =============================================================================
--
-- Después de la entrega a la aseguradora el caso no tenía dónde seguir: sin
-- conector de Core configurado, quedaba para siempre en `listo_para_core`.
-- Una persona con permiso ahora lo mueve a mano a `en_liquidacion`, y de ahí a
-- `pagado`, `rechazado` o `cerrado` (`SALIDAS_A_MANO` en `src/core/case/fsm.ts`).
--
-- Sólo cambia el CHECK. Las fechas no llevan columna propia: cada cambio queda
-- con la suya en `audit_log` (`case.status_changed`), y `pagado` y `rechazado`,
-- que son un cierre, guardan además la suya en `closed_at`. Por eso el código
-- puede llegar antes que la migración sin romper la ingesta: lo único que
-- falla hasta aplicarla es marcar un estado nuevo (23514, el CHECK viejo).
--
-- Se aplica A MANO, en este orden y antes de mergear el PR:
--   1. STAGING (y la base del E2E, si es otra).
--   2. QA.
--   3. Producción.
--
-- Antes de aplicar, confirmar el nombre del CHECK en cada base:
--   select conname, pg_get_constraintdef(oid) from pg_constraint
--    where conrelid = 'cases'::regclass and contype = 'c';
-- Si no se llama `cases_status_check`, el DROP de abajo no lo encuentra y el
-- ADD deja dos CHECK: parar y ajustar el nombre.
--
-- No siembra datos de prueba ni toca filas.
--
-- Vuelta atrás:
--   1. Pasar a mano las filas que estén en un estado nuevo a uno de los trece
--      de antes; si queda alguna, el CHECK de abajo no se puede restaurar.
--   2. Restaurar el CHECK con los trece valores de `0001_init.sql`
--      (DROP CONSTRAINT IF EXISTS cases_status_check, y ADD CONSTRAINT).
--   3. node scripts/migrate.mjs --env <VAR> --forget 0035
-- =============================================================================

ALTER TABLE public.cases DROP CONSTRAINT IF EXISTS cases_status_check;

ALTER TABLE public.cases
  ADD CONSTRAINT cases_status_check CHECK (status IN (
    'procesando',
    'listo',
    'esperando',
    'escalado',
    'cerrado',
    'recibido',
    'info_faltante',
    'confirmacion_pendiente',
    'requiere_especialista',
    'listo_para_core',
    'enviado_a_core',
    'error_core',
    'no_relevante',
    'en_liquidacion',
    'pagado',
    'rechazado'
  ));
