-- =============================================================================
-- 0052 — Que borrar casos no recorra agent_runs entera por cada mensaje
-- =============================================================================
--
-- Cuando se borra un caso, la cascada llega a claim_messages, y por cada mensaje
-- la integridad referencial corre, en cada tabla que lo apunta:
--
--     update agent_runs set claim_message_id = null where claim_message_id = $1
--
-- agent_runs sólo tenía índices por (case_id, created_at) y (tenant_id,
-- created_at), así que cada mensaje era un Seq Scan de una tabla que crece una
-- fila por corrida y trae jsonb grandes. Cien casos con mil mensajes son mil
-- recorridos dentro de un solo batch. training_examples tiene lo mismo con sus
-- tres FK: los dos índices que ya tiene arrancan por tenant_id y la RI busca
-- sólo por la columna de la FK.
--
-- La RI no pasa por RLS y compara uuid con uuid, así que estos índices sí los usa.
-- Las columnas que pueden ser nulas llevan índice parcial, como el de
-- claim_attachments: las filas sin FK nunca se buscan.
--
-- Sin CONCURRENTLY por lo mismo que la 0020: migrar-bases aplica cada archivo
-- como un bloque. Es aditiva, no toca datos ni políticas, y se puede repetir.
--
-- Ningún código la necesita, pero la plantilla pasa a esperar la 52 y /api/health
-- marca desfase hasta que esté en todas. Aplicarla A MANO antes de mergear, con
-- `node scripts/migrate.mjs --apply` por TCP, en este orden:
--   1. ep-wispy-flower (QA, QA_DATABASE_URL).
--   2. ep-proud-resonance (la viva, y también la de los secretos DATABASE_URL del CI).
--   3. La rama production de Veltra (STAGING_DATABASE_URL, sólo para ci.yml).
--   4. `node scripts/migrar-bases.mjs --env prd`: control de prd, la rama ensayo y
--      las bases t_<hex>.
-- Identificar cada base por su canal de casos, no por su nombre.

CREATE INDEX IF NOT EXISTS idx_agent_runs_claim_message
  ON public.agent_runs (claim_message_id)
  WHERE claim_message_id IS NOT NULL;

CREATE INDEX IF NOT EXISTS idx_training_examples_case
  ON public.training_examples (case_id)
  WHERE case_id IS NOT NULL;

CREATE INDEX IF NOT EXISTS idx_training_examples_claim_message
  ON public.training_examples (claim_message_id)
  WHERE claim_message_id IS NOT NULL;

CREATE INDEX IF NOT EXISTS idx_training_examples_run
  ON public.training_examples (agent_run_id);
