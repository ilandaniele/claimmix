-- Qué documento cerró cada adjunto.
--
-- `unmatchedAttachments` se llama así y devuelve TODOS los adjuntos del caso:
-- no había forma de saber cuál ya había coincidido, porque nada lo guardaba. El
-- nombre era una aspiración.
--
-- El efecto: cada mensaje nuevo vuelve a ofrecerle al modelo las fotos viejas
-- para tapar los documentos que faltan. Medido antes de escribir esto, en 481
-- casos, produjo UNA sola clasificación errónea — y esa fue por otro camino, el
-- del agente diciendo que había «resuelto» la denuncia policial. Así que esto es
-- preventivo y además ahorra llamadas al modelo: con cuatro adjuntos y ocho
-- vueltas, son treinta y dos identificaciones para cuatro archivos.
--
-- La columna es nullable a propósito: las filas que ya están no saben qué
-- cerraron, y nadie puede reconstruirlo. Un adjunto sin marca se sigue
-- ofreciendo, que es el comportamiento de hoy.

ALTER TABLE public.claim_attachments
  ADD COLUMN IF NOT EXISTS matched_doc_key text;

COMMENT ON COLUMN public.claim_attachments.matched_doc_key IS
  'Clave del documento que este adjunto satisfizo, cuando el reconciliador lo identificó. NULL = todavía no coincidió con ninguno.';

-- Para el filtro de `unmatchedAttachments`, que pregunta por los NULL de un caso.
CREATE INDEX IF NOT EXISTS idx_claim_attachments_sin_coincidir
  ON public.claim_attachments (case_id)
  WHERE matched_doc_key IS NULL;
