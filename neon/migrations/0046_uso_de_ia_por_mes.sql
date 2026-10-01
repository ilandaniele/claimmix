-- =============================================================================
-- 0046 — El uso de IA por mes, para que el tablero de métricas no recorra la historia
-- =============================================================================
--
--   claimmix_mes_argentino(timestamptz)
--                         el mes (primer día, tipo date) de un instante, en hora
--                         argentina. Es la misma cuenta que hace el código con
--                         `diaArgentino(ahora)`: un registro de las 02:30 UTC del
--                         1 de octubre todavía es de septiembre.
--   ai_usage_mensual      un acumulador: una fila por (inquilino, mes, usuario,
--                         modelo) con las llamadas, los tokens y el costo. El
--                         tablero de /metricas lee de acá y no de `ai_usage`,
--                         cuyo recorrido crece con toda la historia del
--                         inquilino y no lo ayuda ningún índice (0023 y 0024):
--                         hoy son cuatro lecturas de ~20 ms cada una dentro de un
--                         lote que tiene que costar ~10 ms. `user_id` es nulo
--                         cuando el usuario se borró (ON DELETE SET NULL de
--                         `ai_usage`) y la unicidad lo trata como un valor más
--                         (NULLS NOT DISTINCT, Postgres 15 o más). Sin FK a
--                         propósito, igual que `ai_usage.tenant_id`: el
--                         acumulador no puede frenar un borrado.
--   trg_ai_usage_mensual  el trigger que lo mantiene. Después de cada INSERT,
--                         UPDATE o DELETE de `ai_usage` suma la fila nueva y resta
--                         la vieja. Un UPDATE de `user_id` a NULL (el usuario se
--                         borró) o de `model` mueve la cuenta de una fila a otra.
--                         Un DELETE sólo resta y nunca inserta.
--
-- El trigger corre con SECURITY DEFINER —es el primero del repo— porque
-- `claimmix_app` sólo LEE el acumulador: si pudiera escribirlo, un bug o una
-- inyección podría falsear lo que ve el tablero. La función fija el
-- search_path, no tiene EXECUTE para PUBLIC y toma el inquilino SIEMPRE de
-- NEW/OLD, nunca de `current_setting('claimmix.tenant_id')`: una cascada de
-- `users` (ON DELETE SET NULL) corre sin inquilino en la sesión. Como RLS está
-- forzada, el dueño de la función tiene que saltearla (BYPASSRLS): el primer
-- paso de esta migración corta si el rol que la corre no puede.
--
-- Qué NO atrapa el trigger:
--   · TRUNCATE de `ai_usage` (un trigger por fila no lo ve),
--   · ALTER TABLE ... DISABLE TRIGGER o `session_replication_role = replica`,
--   · restaurar una copia sólo de `ai_usage`.
-- Se recompone volviendo a aplicar ESTA migración entera, que es idempotente:
--   node scripts/migrate.mjs --env <VAR> --forget 0046 --apply
--   node scripts/migrate.mjs --env <VAR> --apply
-- No se corre suelta la sección de «Backfill»: sin el LOCK ni la transacción (el
-- runner corre todo el archivo en una), el DELETE queda confirmado aunque el
-- INSERT choque con una llamada a la IA que entró en el medio (23505), y el
-- acumulador queda vacío o a medias. Aplicarla entera además recrea el trigger,
-- que es lo que falta si estaba deshabilitado.
-- `pnpm load` compara los dos lados en cada corrida y baja a rojo si divergen.
--
-- Costo en la escritura: cada llamada a la IA que graba en `ai_usage` suma un
-- upsert sobre la fila del mes. Si el trigger fallara, fallaría también el
-- INSERT de `ai_usage` (hoy el presupuesto sólo registra el error y sigue, y ningún
-- otro chequeo lo nota: lo prueba contra Postgres de verdad la sección 6 de
-- `scripts/prove-data-layer.mts`, `pnpm capa-datos`, en CI o con --escribe).
-- Las llamadas concurrentes del mismo inquilino, usuario y modelo se
-- serializan en esa fila: son transacciones de un solo INSERT, así que el
-- bloqueo dura microsegundos.
--
-- El código NO puede llegar antes: el tablero lee `ai_usage_mensual`, así que sin
-- la tabla /metricas falla (42P01) y /api/health da caído con «faltan:
-- ai_usage_mensual». Ninguna otra pantalla la lee.
--
-- Se aplica A MANO, con `node scripts/migrate.mjs --apply` por TCP (todo el
-- archivo en una sola transacción: el LOCK de abajo tiene que durar hasta el
-- backfill) y ANTES de desplegar el código, en este orden:
--   1. ep-wispy-flower (QA): primero, para probar el trigger con casos de
--      verdad antes de tocar una base que tenga clientes. En las 0043 y 0045 la
--      viva iba primera; acá no, porque esta migración escribe en el camino de
--      un INSERT que hoy anda.
--   2. ep-proud-resonance (la viva, y también la de los secretos DATABASE_URL del CI).
--   3. La rama production de Veltra (STAGING_DATABASE_URL).
-- Identificar cada base por su canal de casos, no por su nombre.
--
-- ATENCIÓN: el LOCK de abajo frena las escrituras de `ai_usage` mientras se arma
-- el acumulador. Las lecturas siguen andando, y las llamadas a la IA que
-- escriben en ese rato esperan (no se pierden). La tabla es chica y el
-- recorrido dura segundos: igual conviene un horario tranquilo. Sin CONCURRENTLY
-- porque el runner corre todo en una sola transacción y CONCURRENTLY no puede.
--
-- Verificar después de aplicarla (tiene que dar 0; corre como dueño, ve todo):
--   SELECT count(*) FROM (
--     (SELECT tenant_id, public.claimmix_mes_argentino(created_at), user_id, model,
--             count(*), sum(prompt_tokens), sum(completion_tokens), sum(cost_usd)
--        FROM public.ai_usage GROUP BY 1, 2, 3, 4
--      EXCEPT
--      SELECT tenant_id, mes, user_id, model, calls, prompt_tokens, completion_tokens, cost_usd
--        FROM public.ai_usage_mensual WHERE calls > 0)
--     UNION ALL
--     (SELECT tenant_id, mes, user_id, model, calls, prompt_tokens, completion_tokens, cost_usd
--        FROM public.ai_usage_mensual WHERE calls > 0
--      EXCEPT
--      SELECT tenant_id, public.claimmix_mes_argentino(created_at), user_id, model,
--             count(*), sum(prompt_tokens), sum(completion_tokens), sum(cost_usd)
--        FROM public.ai_usage GROUP BY 1, 2, 3, 4)
--   ) d;
--
-- No toca `ai_usage`: sólo lo lee. No siembra datos de prueba.
--
-- Vuelta atrás (primero el código: volver a leer `ai_usage` en getTenantKpis):
--   1. DROP TRIGGER IF EXISTS trg_ai_usage_mensual ON public.ai_usage;
--   2. DROP FUNCTION IF EXISTS public.claimmix_ai_usage_mensual_sumar();
--   3. DROP TABLE IF EXISTS public.ai_usage_mensual;
--   4. DROP FUNCTION IF EXISTS public.claimmix_mes_argentino(timestamptz);
--   5. node scripts/migrate.mjs --env <VAR> --forget 0046 --apply
-- =============================================================================

