-- =============================================================================
-- 0042 — Asignación de analista, vencimientos, plan de trabajo y puntaje (B9, B10, B11, B13)
-- =============================================================================
--
-- Cuatro herramientas del equipo para decidir qué caso mira quién y cuándo. Nada
-- de esto sale al asegurado, a los mensajes ni al Core.
--
--   cases.puntaje_complejidad  0 a 100, calculado con los pesos de la aseguradora
--                              donde cambian sus insumos (extracción, campo
--                              confirmado, presupuesto). NULL = sin calcular.
--   cases.vence_en             el próximo vencimiento del caso (fin del día
--                              argentino). NULL = sin plazo corriendo.
--   cases.vence_plazo          qué plazo es (p. ej. art56 o la clave de uno propio).
--
--   tenants.reglas_asignacion  quién recibe los casos según tipo o turno.
--   tenants.plazos             plazos propios, además de los de la Ley 17.418.
--   tenants.plan_por_tipo      checklist de trabajo por tipo de siniestro.
--   tenants.pesos_puntaje      pesos del puntaje de complejidad.
--                              NULL en las cuatro = valores por omisión del código,
--                              así que aplicarla no cambia el comportamiento de nadie.
--
--   case_plan_pasos            una fila por paso del plan de un caso. La clave
--                              primaria (case_id, clave) es la idempotencia: el plan
--                              se crea con ON CONFLICT DO NOTHING y `titulo` es una
--                              foto de cuando se creó, no se regenera si la
--                              configuración cambia.
--
-- RLS forzada con políticas de SELECT, INSERT y UPDATE (`claimmix_tenant_matches`).
-- `claimmix_app` no borra pasos: `scripts/lib/permisos-quitados.mjs` lo declara
-- para que `pnpm permisos` y `create-app-role` lo sostengan.
--
-- Las columnas admiten NULL y no llevan DEFAULT ni CHECK, así que aplicarla no toca
-- filas. Pero el código NO puede llegar antes: Drizzle lista todas las columnas del
-- esquema en cada INSERT y en cada lectura, así que sin ella no entra ningún caso y
-- ninguna ficha abre. Hasta que esté aplicada, /api/health da caído.
--
-- Se aplica A MANO, después de la 0040 y de la 0041, y antes de mergear el PR:
--   1. ep-proud-resonance (la viva, y también la de los secretos DATABASE_URL del CI).
--   2. La rama production de Veltra (STAGING_DATABASE_URL).
--   3. ep-wispy-flower (QA).
-- Identificar cada base por su canal de casos, no por su nombre.
--
-- No siembra datos ni toca filas: los casos existentes quedan sin puntaje ni
-- vencimiento hasta su próximo evento, y sin plan hasta que entren a una etapa
-- que lo crea.
--
-- Vuelta atrás:
--   1. DROP TABLE IF EXISTS public.case_plan_pasos;
--   2. ALTER TABLE public.tenants DROP COLUMN IF EXISTS reglas_asignacion,
--        DROP COLUMN IF EXISTS plazos, DROP COLUMN IF EXISTS plan_por_tipo,
--        DROP COLUMN IF EXISTS pesos_puntaje;
--   3. ALTER TABLE public.cases DROP COLUMN IF EXISTS puntaje_complejidad,
--        DROP COLUMN IF EXISTS vence_en, DROP COLUMN IF EXISTS vence_plazo;
--   4. node scripts/migrate.mjs --env <VAR> --forget 0042
-- =============================================================================

ALTER TABLE public.cases ADD COLUMN IF NOT EXISTS puntaje_complejidad smallint;
ALTER TABLE public.cases ADD COLUMN IF NOT EXISTS vence_en timestamptz;
ALTER TABLE public.cases ADD COLUMN IF NOT EXISTS vence_plazo text;

ALTER TABLE public.tenants ADD COLUMN IF NOT EXISTS reglas_asignacion jsonb;
ALTER TABLE public.tenants ADD COLUMN IF NOT EXISTS plazos jsonb;
ALTER TABLE public.tenants ADD COLUMN IF NOT EXISTS plan_por_tipo jsonb;
ALTER TABLE public.tenants ADD COLUMN IF NOT EXISTS pesos_puntaje jsonb;

