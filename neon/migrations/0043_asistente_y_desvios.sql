-- =============================================================================
-- 0043 — Conversación del asistente por caso y revisión nocturna de desvíos (B12, B22)
-- =============================================================================
--
--   asistente_turnos  la conversación de una persona del equipo con el asistente
--                     sobre UN caso: una fila por mensaje (`rol` user o
--                     assistant). Es privada de quien pregunta: la política de
--                     lectura pide el inquilino Y `claimmix.user_id`, así que ni
--                     otra persona de la misma aseguradora la lee. Sin UPDATE ni
--                     DELETE para `claimmix_app`: un turno no se reescribe; se va
--                     con el caso (ON DELETE CASCADE) o con la persona.
--   case_desvios      lo que la revisión nocturna encontró fuera de lo esperado
--                     (doc pedido y nunca recibido, cierre sin pasar por listo,
--                     derivación sin respuesta, plazo vencido, plan desviado).
--                     La clave primaria (case_id, regla, ancla) es la
--                     idempotencia: el mismo desvío —mismo ancla— se guarda una
--                     sola vez por más veces que corra el barrido. Lo escribe el
--                     barrido con el rol dueño; `claimmix_app` sólo lee.
--   idx_audit_log_trayecto
--                     índice parcial sobre los eventos que marcan el trayecto de
--                     un caso, para el tablero (B14) y la revisión (B22). Plano
--                     y no CONCURRENTLY porque `migrate.mjs` corre cada archivo
--                     en una transacción; si `audit_log` ya es grande, correr
--                     antes a mano el mismo CREATE INDEX con CONCURRENTLY y esta
--                     sentencia lo saltea (IF NOT EXISTS).
--
-- RLS forzada. `claimmix_current_user_id()` lee `claimmix.user_id` igual que
-- `claimmix_current_tenant_id()` lee el inquilino; sin ese contexto la
-- conversación no devuelve nada. `scripts/lib/permisos-quitados.mjs` declara lo
-- que `claimmix_app` no puede para que `pnpm permisos` y `create-app-role` lo
-- sostengan.
--
-- El código NO puede llegar antes: el asistente y la pantalla de desvíos leen
-- estas tablas. Hasta que esté aplicada, /api/health da caído.
--
-- Se aplica A MANO, en este orden y antes de mergear el PR:
--   1. ep-proud-resonance (la viva, y también la de los secretos DATABASE_URL del CI).
--   2. La rama production de Veltra (STAGING_DATABASE_URL).
--   3. ep-wispy-flower (QA).
-- Identificar cada base por su canal de casos, no por su nombre.
--
-- No siembra datos ni toca filas: las tablas nacen vacías, y los desvíos
-- aparecen la primera noche que corra el barrido.
--
-- Vuelta atrás:
--   1. DROP TABLE IF EXISTS public.asistente_turnos;
--   2. DROP TABLE IF EXISTS public.case_desvios;
--   3. DROP FUNCTION IF EXISTS public.claimmix_current_user_id();
--   4. DROP INDEX IF EXISTS public.idx_audit_log_trayecto;
--   5. node scripts/migrate.mjs --env <VAR> --forget 0043
-- =============================================================================

CREATE OR REPLACE FUNCTION public.claimmix_current_user_id()
RETURNS uuid
LANGUAGE sql
STABLE
AS $$
  SELECT NULLIF(current_setting('claimmix.user_id', true), '')::uuid
$$;

