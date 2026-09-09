-- =============================================================================
-- 0028 — Un adjunto no se mira para siempre
-- =============================================================================
--
-- `reconcileAttachments` corre en CADA mensaje entrante. Trae los adjuntos que
-- todavía no coincidieron con ningún documento —`matched_doc_key IS NULL`— y
-- por cada uno llama a Gemini con la imagen entera adentro del prompt, en
-- serie. El propio archivo llama a eso «la llamada más cara que hace el
-- producto».
--
-- El problema es qué pasa cuando el modelo NO reconoce nada, que es el
-- comportamiento conservador que el archivo pide a propósito: la fila se queda
-- con `matched_doc_key` en NULL, así que el mensaje siguiente vuelve a
-- ofrecerla, y el siguiente, y el siguiente. Se paga una llamada de visión por
-- archivo por mensaje, sin techo, para siempre.
--
-- No alcanza con marcarlo «no reconocido» y listo: `identifyDocument` recibe
-- los documentos que TODAVÍA faltan, así que una foto que no clasificó cuando
-- faltaban dos documentos puede clasificar más adelante, cuando la lista
-- cambió. Cerrar la puerta en el primer intento perdería esos.
--
-- Un contador acota el gasto sin perder esa chance: tres miradas por archivo,
-- y después se deja de preguntar. Si un analista quiere insistir, tiene el
-- archivo en la pantalla.
--
-- Las filas viejas arrancan en 0, o sea que se comportan como hasta ahora
-- hasta agotar sus tres.
-- =============================================================================

ALTER TABLE public.claim_attachments
  ADD COLUMN IF NOT EXISTS intentos_de_identificacion integer NOT NULL DEFAULT 0;

COMMENT ON COLUMN public.claim_attachments.intentos_de_identificacion IS
  'Cuantas veces se le pregunto al modelo que documento es. Tope en el codigo: sin esto, cada mensaje entrante pagaba una llamada de vision por cada adjunto sin clasificar, para siempre.';
