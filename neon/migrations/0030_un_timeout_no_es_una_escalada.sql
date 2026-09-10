-- =============================================================================
-- 0030 — Un timeout del proveedor no es una escalada
-- =============================================================================
--
-- Cuando Vertex no contesta a tiempo, el worker escala el caso:
--
--     GeminiExtractionError{code:"TIMEOUT"} → escalateCase(..., "provider_error")
--                                           → status = 'escalado'
--
-- Y `escalado` NO está en la lista de estados desde los que el worker puede
-- arrancar, ni lo barre `reap-stuck`, que sólo mira `procesando` y `recibido`.
-- O sea que un timeout de treinta segundos deja al denunciante sin respuesta y
-- exige que una persona toque «Re-analizar».
--
-- Pasó en el ensayo del post-deploy del 10/09: `choque-completo`, turno 4,
-- `esperaba 1 respuesta(s), hubo 0`, dos corridas seguidas. El producto se
-- comportó como estaba escrito; lo que está mal es lo que está escrito.
--
-- ── Por qué un contador y no reintentar para siempre ────────────────────────
--
-- Un timeout es transitorio por definición y merece otro intento. Pero
-- `extraction_pending` no distingue «se cayó una vez» de «este caso rompe
-- siempre», y un mensaje que siempre agota el plazo —uno enorme, un adjunto que
-- el modelo no puede leer— se reintentaría en cada corrida del barrido, para
-- siempre, pagando una llamada cada vez.
--
-- Tres intentos y después sí escala, que es el mismo tope que usa
-- `gmail_poll_state.pendientes` para lo mismo, y el mismo que la 0028 le puso a
-- las miradas por adjunto.
--
-- Las filas viejas arrancan en 0: se comportan como hasta ahora hasta agotar
-- sus tres.
-- =============================================================================

ALTER TABLE public.cases
  ADD COLUMN IF NOT EXISTS intentos_de_extraccion smallint NOT NULL DEFAULT 0;

COMMENT ON COLUMN public.cases.intentos_de_extraccion IS
  'Cuántas veces se reintentó la extracción tras un timeout del proveedor. Tope en el código (MAX_REINTENTOS_POR_TIMEOUT); pasado eso el caso escala.';
