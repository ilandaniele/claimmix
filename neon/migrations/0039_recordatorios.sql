-- =============================================================================
-- 0039 — Recordatorios de lo que falta y aviso de cierre (B4)
-- =============================================================================
--
-- Un caso en `info_faltante` esperaba callado hasta que el barrido lo cerraba
-- por abandono. Ahora cada aseguradora puede pedir que se repita el pedido a
-- las N horas sin respuesta:
--   tenants.recordatorio_horas  0 a 2 horas, ascendentes (p. ej. {48,120}).
--                               Vacío = apagado, y es el valor por omisión:
--                               aplicarla no le manda nada a nadie.
--   case_recordatorios          una fila por etapa ya decidida. La clave
--                               primaria (case_id, ancla, etapa) es la
--                               idempotencia: el barrido inserta ANTES de
--                               mandar, y el que no inserta no manda. La etapa
--                               9 con ancla epoch es el aviso de cierre.
--
-- RLS forzada con políticas de SELECT e INSERT (`claimmix_tenant_matches`).
-- `claimmix_app` recibe sólo SELECT e INSERT: una etapa gastada no se reescribe
-- ni se borra, porque eso la volvería a mandar. `scripts/lib/permisos-quitados.mjs`
-- lo declara para que `pnpm permisos` y `create-app-role` lo sostengan.
--
-- El código NO puede llegar antes: la configuración de alertas y el cron leen
-- estas columnas. Hasta que esté aplicada, /api/health da caído.
--
-- Se aplica A MANO, en este orden y antes de mergear el PR:
--   1. STAGING (y la base del E2E, si es otra).
--   2. QA.
--   3. Producción.
--
-- No siembra datos ni toca filas: todas las aseguradoras quedan apagadas.
--
-- Vuelta atrás:
--   1. DROP TABLE IF EXISTS public.case_recordatorios;
--   2. ALTER TABLE public.tenants DROP COLUMN IF EXISTS recordatorio_horas;
--   3. node scripts/migrate.mjs --env <VAR> --forget 0039
-- =============================================================================

ALTER TABLE public.tenants ADD COLUMN IF NOT EXISTS recordatorio_horas integer[] NOT NULL DEFAULT '{}';

CREATE TABLE IF NOT EXISTS public.case_recordatorios (
  case_id    uuid        NOT NULL REFERENCES public.cases(id) ON DELETE CASCADE,
  tenant_id  uuid        NOT NULL,
  ancla      timestamptz NOT NULL,
  etapa      smallint    NOT NULL,
  resultado  text        NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (case_id, ancla, etapa)
);

ALTER TABLE public.case_recordatorios ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.case_recordatorios FORCE ROW LEVEL SECURITY;

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_policies
     WHERE schemaname = 'public' AND tablename = 'case_recordatorios'
       AND policyname = 'claimmix_tenant_isolation_select'
  ) THEN
    CREATE POLICY claimmix_tenant_isolation_select ON public.case_recordatorios
      FOR SELECT USING (public.claimmix_tenant_matches(tenant_id));
  END IF;

  IF NOT EXISTS (
    SELECT 1 FROM pg_policies
     WHERE schemaname = 'public' AND tablename = 'case_recordatorios'
       AND policyname = 'claimmix_tenant_isolation_insert'
  ) THEN
    CREATE POLICY claimmix_tenant_isolation_insert ON public.case_recordatorios
      FOR INSERT WITH CHECK (public.claimmix_tenant_matches(tenant_id));
  END IF;
END $$;

DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'claimmix_app') THEN
    GRANT SELECT, INSERT ON public.case_recordatorios TO claimmix_app;
    REVOKE UPDATE, DELETE, TRUNCATE ON public.case_recordatorios FROM claimmix_app;
  ELSE
    RAISE NOTICE 'claimmix_app no existe en esta base: nada que otorgar';
  END IF;
END $$;

COMMENT ON TABLE public.case_recordatorios IS
  'Etapas de recordatorio y aviso de cierre ya decididas por el barrido. La clave primaria es la idempotencia. Sin UPDATE ni DELETE para claimmix_app.';
