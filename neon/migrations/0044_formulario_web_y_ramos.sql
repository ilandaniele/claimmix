-- =============================================================================
-- 0044 — Formulario web público, tipos de siniestro por inquilino y canal «web» (B16-B17-B26)
-- =============================================================================
--
--   formulario_web      una fila por inquilino: el enlace público de su formulario
--                       (`slug`, nunca el id interno) y si está encendido. Nace
--                       apagado. Sin DELETE para `claimmix_app`: apagar es un
--                       UPDATE de `activo`; borrar la fila liberaría el enlace
--                       sin rastro y otro inquilino podría tomarlo.
--   tenant_claim_types  los tipos de siniestro propios de cada inquilino, encima
--                       de los del código: clave estable (`clave`), nombre en
--                       las dos lenguas, y los documentos y datos que pide. Si
--                       un tipo del inquilino tiene la misma clave que uno del
--                       código, gana el del inquilino sólo para los documentos.
--   cases.claim_type / agent_custom_fields.claim_type
--                       dejan de ser lista cerrada: el CHECK pasa a exigir sólo
--                       el formato de la clave. Sumar un ramo al código o crear
--                       uno del inquilino ya no pide otra migración.
--   cases.channel       suma 'web' (formulario público). Se recrea el CHECK sólo
--                       si el vigente todavía no lo nombra.
--
-- Nada cambia en las tablas de cases, tenants ni required_docs_config: las
-- columnas nuevas viven en tablas aparte para que una base sin migrar no falle
-- con 42703 sobre la lectura de casos (sólo /api/health lo avisa).
--
-- RLS forzada en las dos tablas, con las cuatro políticas de aislamiento. El
-- formulario público resuelve el slug SIN inquilino (es la única consulta que
-- no puede tenerlo, y está marcada `// sin-inquilino:` en el código) y recién
-- después entra al inquilino con `enTenantVarias`.
--
-- El código NO puede llegar antes: la ruta pública, la pantalla de tipos y el
-- alta de casos por «web» dependen de estas tablas y del CHECK de canal. Hasta
-- que esté aplicada, /api/health da degradado con «migración 0044 pendiente».
--
-- Se aplica A MANO, en este orden y antes de mergear el PR:
--   1. ep-proud-resonance (la viva, y también la de los secretos DATABASE_URL del CI).
--   2. La rama production de Veltra (STAGING_DATABASE_URL).
--   3. ep-wispy-flower (QA).
-- Identificar cada base por su canal de casos, no por su nombre.
--
-- Los CHECK de `claim_type` se agregan sólo si faltan; los existentes (listas
-- cerradas de 0007 y 0008) se sueltan por su nombre, que se confirma antes con
--   SELECT conname FROM pg_constraint WHERE conrelid = 'public.cases'::regclass AND contype = 'c';
--
-- No siembra datos ni toca filas: las dos tablas nacen vacías y ningún inquilino
-- tiene el formulario encendido hasta que lo pida desde /agente.
--
-- Vuelta atrás:
--   1. DROP TABLE IF EXISTS public.formulario_web;
--   2. DROP TABLE IF EXISTS public.tenant_claim_types;
--   3. Volver a la lista cerrada de claim_type (0008) y de channel (0001) sólo
--      si ningún caso usa un ramo o el canal 'web'; si no, dejarlas como están.
--   4. node scripts/migrate.mjs --env <VAR> --forget 0044
-- =============================================================================

CREATE TABLE IF NOT EXISTS public.formulario_web (
  tenant_id  uuid        PRIMARY KEY REFERENCES public.tenants(id) ON DELETE CASCADE,
  slug       text        NOT NULL,
  activo     boolean     NOT NULL DEFAULT false,
  updated_at timestamptz NOT NULL DEFAULT now(),
  updated_by uuid,
  CONSTRAINT formulario_web_slug_formato CHECK (
    slug ~ '^[a-z0-9][a-z0-9-]{2,38}[a-z0-9]$'
    AND slug !~ '^[0-9a-f]{8}-'
  )
);

CREATE UNIQUE INDEX IF NOT EXISTS idx_formulario_web_slug
  ON public.formulario_web (slug);

