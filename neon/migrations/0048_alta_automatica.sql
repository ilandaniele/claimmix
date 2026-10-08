-- =============================================================================
-- 0048 — Alta automática: inquilinos con RLS, whatsapp_numeros y la función que crea inquilinos
-- =============================================================================
--
-- Una aseguradora se da de alta sola. Esta migración pone el piso en la base:
--
--   1. tenants.autoalta marca los inquilinos que creó el alta automática. Los
--      demás nunca cuentan como «prueba», aunque lleven piloto/trial por defecto.
--   2. whatsapp_numeros guarda el número de cada inquilino y su estado.
--   3. tenants pasa a tener RLS forzada. claimmix_app pierde INSERT y DELETE y
--      conserva UPDATE sólo sobre las siete columnas de configuración.
--   4. claimmix_app pierde el acceso a las credenciales de Better Auth: account
--      queda legible sólo en (provider_id, user_id), session y verification
--      quedan cerradas, y "user" deja de ser escribible.
--   5. claimmix_crear_inquilino es la única forma en que la app crea un inquilino.
--
-- Por qué account no se cierra entera: cambiarEstadoSso (exigir SSO) y
-- duenoDelMail preguntan por provider_id y user_id de account con este rol. Esas
-- dos columnas no guardan ningún secreto; el hash de la contraseña y los tokens
-- (password, access_token, refresh_token, id_token) siguen sin poder leerse.
--
-- Por qué "user" sigue siendo legible: los cruces por mail (kpis, aviso al
-- especialista, admin/users) lo leen con este rol. Better Auth y cerrarSesiones
-- escriben con el dueño (`db`), no con claimmix_app.
--
-- Aditiva e idempotente. Hay que aplicarla A MANO ANTES de mergear el código que
-- la usa, con `node scripts/migrate.mjs --apply` por TCP, en este orden:
--   1. ep-wispy-flower (QA).
--   2. ep-proud-resonance (la viva, y también la de los secretos DATABASE_URL del CI).
--   3. La rama production de Veltra (STAGING_DATABASE_URL).
-- Identificar cada base por su canal de casos, no por su nombre.
-- Después, contra cada base (con DATABASE_URL_APP en el entorno):
--   pnpm permisos && pnpm tenancy
-- Si el CI corre antes de que esté aplicada en la base de los secretos, esos dos
-- chequeos quedan rojos: es el aviso, no un error del código.
--
-- El código tolera que la migración todavía no esté: el alta queda cerrada
-- (42883 / 42P01) y WhatsApp enruta sólo el número de la plataforma. Por eso el
-- schema de Drizzle tiene `autoalta` y ninguna consulta sobre tenants puede
-- pedir todas las columnas (lo vigila `pnpm arquitectura`).
--
-- Corre con el rol dueño (BYPASSRLS): la función SECURITY DEFINER escribe con
-- sus privilegios y, con RLS forzada, un dueño sin BYPASSRLS no vería ninguna fila.
--
-- Vuelta atrás (en este orden; los GRANT los repone `pnpm rol-app` después de
-- sacar tenants, whatsapp_numeros, account, session, verification y user de
-- scripts/lib/permisos-quitados.mjs):
--   DROP FUNCTION IF EXISTS public.claimmix_crear_inquilino(uuid, uuid, text, text, integer, integer, inet);
--   DROP TABLE IF EXISTS public.whatsapp_numeros;
--   DROP POLICY IF EXISTS claimmix_tenant_isolation ON public.tenants;
--   ALTER TABLE public.tenants NO FORCE ROW LEVEL SECURITY;
--   ALTER TABLE public.tenants DISABLE ROW LEVEL SECURITY;
--   DROP INDEX IF EXISTS public.tenants_autoalta_creados;
--   ALTER TABLE public.tenants DROP COLUMN IF EXISTS autoalta;
-- =============================================================================

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_roles
     WHERE rolname = current_user AND (rolbypassrls OR rolsuper)
  ) THEN
    RAISE EXCEPTION '0048 tiene que correr con el rol dueño (BYPASSRLS): la función SECURITY DEFINER escribe con sus privilegios';
  END IF;
END $$;

-- 1. Qué inquilinos salieron del alta automática
ALTER TABLE public.tenants
  ADD COLUMN IF NOT EXISTS autoalta boolean NOT NULL DEFAULT false;

CREATE INDEX IF NOT EXISTS tenants_autoalta_creados
  ON public.tenants (created_at) WHERE autoalta;

