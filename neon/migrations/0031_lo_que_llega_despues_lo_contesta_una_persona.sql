-- =============================================================================
-- 0031 — Lo que llega después de que el agente terminó lo contesta una persona
-- =============================================================================
--
-- Cuando el agente ya terminó con un caso —lo dejó listo, lo derivó o lo
-- escaló—, un mensaje nuevo de la misma persona no lo contesta el agente. Hasta
-- ahora ese mensaje se guardaba y nadie se enteraba.
--
-- `para_responder_desde` marca el caso para la sección «Para responder» de la
-- bandeja: guarda cuándo llegó el primero de esos mensajes y se limpia cuando
-- alguien marca el caso como respondido o lo re-analiza.
--
-- El índice es parcial porque casi todos los casos tienen la columna en null:
-- la sección lee sólo los marcados, por tenant y del más reciente al más viejo.
--
-- La política de fila de `cases` y los grants por tabla de `claimmix_app`
-- cubren la columna nueva sin tocar nada más.
-- =============================================================================

ALTER TABLE public.cases ADD COLUMN IF NOT EXISTS para_responder_desde timestamptz;

CREATE INDEX IF NOT EXISTS idx_cases_para_responder
  ON public.cases (tenant_id, para_responder_desde DESC)
  WHERE para_responder_desde IS NOT NULL;