CREATE TABLE IF NOT EXISTS public.tenant_claim_types (
  tenant_id  uuid        NOT NULL REFERENCES public.tenants(id) ON DELETE CASCADE,
  clave      text        NOT NULL,
  nombre_es  text        NOT NULL,
  nombre_en  text        NOT NULL,
  documentos text[]      NOT NULL DEFAULT '{}',
  datos      text[]      NOT NULL DEFAULT '{}',
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (tenant_id, clave),
  CONSTRAINT tenant_claim_types_clave_formato CHECK (clave ~ '^[a-z][a-z0-9_]{1,39}$'),
  CONSTRAINT tenant_claim_types_nombre_es_largo CHECK (char_length(nombre_es) BETWEEN 1 AND 60),
  CONSTRAINT tenant_claim_types_nombre_en_largo CHECK (char_length(nombre_en) BETWEEN 1 AND 60),
  CONSTRAINT tenant_claim_types_documentos_tope CHECK (cardinality(documentos) <= 20),
  CONSTRAINT tenant_claim_types_datos_tope CHECK (cardinality(datos) <= 20)
);

ALTER TABLE public.formulario_web ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.formulario_web FORCE ROW LEVEL SECURITY;
ALTER TABLE public.tenant_claim_types ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.tenant_claim_types FORCE ROW LEVEL SECURITY;

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_policies
     WHERE schemaname = 'public' AND tablename = 'formulario_web'
       AND policyname = 'claimmix_tenant_isolation_select'
  ) THEN
    CREATE POLICY claimmix_tenant_isolation_select ON public.formulario_web
      FOR SELECT USING (public.claimmix_tenant_matches(tenant_id));
  END IF;

  IF NOT EXISTS (
    SELECT 1 FROM pg_policies
     WHERE schemaname = 'public' AND tablename = 'formulario_web'
       AND policyname = 'claimmix_tenant_isolation_insert'
  ) THEN
    CREATE POLICY claimmix_tenant_isolation_insert ON public.formulario_web
      FOR INSERT WITH CHECK (public.claimmix_tenant_matches(tenant_id));
  END IF;

  IF NOT EXISTS (
    SELECT 1 FROM pg_policies
     WHERE schemaname = 'public' AND tablename = 'formulario_web'
       AND policyname = 'claimmix_tenant_isolation_update'
  ) THEN
    CREATE POLICY claimmix_tenant_isolation_update ON public.formulario_web
      FOR UPDATE USING (public.claimmix_tenant_matches(tenant_id))
      WITH CHECK (public.claimmix_tenant_matches(tenant_id));
  END IF;

  IF NOT EXISTS (
    SELECT 1 FROM pg_policies
     WHERE schemaname = 'public' AND tablename = 'formulario_web'
       AND policyname = 'claimmix_tenant_isolation_delete'
  ) THEN
    CREATE POLICY claimmix_tenant_isolation_delete ON public.formulario_web
      FOR DELETE USING (public.claimmix_tenant_matches(tenant_id));
  END IF;
END $$;

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_policies
     WHERE schemaname = 'public' AND tablename = 'tenant_claim_types'
       AND policyname = 'claimmix_tenant_isolation_select'
  ) THEN
    CREATE POLICY claimmix_tenant_isolation_select ON public.tenant_claim_types
      FOR SELECT USING (public.claimmix_tenant_matches(tenant_id));
  END IF;

  IF NOT EXISTS (
    SELECT 1 FROM pg_policies
     WHERE schemaname = 'public' AND tablename = 'tenant_claim_types'
       AND policyname = 'claimmix_tenant_isolation_insert'
  ) THEN
    CREATE POLICY claimmix_tenant_isolation_insert ON public.tenant_claim_types
      FOR INSERT WITH CHECK (public.claimmix_tenant_matches(tenant_id));
  END IF;

  IF NOT EXISTS (
    SELECT 1 FROM pg_policies
     WHERE schemaname = 'public' AND tablename = 'tenant_claim_types'
       AND policyname = 'claimmix_tenant_isolation_update'
  ) THEN
    CREATE POLICY claimmix_tenant_isolation_update ON public.tenant_claim_types
      FOR UPDATE USING (public.claimmix_tenant_matches(tenant_id))
      WITH CHECK (public.claimmix_tenant_matches(tenant_id));
  END IF;

  IF NOT EXISTS (
    SELECT 1 FROM pg_policies
     WHERE schemaname = 'public' AND tablename = 'tenant_claim_types'
       AND policyname = 'claimmix_tenant_isolation_delete'
  ) THEN
    CREATE POLICY claimmix_tenant_isolation_delete ON public.tenant_claim_types
      FOR DELETE USING (public.claimmix_tenant_matches(tenant_id));
  END IF;