-- 2. El número de WhatsApp de cada inquilino
CREATE TABLE IF NOT EXISTS public.whatsapp_numeros (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id uuid NOT NULL REFERENCES public.tenants(id) ON DELETE CASCADE,
  numero_e164 text NOT NULL CHECK (numero_e164 ~ '^\+[1-9][0-9]{7,14}$'),
  estado text NOT NULL DEFAULT 'pedido'
    CHECK (estado IN ('pedido', 'conectado', 'suspendido', 'baja')),
  phone_number_id text CHECK (phone_number_id ~ '^[0-9]{6,20}$'),
  waba_id text CHECK (waba_id ~ '^[0-9]{6,20}$'),
  -- NULL = el token del usuario de sistema de la plataforma
  token_cifrado text,
  creado_en timestamptz NOT NULL DEFAULT now(),
  conectado_en timestamptz,
  actualizado_en timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT whatsapp_numeros_conectado_con_ids
    CHECK (estado <> 'conectado' OR (phone_number_id IS NOT NULL AND waba_id IS NOT NULL))
);

-- Un id de Meta y un número E.164 pertenecen a una sola fila viva; un número vivo por inquilino.
-- El número se compara sin el 9 de los móviles argentinos (+549… y +54… son la
-- misma línea), igual que `mismoNumero` en validar.ts y el panel de altas.
CREATE UNIQUE INDEX IF NOT EXISTS whatsapp_numeros_id_de_meta_vivo
  ON public.whatsapp_numeros (phone_number_id)
  WHERE phone_number_id IS NOT NULL AND estado <> 'baja';
CREATE UNIQUE INDEX IF NOT EXISTS whatsapp_numeros_e164_vivo
  ON public.whatsapp_numeros ((regexp_replace(numero_e164, '^[+]549', '+54')))
  WHERE estado <> 'baja';
CREATE UNIQUE INDEX IF NOT EXISTS whatsapp_numeros_uno_por_inquilino
  ON public.whatsapp_numeros (tenant_id)
  WHERE estado <> 'baja';
-- El enrutado busca el id en CUALQUIER estado: una fila 'baja' gana sobre el .env.
CREATE INDEX IF NOT EXISTS whatsapp_numeros_por_id_de_meta
  ON public.whatsapp_numeros (phone_number_id)
  WHERE phone_number_id IS NOT NULL;

-- 3. RLS: cada inquilino ve sólo su fila de tenants y su propio número
ALTER TABLE public.whatsapp_numeros ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.whatsapp_numeros FORCE ROW LEVEL SECURITY;
ALTER TABLE public.tenants ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.tenants FORCE ROW LEVEL SECURITY;

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_policies
     WHERE schemaname = 'public' AND tablename = 'whatsapp_numeros'
       AND policyname = 'claimmix_tenant_isolation'
  ) THEN
    CREATE POLICY claimmix_tenant_isolation ON public.whatsapp_numeros
      USING (public.claimmix_tenant_matches(tenant_id))
      WITH CHECK (public.claimmix_tenant_matches(tenant_id));
  END IF;
  IF NOT EXISTS (
    SELECT 1 FROM pg_policies
     WHERE schemaname = 'public' AND tablename = 'tenants'
       AND policyname = 'claimmix_tenant_isolation'
  ) THEN
    CREATE POLICY claimmix_tenant_isolation ON public.tenants
      USING (public.claimmix_tenant_matches(id))
      WITH CHECK (public.claimmix_tenant_matches(id));
  END IF;
END $$;

-- 5. La única forma de crear un inquilino desde la app.
--    Se llama por enTenant({ tenantId: <id nuevo> }): el contexto tiene que ser el inquilino nuevo.
CREATE OR REPLACE FUNCTION public.claimmix_crear_inquilino(
  p_tenant_id uuid,
  p_user_id uuid,
  p_empresa text,
  p_numero text,
  p_dias integer,
  p_tope_dia integer,
  p_ip inet DEFAULT NULL
) RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, public
AS $$
DECLARE
  v_email text;
  v_nombre text;
  v_verificado boolean;
  v_empresa text := btrim(coalesce(p_empresa, ''));
  v_tope integer := LEAST(GREATEST(coalesce(p_tope_dia, 0), 0), 500);
  v_creadas integer;
  v_en_revision boolean;
