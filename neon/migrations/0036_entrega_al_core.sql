-- =============================================================================
-- 0036 — Entrega al Core: webhook firmado de salida y clave de lectura (B5)
-- =============================================================================
--
-- El botón «Enviar al sistema central» no tenía a dónde mandar: sin cliente
-- real, contestaba 501 y el caso salía a mano. Esta tabla guarda, por
-- aseguradora, a dónde se entrega (`webhook_url`), con qué se firma
-- (`signing_secret_enc`, cifrado con `src/lib/security/cifrado.ts`) y si está
-- prendido. También el hash de la clave con la que el Core lee por
-- `/api/v1/cases` (`api_key_hash`, sha256 en hex; la clave nunca se guarda).
--
-- Una fila por tenant. Sin fila, o con `enabled = false`, todo sigue como hoy:
-- el botón no aparece y la ruta contesta 501 sin escribir nada. Por eso el
-- código puede llegar antes que la migración: mientras falte, la pantalla del
-- caso y la de configuración lo toleran (42P01) y la API de lectura contesta
-- 401 a cualquier clave.
--
-- RLS forzada con la misma política que el resto (`claimmix_tenant_matches`).
-- `claimmix_app` recibe SELECT/INSERT/UPDATE por los permisos por omisión, y
-- DELETE se le quita a propósito: apagar la entrega es `enabled = false` y
-- revocar la clave es poner el hash en NULL, y las dos cosas quedan en
-- `audit_log`, cosa que una fila borrada no hace. `scripts/lib/permisos-quitados.mjs` lo declara para que
-- `pnpm permisos` y `create-app-role` lo sostengan.
--
-- Se aplica A MANO, en este orden y antes de mergear el PR:
--   1. STAGING (y la base del E2E, si es otra).
--   2. QA.
--   3. Producción.
--
-- No siembra datos ni toca filas de otras tablas: cada aseguradora carga la
-- suya desde /configuracion.
--
-- Vuelta atrás:
--   1. Revertir el código, o dejarlo: tolera la tabla ausente.
--   2. DROP TABLE IF EXISTS public.core_sync_settings;
--   3. node scripts/migrate.mjs --env <VAR> --forget 0036
-- =============================================================================

CREATE TABLE IF NOT EXISTS public.core_sync_settings (
  tenant_id          uuid PRIMARY KEY REFERENCES public.tenants(id) ON DELETE CASCADE,
  webhook_url        text NULL,
  signing_secret_enc text NULL,
  enabled            boolean NOT NULL DEFAULT false,
  api_key_hash       text NULL,
  api_key_prefix     text NULL,
  updated_at         timestamptz NOT NULL DEFAULT now(),
  updated_by         uuid NULL
);

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
     WHERE conrelid = 'public.core_sync_settings'::regclass
       AND conname = 'core_sync_settings_webhook_https'
  ) THEN
    ALTER TABLE public.core_sync_settings
      ADD CONSTRAINT core_sync_settings_webhook_https
      CHECK (webhook_url IS NULL OR (webhook_url LIKE 'https://%' AND length(webhook_url) <= 2048));
  END IF;

  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
     WHERE conrelid = 'public.core_sync_settings'::regclass
       AND conname = 'core_sync_settings_api_key_hash_hex'
  ) THEN
    ALTER TABLE public.core_sync_settings
      ADD CONSTRAINT core_sync_settings_api_key_hash_hex
      CHECK (api_key_hash IS NULL OR api_key_hash ~ '^[0-9a-f]{64}$');
  END IF;

  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
     WHERE conrelid = 'public.core_sync_settings'::regclass
       AND conname = 'core_sync_settings_activo_completo'
  ) THEN
    ALTER TABLE public.core_sync_settings
      ADD CONSTRAINT core_sync_settings_activo_completo
      CHECK (NOT enabled OR (webhook_url IS NOT NULL AND signing_secret_enc IS NOT NULL));
  END IF;
END $$;

-- Una clave es de un solo tenant: dos filas con el mismo hash no pueden existir.
CREATE UNIQUE INDEX IF NOT EXISTS core_sync_settings_api_key_hash_key
  ON public.core_sync_settings (api_key_hash)
  WHERE api_key_hash IS NOT NULL;

ALTER TABLE public.core_sync_settings ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.core_sync_settings FORCE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS claimmix_tenant_isolation ON public.core_sync_settings;
CREATE POLICY claimmix_tenant_isolation ON public.core_sync_settings
  USING (public.claimmix_tenant_matches(tenant_id))
  WITH CHECK (public.claimmix_tenant_matches(tenant_id));

DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'claimmix_app') THEN
    GRANT SELECT, INSERT, UPDATE ON public.core_sync_settings TO claimmix_app;
    REVOKE DELETE, TRUNCATE ON public.core_sync_settings FROM claimmix_app;
  ELSE
    RAISE NOTICE 'claimmix_app no existe en esta base: nada que otorgar';
  END IF;
END $$;

COMMENT ON TABLE public.core_sync_settings IS
  'Entrega al Core por aseguradora: webhook firmado de salida y hash de la clave de /api/v1. El secreto va cifrado; la clave nunca se guarda. Sin DELETE para claimmix_app.';
