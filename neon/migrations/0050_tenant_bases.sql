-- =============================================================================
-- 0050 — tenant_bases: el estado de la base de cada inquilino
-- =============================================================================
--
-- Con BASE_POR_CLIENTE=1 cada aseguradora vive en su propia base, t_<32 hex del
-- id> (mismo proyecto y mismo compute que la de control). Esta migración pone, en
-- control, el registro de esas bases:
--
--   1. public.tenant_bases: una fila por inquilino con el estado de su base
--      (creando, lista, fallida, borrada), la versión de la cadena que tiene
--      aplicada, los intentos, el último error y tomada_at, que hace de lease
--      para que dos workflows no preparen la misma base a la vez.
--   2. public.schema_migrations: el registro de migraciones que ya arma
--      migrate.mjs. Acá sólo se asegura que exista (IF NOT EXISTS, con la misma
--      forma) y se le cierra el acceso a claimmix_app: lo lee y lo escribe el
--      rol dueño. No se siembra: cada fila lleva el checksum del archivo y sólo
--      lo conoce quien lo aplica.
--
-- Sin fila en tenant_bases un inquilino no tiene base propia: con la bandera
-- apagada nadie la lee. Un inquilino sin fila se detecta con un LEFT JOIN y se
-- reintenta. Ni claimmix_crear_inquilino (0048) ni nada de lo que ya existe se
-- toca.
--
-- Por qué tiene RLS forzada y una política que siempre dice que no: tenant_bases
-- lleva tenant_id y `pnpm permisos` y `pnpm tenancy` exigen una política en toda
-- tabla con esa columna. Esta es una tabla de control, no del inquilino: la
-- escribe y la lee sólo el rol dueño (BYPASSRLS), así que ninguna política le
-- da paso a nadie más.
--
-- Aditiva e idempotente. Hay que aplicarla A MANO ANTES de mergear el código que
-- la usa, con `node scripts/migrate.mjs --apply` por TCP, en este orden:
--   1. ep-wispy-flower (QA, QA_DATABASE_URL).
--   2. ep-proud-resonance (la viva, y también la de los secretos DATABASE_URL del CI).
--   3. La rama production de Veltra (STAGING_DATABASE_URL, sólo para ci.yml).
-- Identificar cada base por su canal de casos, no por su nombre.
-- Después, contra cada base (con DATABASE_URL_APP en el entorno):
--   pnpm permisos && pnpm tenancy
-- Si el CI corre antes de que esté aplicada en la base de los secretos, esos dos
-- chequeos quedan rojos: es el aviso, no un error del código.
--
-- OJO: a diferencia de la columna autoalta de la 0048, el código NO tolera que
-- esta tabla falte. filaDeUsuario hace un LEFT JOIN a tenant_bases en cada
-- pedido, también con la bandera apagada: en una base sin la 0050 todo responde
-- 42P01.
--
-- Vuelta atrás (el registro de migraciones no se borra: es el de migrate.mjs):
--   DROP TABLE IF EXISTS public.tenant_bases;
--   node scripts/migrate.mjs --env <VAR> --forget 0050
-- =============================================================================

-- 1. El estado de la base de cada inquilino
CREATE TABLE IF NOT EXISTS public.tenant_bases (
  tenant_id uuid PRIMARY KEY REFERENCES public.tenants(id) ON DELETE CASCADE,
  estado text NOT NULL CHECK (estado IN ('creando', 'lista', 'fallida', 'borrada')),
  version_migracion integer NOT NULL DEFAULT 0,
  intentos integer NOT NULL DEFAULT 0,
  ultimo_error text,
  tomada_at timestamptz,
  creada_at timestamptz NOT NULL DEFAULT now(),
  lista_at timestamptz
);

-- El reintento busca por estado y por lease vencido.
CREATE INDEX IF NOT EXISTS tenant_bases_por_estado
  ON public.tenant_bases (estado, tomada_at);

ALTER TABLE public.tenant_bases ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.tenant_bases FORCE ROW LEVEL SECURITY;

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_policies
     WHERE schemaname = 'public' AND tablename = 'tenant_bases'
       AND policyname = 'claimmix_solo_dueno'
  ) THEN
    CREATE POLICY claimmix_solo_dueno ON public.tenant_bases
      USING (false)
      WITH CHECK (false);
  END IF;
END $$;

-- 2. El registro de migraciones (la misma forma que lo crea migrate.mjs)
CREATE TABLE IF NOT EXISTS public.schema_migrations (
  version text PRIMARY KEY,
  filename text NOT NULL,
  checksum text NOT NULL,
  applied_at timestamptz NOT NULL DEFAULT now(),
  applied_by text
);

-- 3. Permisos: ninguna de las dos es asunto de la app (sólo si el rol existe en esta base)
REVOKE ALL ON TABLE public.tenant_bases, public.schema_migrations FROM PUBLIC;

DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'claimmix_app') THEN
    REVOKE ALL ON TABLE public.tenant_bases, public.schema_migrations FROM claimmix_app;
  ELSE
    RAISE NOTICE 'claimmix_app no existe en esta base: nada que revocar (corré pnpm rol-app y después pnpm permisos)';
  END IF;
END $$;