BEGIN
  IF p_tenant_id IS NULL
     OR p_tenant_id IS DISTINCT FROM public.claimmix_current_tenant_id() THEN
    RAISE EXCEPTION 'claimmix_crear_inquilino: el contexto no es el inquilino nuevo'
      USING ERRCODE = '42501';
  END IF;

  -- Serializa las altas: sin esto, dos a la vez se saltean el tope de 24 h.
  PERFORM pg_advisory_xact_lock(hashtext('claimmix_alta'));

  SELECT u.email, u.name, u.email_verified
    INTO v_email, v_nombre, v_verificado
    FROM public."user" u
   WHERE u.id = p_user_id;
  IF NOT FOUND OR v_verificado IS NOT TRUE THEN
    RETURN jsonb_build_object('resultado', 'no_verificado');
  END IF;

  IF EXISTS (SELECT 1 FROM public.users WHERE id = p_user_id) THEN
    RETURN jsonb_build_object('resultado', 'ya_tiene_espacio');
  END IF;

  IF char_length(v_empresa) NOT BETWEEN 2 AND 80
     OR v_empresa ~ '[[:cntrl:]]'
     OR v_empresa ~* '(://|www\.|@)'
     OR p_numero IS NULL
     OR p_numero !~ '^\+[1-9][0-9]{7,14}$' THEN
    RETURN jsonb_build_object('resultado', 'datos_invalidos');
  END IF;

  SELECT count(*) INTO v_creadas
    FROM public.tenants
   WHERE autoalta AND created_at > now() - interval '24 hours';
  IF v_creadas >= v_tope THEN
    RETURN jsonb_build_object('resultado', 'alta_cerrada', 'creadas_24h', v_creadas, 'tope', v_tope);
  END IF;

  -- Un número que ya pidió otro no frena el alta: el espacio se crea sin fila de
  -- número y lo revisa el operador.
  v_en_revision := EXISTS (
    SELECT 1 FROM public.whatsapp_numeros
     WHERE regexp_replace(numero_e164, '^[+]549', '+54') = regexp_replace(p_numero, '^[+]549', '+54')
       AND estado <> 'baja'
  );

  INSERT INTO public.tenants (id, name, plan, billing_status, trial_ends_at, contact_email, autoalta)
  VALUES (
    p_tenant_id, v_empresa, 'piloto', 'trial',
    now() + make_interval(days => LEAST(GREATEST(coalesce(p_dias, 30), 1), 90)),
    v_email, true
  );

  INSERT INTO public.users (id, tenant_id, full_name, role)
  VALUES (
    p_user_id, p_tenant_id,
    left(coalesce(
      nullif(btrim(regexp_replace(coalesce(v_nombre, ''), '[[:cntrl:]]', '', 'g')), ''),
      split_part(v_email, '@', 1)
    ), 100),
    'owner'
  );

  IF NOT v_en_revision THEN
    INSERT INTO public.whatsapp_numeros (tenant_id, numero_e164)
    VALUES (p_tenant_id, p_numero);
  END IF;

  INSERT INTO public.audit_log (tenant_id, actor_id, event_type, target_type, target_id, payload, ip)
  VALUES (
    p_tenant_id, p_user_id, 'tenant.created', 'tenant', p_tenant_id::text,
    jsonb_build_object('origen', 'autoalta', 'numero_en_revision', v_en_revision),
    p_ip
  );

  RETURN jsonb_build_object(
    'resultado', CASE WHEN v_en_revision THEN 'ok_numero_en_revision' ELSE 'ok' END,
    'creadas_24h', v_creadas + 1,
    'tope', v_tope
  );
END;
$$;

REVOKE ALL ON FUNCTION public.claimmix_crear_inquilino(uuid, uuid, text, text, integer, integer, inet) FROM PUBLIC;

-- 3 y 4. Permisos del rol de la app (sólo si existe en esta base)
DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'claimmix_app') THEN
    GRANT EXECUTE ON FUNCTION
      public.claimmix_crear_inquilino(uuid, uuid, text, text, integer, integer, inet)
      TO claimmix_app;

    -- tenants: lee su fila y escribe sólo configuración.
    -- Un REVOKE de tabla también saca los permisos por columna: se dan de nuevo después.
    REVOKE INSERT, UPDATE, DELETE, TRUNCATE ON public.tenants FROM claimmix_app;
    GRANT SELECT ON public.tenants TO claimmix_app;
    GRANT UPDATE (specialist_alert_emails, recordatorio_horas, rangos_de_monto,
                  reglas_asignacion, plazos, plan_por_tipo, pesos_puntaje)
      ON public.tenants TO claimmix_app;

    -- whatsapp_numeros: la app sólo la lee; escriben la función y el rol dueño.
    REVOKE INSERT, UPDATE, DELETE, TRUNCATE ON public.whatsapp_numeros FROM claimmix_app;
    GRANT SELECT ON public.whatsapp_numeros TO claimmix_app;

    -- Better Auth: hashes de contraseña, tokens de sesión y de restablecimiento no
    -- son asunto de la app (Better Auth y cerrarSesiones usan el rol dueño).
    -- De account quedan legibles las dos columnas que no guardan secretos.
    REVOKE ALL ON public.account, public.session, public.verification FROM claimmix_app;
    GRANT SELECT (provider_id, user_id) ON public.account TO claimmix_app;
    REVOKE INSERT, UPDATE, DELETE, TRUNCATE ON public."user" FROM claimmix_app;
    GRANT SELECT ON public."user" TO claimmix_app;
  ELSE
    RAISE NOTICE 'claimmix_app no existe en esta base: nada que revocar (corré pnpm rol-app y después pnpm permisos)';
  END IF;
END $$;
