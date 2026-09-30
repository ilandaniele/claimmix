-- =============================================================================
-- 0045 — SSO por inquilino, cola de purga de adjuntos y índice de cierre (B19)
-- =============================================================================
--
--   sso_settings          una fila por inquilino: el IdP OIDC de su empresa
--                         (issuer, client_id, secreto CIFRADO con el mismo
--                         aes-256-gcm de core_sync_settings), el dominio de mail
--                         que lo habilita y si se exige. Nace apagado. El dominio
--                         sólo vale cuando `dominio_verificado_en` no es nulo, y
--                         un dominio verificado es de un solo inquilino (índice
--                         único parcial). Apagar o dejar de exigir es un UPDATE.
--   adjuntos_por_purgar   la cola del borrado diferido de adjuntos en R2. Al
--                         borrar un caso, `cases` arrastra en cascada nueve tablas
--                         hijas y con ellas el único puntero al objeto
--                         (`claim_attachments.storage_path`). La cola lo guarda
--                         antes, en el mismo lote que el DELETE, con un período
--                         de gracia (`purgar_despues`). Sin FK a propósito: el
--                         caso ya no existe y la cola tiene que sobrevivir al
--                         borrado del inquilino. La vacía el barrido diario con
--                         el rol dueño; `claimmix_app` sólo encola (SELECT e
--                         INSERT). Cancelar una purga es un UPDATE del dueño.
--                         Sólo se agrega: el path NO es único. Borrar dos veces el
--                         mismo objeto (dos adjuntos que lo comparten) suma otra
--                         fila, y manda la más nueva: así un segundo borrado vuelve
--                         a armar la gracia y no lo pisa una fila vieja, cancelada o
--                         ya vencida. `claimmix_app` no puede actualizar una fila
--                         para renovarla, y por eso no hay ON CONFLICT.
--   idx_cases_closed_at   la retención de 5 años lista casos cerrados hace más de
--                         N años; sin este índice es un recorrido de toda la tabla.
--
-- Nada cambia en las tablas que ya existen salvo el índice. Las dos tablas nacen
-- vacías: nadie tiene SSO ni purga pendiente hasta que lo pida o borre un caso.
--
-- RLS forzada en las dos tablas, con la política `claimmix_tenant_isolation`
-- como las vecinas. La búsqueda por dominio del login (todavía no hay inquilino)
-- y el barrido de purga van por el rol dueño y están marcados `// sin-inquilino:`
-- en el código.
--
-- El código NO puede llegar antes: borrar un caso encola en `adjuntos_por_purgar`
-- dentro del mismo lote, así que sin la tabla el borrado falla (42P01). Hasta que
-- esté aplicada, /api/health da caído con «faltan: adjuntos_por_purgar». El SSO
-- tolera la falta de `sso_settings` (42P01 y 42703): queda apagado.
--
-- Se aplica A MANO, en este orden y antes del check:
--   1. ep-proud-resonance (la viva, y también la de los secretos DATABASE_URL del CI).
--   2. La rama production de Veltra (STAGING_DATABASE_URL).
--   3. ep-wispy-flower (QA).
-- Identificar cada base por su canal de casos, no por su nombre.
--
-- ATENCIÓN: CREATE INDEX sin CONCURRENTLY toma un lock sobre `cases` que frena las
-- escrituras mientras se crea. La tabla es chica; conviene aplicarla en un horario
-- tranquilo. Sin CONCURRENTLY porque el runner de migraciones corre todo en una
-- sola transacción y CONCURRENTLY no puede.
--
-- No siembra datos ni toca filas.
--
-- Vuelta atrás:
--   1. DROP INDEX IF EXISTS public.idx_cases_closed_at;
--   2. DROP TABLE IF EXISTS public.adjuntos_por_purgar;  -- sólo si está vacía o ya purgada
--   3. DROP TABLE IF EXISTS public.sso_settings;
--   4. node scripts/migrate.mjs --env <VAR> --forget 0045
--
-- Salidas de emergencia del dueño, sin desplegar nada:
--   · dejar de exigir SSO:  UPDATE public.sso_settings SET exigir = false WHERE tenant_id = '<id>';
--   · cancelar una purga:   UPDATE public.adjuntos_por_purgar SET purgar_despues = NULL WHERE case_id = '<id>';
-- =============================================================================