END $$;

DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'claimmix_app') THEN
    GRANT SELECT, INSERT, UPDATE ON public.formulario_web TO claimmix_app;
    REVOKE DELETE, TRUNCATE ON public.formulario_web FROM claimmix_app;
    GRANT SELECT, INSERT, UPDATE, DELETE ON public.tenant_claim_types TO claimmix_app;
  ELSE
    RAISE NOTICE 'claimmix_app no existe en esta base: nada que otorgar';
  END IF;
END $$;

DO $$
DECLARE
  r record;
BEGIN
  FOR r IN
    SELECT c.conrelid::regclass AS tabla, c.conname
      FROM pg_constraint c
     WHERE c.contype = 'c'
       AND c.conrelid IN ('public.cases'::regclass, 'public.agent_custom_fields'::regclass)
       AND pg_get_constraintdef(c.oid) ILIKE '%claim_type%'
       AND pg_get_constraintdef(c.oid) ILIKE '%choque%'
  LOOP
    EXECUTE format('ALTER TABLE %s DROP CONSTRAINT %I', r.tabla, r.conname);
  END LOOP;
END $$;

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
     WHERE conrelid = 'public.cases'::regclass AND conname = 'cases_claim_type_formato'
  ) THEN
    ALTER TABLE public.cases
      ADD CONSTRAINT cases_claim_type_formato
      CHECK (claim_type IS NULL OR claim_type ~ '^[a-z][a-z0-9_]{1,39}$');
  END IF;

  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
     WHERE conrelid = 'public.agent_custom_fields'::regclass
       AND conname = 'agent_custom_fields_claim_type_formato'
  ) THEN
    ALTER TABLE public.agent_custom_fields
      ADD CONSTRAINT agent_custom_fields_claim_type_formato
      CHECK (claim_type IS NULL OR claim_type ~ '^[a-z][a-z0-9_]{1,39}$');
  END IF;
END $$;

DO $$
DECLARE
  vigente text;
BEGIN
  SELECT c.conname INTO vigente
    FROM pg_constraint c
   WHERE c.conrelid = 'public.cases'::regclass
     AND c.contype = 'c'
     AND pg_get_constraintdef(c.oid) ILIKE '%channel%'
     AND pg_get_constraintdef(c.oid) ILIKE '%whatsapp_sim%'
   LIMIT 1;

  IF vigente IS NOT NULL THEN
    IF EXISTS (
      SELECT 1 FROM pg_constraint c
       WHERE c.conrelid = 'public.cases'::regclass AND c.conname = vigente
         AND pg_get_constraintdef(c.oid) NOT ILIKE '%''web''%'
    ) THEN
      EXECUTE format('ALTER TABLE public.cases DROP CONSTRAINT %I', vigente);
      ALTER TABLE public.cases
        ADD CONSTRAINT cases_channel_check
        CHECK (channel IN ('email_sim', 'email', 'whatsapp_sim', 'whatsapp', 'web'));
    END IF;
  ELSIF NOT EXISTS (
    SELECT 1 FROM pg_constraint
     WHERE conrelid = 'public.cases'::regclass AND conname = 'cases_channel_check'
  ) THEN
    ALTER TABLE public.cases
      ADD CONSTRAINT cases_channel_check
      CHECK (channel IN ('email_sim', 'email', 'whatsapp_sim', 'whatsapp', 'web'));
  END IF;
END $$;

COMMENT ON TABLE public.formulario_web IS
  'Enlace público y encendido del formulario web de cada inquilino (B17). El slug es propio y nunca el id interno. Sin DELETE para claimmix_app: apagar es un UPDATE.';
COMMENT ON TABLE public.tenant_claim_types IS
  'Tipos de siniestro propios de cada inquilino (B26): nombre en las dos lenguas y los documentos y datos que pide. Si la clave coincide con un ramo del código, los documentos son los del inquilino.';
