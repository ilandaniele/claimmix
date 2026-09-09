-- =============================================================================
-- 0027 — Dos columnas que todavía dicen «openai», de un proveedor que ya no está
-- =============================================================================
--
-- OpenAI salió del producto: no hay extractor, `OPENAI_API_KEY` no se lee en
-- ningún archivo, y la extracción es Gemini por Vertex. Pero el esquema seguía
-- ofreciéndolo como si fuera configuración viva.
--
-- ── 1) model_training_jobs.provider — el default apunta a un muerto ─────────
--
--   provider text NOT NULL DEFAULT 'openai'
--
-- Y las dos filas que existen dicen `vertex_ai_gemini`, porque es lo que
-- escribe `createVertexAiTuningDraft`, que es el único camino que crea
-- trabajos. O sea que el default no describe ni lo que hay ni lo que se
-- escribe: describe lo que se escribía en 2026.
--
-- No es cosmético. `vertex-ai-fine-tuning.ts` tira `WRONG_PROVIDER` para
-- cualquier trabajo cuyo provider no sea `vertex_ai_gemini` —en tres lugares
-- distintos—, así que una fila que tomara el default quedaría inservible para
-- todos los pasos siguientes: no se puede arrancar, ni sincronizar, ni activar.
-- El default se vuelve una trampa para el próximo INSERT que se escriba sin
-- pensar en la columna.
--
-- ── 2) tenant_ai_settings.openai_model — configuración de mentira ───────────
--
--   openai_model text NOT NULL DEFAULT 'gpt-4o-mini'
--
-- No la lee NADIE: `grep openai_model` sobre src/ no devuelve un solo
-- consumidor. La única fila que existe tiene el default, o sea que no hay
-- ningún dato que perder: el valor guardado es 'gpt-4o-mini' y nunca lo
-- escribió el producto.
--
-- Su hermana `openai_fine_tuning_job_id` SE QUEDA, y en el esquema TypeScript
-- está escrito por qué: guarda el nombre del recurso del job de Vertex, el
-- nombre quedó de antes, y renombrarla pide una migración sobre datos que sí se
-- usan. Ésta no tiene esa excusa, y sin una nota al lado parece configuración
-- que alguien podría cambiar esperando que pase algo.
--
-- Los CHECK que aceptan 'openai' en `tenant_ai_settings` se dejan como están:
-- son permisivos, no incorrectos, y apretarlos sobre una columna con datos
-- vivos es otra conversación.
-- =============================================================================

ALTER TABLE public.model_training_jobs
  ALTER COLUMN provider SET DEFAULT 'vertex_ai_gemini';

ALTER TABLE public.tenant_ai_settings
  DROP COLUMN IF EXISTS openai_model;
