-- =============================================================================
-- 0038 — Mensaje tardío: qué dijo la persona después de que el agente terminó (B3)
-- =============================================================================
--
-- Cuando alguien escribe sobre un caso que el agente ya cerró, el mensaje queda
-- «Para responder» y nadie sabe qué pide hasta abrirlo. El worker ahora lo
-- clasifica y guarda en el caso:
--   cases.mensaje_tardio_de       el claim_messages.id que se clasificó; es la
--                                 reserva que impide clasificar dos veces.
--   cases.mensaje_tardio_tipo     novedad_mismo_siniestro | siniestro_nuevo |
--                                 consulta_estado | otro (NULL = sin clasificar).
--   cases.mensaje_tardio_resumen  una línea segura: sin contactos ni números
--                                 que no estén en el caso.
--   cases.mensaje_tardio_reservado_en  cuándo se tomó la reserva: mientras
--                                 está viva, otra corrida no clasifica ni
--                                 avisa el mismo mensaje.
--
-- Las cuatro admiten NULL y no llevan DEFAULT, CHECK ni FK, así que aplicarla no
-- toca filas. Pero el código NO puede llegar antes: al marcar un caso para
-- responder se escriben estas columnas y la bandeja y la ficha las leen.
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
--   1. ALTER TABLE public.cases DROP COLUMN IF EXISTS de las cuatro columnas.
--   2. node scripts/migrate.mjs --env <VAR> --forget 0038
-- =============================================================================

ALTER TABLE public.cases ADD COLUMN IF NOT EXISTS mensaje_tardio_de uuid;
ALTER TABLE public.cases ADD COLUMN IF NOT EXISTS mensaje_tardio_tipo text;
ALTER TABLE public.cases ADD COLUMN IF NOT EXISTS mensaje_tardio_resumen text;
ALTER TABLE public.cases ADD COLUMN IF NOT EXISTS mensaje_tardio_reservado_en timestamptz;
