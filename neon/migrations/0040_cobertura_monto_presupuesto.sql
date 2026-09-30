-- =============================================================================
-- 0040 — Cobertura contra la póliza, monto estimado y presupuesto del taller
--        (B6, B23, B21)
-- =============================================================================
--
-- La ficha del caso ahora dice, sólo para el equipo, si la póliza cubre el
-- siniestro, cuánto cuesta más o menos y qué dice el presupuesto del taller.
-- Nada de esto sale al asegurado.
--
--   policies.coberturas            las coberturas contratadas (código, suma
--                                  asegurada, franquicia), leídas del PDF de
--                                  condiciones. NULL = sin leer.
--   policies.ambito_territorial    nacional | mercosur | provincias, con la lista.
--   policies.condiciones_path      dónde quedó el PDF de condiciones en el bucket.
--   policies.condiciones_leidas_en cuándo se leyó bien; NULL = subido, sin leer.
--   cases.monto_estimado           rango orientativo {minimo, maximo, moneda,
--                                  origen: tabla | presupuesto}.
--   tenants.rangos_de_monto        la tabla de montos propia de la aseguradora;
--                                  NULL = la tabla por defecto.
--   claim_attachments.lectura_presupuesto  los ítems del presupuesto y sus alertas.
--
-- Las siete admiten NULL y no llevan DEFAULT, CHECK ni FK, así que aplicarla no
-- toca filas. Pero el código NO puede llegar antes: Drizzle lista todas las
-- columnas del esquema en cada INSERT, así que sin ellas no entra ningún caso
-- ni ningún adjunto, y la ficha las lee. Hasta que esté aplicada, /api/health
-- da caído.
--
-- Se aplica A MANO, en este orden y antes de mergear el PR:
--   1. STAGING (y la base del E2E, si es otra).
--   2. QA.
--   3. Producción.
--
-- No siembra datos de prueba ni toca filas.
--
-- Vuelta atrás:
--   1. ALTER TABLE … DROP COLUMN IF EXISTS de las siete columnas.
--   2. node scripts/migrate.mjs --env <VAR> --forget 0040
-- =============================================================================

ALTER TABLE public.policies ADD COLUMN IF NOT EXISTS coberturas jsonb;
ALTER TABLE public.policies ADD COLUMN IF NOT EXISTS ambito_territorial jsonb;
ALTER TABLE public.policies ADD COLUMN IF NOT EXISTS condiciones_path text;
ALTER TABLE public.policies ADD COLUMN IF NOT EXISTS condiciones_leidas_en timestamptz;
ALTER TABLE public.cases ADD COLUMN IF NOT EXISTS monto_estimado jsonb;
ALTER TABLE public.tenants ADD COLUMN IF NOT EXISTS rangos_de_monto jsonb;
ALTER TABLE public.claim_attachments ADD COLUMN IF NOT EXISTS lectura_presupuesto jsonb;
