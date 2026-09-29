-- =============================================================================
-- 0037 — Lectura de adjuntos: resumen del caso y de cada archivo (B1, B7, B8)
-- =============================================================================
--
-- El modelo ya lee las fotos, los PDF y las notas de voz dentro de la misma
-- llamada de extracción. Lo que devuelve por archivo se guarda acá:
--   cases.resumen                 el `summary` de la extracción, ya filtrado.
--   claim_attachments.resumen     una línea sobre qué es el archivo.
--   claim_attachments.util        false cuando no sirve para el reclamo.
--   claim_attachments.datos       lo que el modelo leyó del documento (tipo,
--                                 fecha, patente, dni, nombre, lugar, provincia).
--   claim_attachments.metadatos   lo que medimos nosotros al recibirlo (firma,
--                                 páginas, segundos, fecha y GPS de la foto).
--
-- Todas las columnas admiten NULL y no llevan DEFAULT, así que aplicarla no
-- toca filas. Pero el código NO puede llegar antes: la ingesta escribe
-- `metadatos` al guardar cada adjunto y la ficha y el worker leen el resto.
-- Hasta que esté aplicada, /api/health da caído.
--
-- Se aplica A MANO, en este orden y antes de mergear el PR:
--   1. STAGING (y la base del E2E, si es otra).
--   2. QA.
--   3. Producción.
--
-- No siembra datos de prueba ni toca filas.
--
-- Vuelta atrás:
--   1. ALTER TABLE ... DROP COLUMN IF EXISTS de las cinco columnas.
--   2. node scripts/migrate.mjs --env <VAR> --forget 0037
-- =============================================================================

ALTER TABLE public.cases ADD COLUMN IF NOT EXISTS resumen text;

ALTER TABLE public.claim_attachments ADD COLUMN IF NOT EXISTS resumen text;
ALTER TABLE public.claim_attachments ADD COLUMN IF NOT EXISTS util boolean;
ALTER TABLE public.claim_attachments ADD COLUMN IF NOT EXISTS datos jsonb;
ALTER TABLE public.claim_attachments ADD COLUMN IF NOT EXISTS metadatos jsonb;