CREATE TABLE IF NOT EXISTS public.asistente_turnos (
  id         bigserial   PRIMARY KEY,
  tenant_id  uuid        NOT NULL,
  user_id    uuid        NOT NULL REFERENCES public.users(id) ON DELETE CASCADE,
  case_id    uuid        NOT NULL REFERENCES public.cases(id) ON DELETE CASCADE,
  rol        text        NOT NULL CHECK (rol IN ('user', 'assistant')),
  texto      text        NOT NULL CHECK (char_length(texto) BETWEEN 1 AND 8000),
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_asistente_turnos_hilo
  ON public.asistente_turnos (case_id, user_id, id DESC);

CREATE TABLE IF NOT EXISTS public.case_desvios (
  case_id      uuid        NOT NULL REFERENCES public.cases(id) ON DELETE CASCADE,
  tenant_id    uuid        NOT NULL,
  regla        text        NOT NULL,
  ancla        timestamptz NOT NULL,
  dato         text,
  detectado_en timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (case_id, regla, ancla)
);

CREATE INDEX IF NOT EXISTS idx_case_desvios_tenant_detectado
  ON public.case_desvios (tenant_id, detectado_en DESC);

CREATE INDEX IF NOT EXISTS idx_audit_log_trayecto
  ON public.audit_log (target_id, created_at)
  WHERE target_type = 'case' AND event_type IN (
    'case.status_changed', 'case.assigned', 'case.closed', 'case.ready_confirmed',
    'claim.case_reopened', 'claim.closed_abandoned', 'ai.extraction_complete',
    'ai.extracted', 'core.sync_success', 'core.sync_failed', 'case.marked_answered',
    'case.human_reply', 'case.plan_step', 'claim.request_resent',
    'claim.field_confirmed', 'claim.field_rejected', 'case.re_analyze_triggered',
    'claim.specialist_required', 'claim.specialist_alerted'
  );

ALTER TABLE public.asistente_turnos ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.asistente_turnos FORCE ROW LEVEL SECURITY;
ALTER TABLE public.case_desvios ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.case_desvios FORCE ROW LEVEL SECURITY;

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_policies
     WHERE schemaname = 'public' AND tablename = 'asistente_turnos'
       AND policyname = 'claimmix_tenant_isolation_select'
  ) THEN
    CREATE POLICY claimmix_tenant_isolation_select ON public.asistente_turnos
      FOR SELECT USING (
        public.claimmix_tenant_matches(tenant_id)
        AND user_id = public.claimmix_current_user_id()
      );
  END IF;

  IF NOT EXISTS (
    SELECT 1 FROM pg_policies
     WHERE schemaname = 'public' AND tablename = 'asistente_turnos'
       AND policyname = 'claimmix_tenant_isolation_insert'
  ) THEN
    CREATE POLICY claimmix_tenant_isolation_insert ON public.asistente_turnos
      FOR INSERT WITH CHECK (
        public.claimmix_tenant_matches(tenant_id)
        AND user_id = public.claimmix_current_user_id()
        AND EXISTS (
          SELECT 1 FROM public.cases c
           WHERE c.id = asistente_turnos.case_id AND c.tenant_id = asistente_turnos.tenant_id
        )
      );
  END IF;

  IF NOT EXISTS (
    SELECT 1 FROM pg_policies
     WHERE schemaname = 'public' AND tablename = 'case_desvios'
       AND policyname = 'claimmix_tenant_isolation_select'
  ) THEN
    CREATE POLICY claimmix_tenant_isolation_select ON public.case_desvios
      FOR SELECT USING (public.claimmix_tenant_matches(tenant_id));
  END IF;
END $$;

DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'claimmix_app') THEN
    GRANT SELECT, INSERT ON public.asistente_turnos TO claimmix_app;
    REVOKE UPDATE, DELETE, TRUNCATE ON public.asistente_turnos FROM claimmix_app;
    GRANT USAGE, SELECT ON SEQUENCE public.asistente_turnos_id_seq TO claimmix_app;
    GRANT SELECT ON public.case_desvios TO claimmix_app;
    REVOKE INSERT, UPDATE, DELETE, TRUNCATE ON public.case_desvios FROM claimmix_app;
  ELSE
    RAISE NOTICE 'claimmix_app no existe en esta base: nada que otorgar';
  END IF;
END $$;

COMMENT ON TABLE public.asistente_turnos IS
  'Conversación privada de una persona del equipo con el asistente sobre un caso (B12). Sólo la lee quien la escribió. Sin UPDATE ni DELETE para claimmix_app.';
COMMENT ON TABLE public.case_desvios IS
  'Desvíos que encontró la revisión nocturna (B22), sólo para el equipo. La clave primaria (caso, regla, ancla) es la idempotencia. La escribe el barrido con el rol dueño; claimmix_app sólo lee.';