CREATE TABLE IF NOT EXISTS public.sso_settings (
  tenant_id             uuid        PRIMARY KEY REFERENCES public.tenants(id) ON DELETE CASCADE,
  issuer                text,
  client_id             text,
  client_secret_cifrado text,
  dominio               text,
  dominio_verificado_en timestamptz,
  activo                boolean     NOT NULL DEFAULT false,
  exigir                boolean     NOT NULL DEFAULT false,
  creado_en             timestamptz NOT NULL DEFAULT now(),
  actualizado_en        timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT sso_settings_dominio_minuscula CHECK (dominio = lower(dominio))
);

CREATE UNIQUE INDEX IF NOT EXISTS idx_sso_settings_dominio_verificado
  ON public.sso_settings (dominio)
  WHERE dominio_verificado_en IS NOT NULL;

CREATE TABLE IF NOT EXISTS public.adjuntos_por_purgar (
  id              uuid        PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id       uuid        NOT NULL,
  case_id         uuid        NOT NULL,
  storage_path    text        NOT NULL,
  encolado_en     timestamptz NOT NULL DEFAULT now(),
  purgar_despues  timestamptz,
  purgado_en      timestamptz,
  intentos        smallint    NOT NULL DEFAULT 0,
  ultimo_error    text
);

CREATE INDEX IF NOT EXISTS idx_adjuntos_por_purgar_pendientes
  ON public.adjuntos_por_purgar (purgar_despues)
  WHERE purgado_en IS NULL;

CREATE INDEX IF NOT EXISTS idx_adjuntos_por_purgar_path
  ON public.adjuntos_por_purgar (storage_path, encolado_en);

CREATE INDEX IF NOT EXISTS idx_cases_closed_at
  ON public.cases (closed_at)
  WHERE closed_at IS NOT NULL;

ALTER TABLE public.sso_settings ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.sso_settings FORCE ROW LEVEL SECURITY;
ALTER TABLE public.adjuntos_por_purgar ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.adjuntos_por_purgar FORCE ROW LEVEL SECURITY;

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_policies
     WHERE schemaname = 'public' AND tablename = 'sso_settings'
       AND policyname = 'claimmix_tenant_isolation'
  ) THEN
    CREATE POLICY claimmix_tenant_isolation ON public.sso_settings
      USING (public.claimmix_tenant_matches(tenant_id))
      WITH CHECK (public.claimmix_tenant_matches(tenant_id));
  END IF;

  IF NOT EXISTS (
    SELECT 1 FROM pg_policies
     WHERE schemaname = 'public' AND tablename = 'adjuntos_por_purgar'
       AND policyname = 'claimmix_tenant_isolation'
  ) THEN
    CREATE POLICY claimmix_tenant_isolation ON public.adjuntos_por_purgar
      USING (public.claimmix_tenant_matches(tenant_id))
      WITH CHECK (public.claimmix_tenant_matches(tenant_id));
  END IF;
END $$;

DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'claimmix_app') THEN
    GRANT SELECT, INSERT, UPDATE, DELETE ON public.sso_settings TO claimmix_app;
    GRANT SELECT, INSERT ON public.adjuntos_por_purgar TO claimmix_app;
    REVOKE UPDATE, DELETE, TRUNCATE ON public.adjuntos_por_purgar FROM claimmix_app;
  ELSE
    RAISE NOTICE 'claimmix_app no existe en esta base: nada que otorgar';
  END IF;
END $$;

COMMENT ON TABLE public.sso_settings IS
  'SSO OIDC por inquilino (B19): issuer, client_id, secreto cifrado aes-256-gcm y el dominio de mail que lo habilita. El dominio sólo vale verificado por TXT. exigir deja sin login por contraseña a ese dominio.';
COMMENT ON TABLE public.adjuntos_por_purgar IS
  'Cola del borrado diferido de adjuntos en R2 (B19). Sin FK: sobrevive al caso y al inquilino. claimmix_app sólo encola; la vacía el barrido diario con el rol dueño. Cancelar = UPDATE del dueño.';