-- El dueño de la función tiene que saltear RLS (el acumulador la fuerza y una
-- cascada corre sin inquilino): si no puede, el trigger fallaría en producción.
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_roles
     WHERE rolname = current_user AND (rolbypassrls OR rolsuper)
  ) THEN
    RAISE EXCEPTION 'La 0046 la tiene que correr un rol con BYPASSRLS (el dueño de las migraciones): el trigger SECURITY DEFINER lo necesita para escribir ai_usage_mensual cuando una cascada corre sin inquilino.';
  END IF;
END $$;

CREATE OR REPLACE FUNCTION public.claimmix_mes_argentino(ts timestamptz)
RETURNS date
LANGUAGE sql
IMMUTABLE
AS $$
  SELECT date_trunc('month', ts AT TIME ZONE 'America/Argentina/Buenos_Aires')::date
$$;

CREATE TABLE IF NOT EXISTS public.ai_usage_mensual (
  tenant_id         uuid          NOT NULL,
  mes               date          NOT NULL,
  user_id           uuid,
  model             text          NOT NULL,
  calls             bigint        NOT NULL DEFAULT 0,
  prompt_tokens     bigint        NOT NULL DEFAULT 0,
  completion_tokens bigint        NOT NULL DEFAULT 0,
  cost_usd          numeric       NOT NULL DEFAULT 0,
  CONSTRAINT ai_usage_mensual_clave UNIQUE NULLS NOT DISTINCT (tenant_id, mes, user_id, model)
);

