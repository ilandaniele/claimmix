-- =============================================================================
-- 0023 — Tres índices que la auditoría encontró faltando
-- =============================================================================
--
-- Ninguno cambia datos ni esquema: son índices. Se pueden borrar sin
-- consecuencias si alguno resulta no valer lo que ocupa.
--
-- 1) El padrón se lista por fecha y no hay por dónde entrar.
--
--    `/clientes` y `/polizas` hacen `tenant_id = X ORDER BY created_at DESC
--    LIMIT 25`. De customers sólo existían idx_customers_tenant_email e
--    idx_customers_tenant_dni, los dos PARCIALES (`WHERE ... IS NOT NULL`) y
--    ordenados por otra columna: para esa consulta no sirve ninguno, y no había
--    ni siquiera un btree sobre tenant_id solo. Queda un Seq Scan del padrón
--    entero más un Sort, para mostrar veinticinco filas. En policies pasa lo
--    mismo: idx_policies_tenant_customer ordena por customer_id.
--
-- 2) El acumulado histórico de uso se lee fila por fila.
--
--    De las nueve consultas de /metricas, la del acumulado es la única sin
--    ventana de tiempo: suma llamadas, tokens y costo de toda la historia del
--    inquilino. idx_ai_usage_tenant_created no incluye las columnas que suma,
--    así que el índice ubica las filas y después hay que ir al heap por cada
--    una. Con INCLUDE, la suma se resuelve dentro del índice.
--
--    Se deja el histórico como está —es lo que la pantalla muestra— y se paga
--    con el índice, en vez de acotarlo a doce meses, que cambiaría el número.
--
-- Qué comprobar después de aplicarla, que es la parte que importa: un índice
-- que el planificador ignora cuesta disco y escrituras a cambio de nada.
--
--     EXPLAIN ANALYZE SELECT * FROM customers WHERE tenant_id = '…'
--       ORDER BY created_at DESC LIMIT 25;
--
-- Tiene que decir Index Scan usando idx_customers_tenant_created, no Seq Scan.
-- =============================================================================

CREATE INDEX IF NOT EXISTS idx_customers_tenant_created
  ON public.customers (tenant_id, created_at DESC);

CREATE INDEX IF NOT EXISTS idx_policies_tenant_created
  ON public.policies (tenant_id, created_at DESC);

CREATE INDEX IF NOT EXISTS idx_ai_usage_tenant_cubridor
  ON public.ai_usage (tenant_id)
  INCLUDE (prompt_tokens, completion_tokens, cost_usd);