CREATE TABLE IF NOT EXISTS public.case_plan_pasos (
  case_id    uuid        NOT NULL REFERENCES public.cases(id) ON DELETE CASCADE,
  tenant_id  uuid        NOT NULL,
  clave      text        NOT NULL,
  titulo     text        NOT NULL,
  orden      smallint    NOT NULL,
  auto       text,
  hecho_en   timestamptz,
  hecho_por  uuid        REFERENCES public.users(id) ON DELETE SET NULL,
  origen     text,
  created_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (case_id, clave)
);

ALTER TABLE public.case_plan_pasos ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.case_plan_pasos FORCE ROW LEVEL SECURITY;

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_policies
     WHERE schemaname = 'public' AND tablename = 'case_plan_pasos'
       AND policyname = 'claimmix_tenant_isolation_select'
  ) THEN
    CREATE POLICY claimmix_tenant_isolation_select ON public.case_plan_pasos
      FOR SELECT USING (public.claimmix_tenant_matches(tenant_id));
  END IF;

  IF NOT EXISTS (
    SELECT 1 FROM pg_policies
     WHERE schemaname = 'public' AND tablename = 'case_plan_pasos'
       AND policyname = 'claimmix_tenant_isolation_insert'
  ) THEN
    CREATE POLICY claimmix_tenant_isolation_insert ON public.case_plan_pasos
      FOR INSERT WITH CHECK (public.claimmix_tenant_matches(tenant_id));
  END IF;

  IF NOT EXISTS (
    SELECT 1 FROM pg_policies
     WHERE schemaname = 'public' AND tablename = 'case_plan_pasos'
       AND policyname = 'claimmix_tenant_isolation_update'
  ) THEN
    CREATE POLICY claimmix_tenant_isolation_update ON public.case_plan_pasos
      FOR UPDATE USING (public.claimmix_tenant_matches(tenant_id))
      WITH CHECK (public.claimmix_tenant_matches(tenant_id));
  END IF;
END $$;

DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'claimmix_app') THEN
    GRANT SELECT, INSERT, UPDATE ON public.case_plan_pasos TO claimmix_app;
    REVOKE DELETE, TRUNCATE ON public.case_plan_pasos FROM claimmix_app;
  ELSE
    RAISE NOTICE 'claimmix_app no existe en esta base: nada que otorgar';
  END IF;
END $$;

COMMENT ON COLUMN public.cases.puntaje_complejidad IS
  'Puntaje de complejidad de 0 a 100, sólo para el equipo. Se recalcula donde cambian sus insumos. NULL = sin calcular.';
COMMENT ON COLUMN public.cases.vence_en IS
  'Próximo vencimiento del caso, a fin del día argentino, sólo para el equipo. NULL = sin plazo corriendo.';
COMMENT ON COLUMN public.cases.vence_plazo IS
  'Clave del plazo que fija vence_en (art56 o un plazo propio de la aseguradora), sólo para el equipo.';
COMMENT ON COLUMN public.tenants.reglas_asignacion IS
  'Reglas de asignación automática de analista por tipo o turno. NULL = no asigna a nadie.';
COMMENT ON COLUMN public.tenants.plazos IS
  'Plazos propios de la aseguradora, además de los legales. NULL = sólo los legales.';
COMMENT ON COLUMN public.tenants.plan_por_tipo IS
  'Checklist de trabajo por tipo de siniestro. NULL = el plan por omisión del código.';
COMMENT ON COLUMN public.tenants.pesos_puntaje IS
  'Pesos del puntaje de complejidad. NULL = los pesos por omisión del código.';
COMMENT ON TABLE public.case_plan_pasos IS
  'Pasos del plan de trabajo de un caso, sólo para el equipo. La clave primaria es la idempotencia y titulo es una foto de la configuración al crear el plan. Sin DELETE para claimmix_app.';