ALTER TABLE public.ai_usage_mensual ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.ai_usage_mensual FORCE ROW LEVEL SECURITY;

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_policies
     WHERE schemaname = 'public' AND tablename = 'ai_usage_mensual'
       AND policyname = 'claimmix_tenant_isolation'
  ) THEN
    CREATE POLICY claimmix_tenant_isolation ON public.ai_usage_mensual
      USING (public.claimmix_tenant_matches(tenant_id))
      WITH CHECK (public.claimmix_tenant_matches(tenant_id));
  END IF;
END $$;

DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'claimmix_app') THEN
    GRANT SELECT ON public.ai_usage_mensual TO claimmix_app;
    REVOKE INSERT, UPDATE, DELETE, TRUNCATE ON public.ai_usage_mensual FROM claimmix_app;
  ELSE
    RAISE NOTICE 'claimmix_app no existe en esta base: nada que otorgar';
  END IF;
END $$;

CREATE OR REPLACE FUNCTION public.claimmix_ai_usage_mensual_sumar()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, public
AS $$
BEGIN
  IF TG_OP IN ('UPDATE', 'DELETE') THEN
    UPDATE public.ai_usage_mensual
       SET calls = calls - 1,
           prompt_tokens = prompt_tokens - OLD.prompt_tokens,
           completion_tokens = completion_tokens - OLD.completion_tokens,
           cost_usd = cost_usd - OLD.cost_usd
     WHERE tenant_id = OLD.tenant_id
       AND mes = public.claimmix_mes_argentino(OLD.created_at)
       AND user_id IS NOT DISTINCT FROM OLD.user_id
       AND model = OLD.model;
  END IF;

  IF TG_OP IN ('INSERT', 'UPDATE') THEN
    INSERT INTO public.ai_usage_mensual AS m
      (tenant_id, mes, user_id, model, calls, prompt_tokens, completion_tokens, cost_usd)
    VALUES
      (NEW.tenant_id, public.claimmix_mes_argentino(NEW.created_at), NEW.user_id, NEW.model,
       1, NEW.prompt_tokens, NEW.completion_tokens, NEW.cost_usd)
    ON CONFLICT (tenant_id, mes, user_id, model) DO UPDATE
      SET calls = m.calls + 1,
          prompt_tokens = m.prompt_tokens + EXCLUDED.prompt_tokens,
          completion_tokens = m.completion_tokens + EXCLUDED.completion_tokens,
          cost_usd = m.cost_usd + EXCLUDED.cost_usd;
  END IF;

  RETURN NULL;
END
$$;

REVOKE EXECUTE ON FUNCTION public.claimmix_ai_usage_mensual_sumar() FROM PUBLIC;

-- El LOCK va antes del trigger y del backfill y dura hasta el commit: nada se
-- escribe en `ai_usage` entre que se cuenta la historia y que el trigger empieza.
LOCK TABLE public.ai_usage IN SHARE ROW EXCLUSIVE MODE;

DROP TRIGGER IF EXISTS trg_ai_usage_mensual ON public.ai_usage;
CREATE TRIGGER trg_ai_usage_mensual
  AFTER INSERT OR UPDATE OR DELETE ON public.ai_usage
  FOR EACH ROW EXECUTE FUNCTION public.claimmix_ai_usage_mensual_sumar();

-- Backfill. Va después del LOCK y dentro de la misma transacción: no se corre suelto
-- (para recomponer el acumulador se vuelve a aplicar la migración entera, ver arriba).
DELETE FROM public.ai_usage_mensual;

INSERT INTO public.ai_usage_mensual
  (tenant_id, mes, user_id, model, calls, prompt_tokens, completion_tokens, cost_usd)
SELECT tenant_id,
       public.claimmix_mes_argentino(created_at),
       user_id,
       model,
       count(*),
       sum(prompt_tokens),
       sum(completion_tokens),
       sum(cost_usd)
  FROM public.ai_usage
 GROUP BY 1, 2, 3, 4;

COMMENT ON TABLE public.ai_usage_mensual IS
  'Uso de IA acumulado por inquilino, mes (hora argentina), usuario y modelo. Lo mantiene el trigger trg_ai_usage_mensual de ai_usage; claimmix_app sólo lee. Se recompone volviendo a aplicar la 0046 entera (ver su cabecera).';
COMMENT ON FUNCTION public.claimmix_ai_usage_mensual_sumar() IS
  'Trigger de ai_usage: suma la fila nueva y resta la vieja en ai_usage_mensual. SECURITY DEFINER; el inquilino sale de NEW/OLD, nunca de la sesión.';
