-- =============================================================================
-- 0051 — WABA propia: cada cliente conecta su WhatsApp Business, por Embedded Signup o con su propia app de Meta
-- =============================================================================
--
-- Hasta acá un espacio del alta automática colgaba su número de la WABA de la
-- plataforma. Con Embedded Signup v4 el cliente crea o elige la suya en el popup de
-- Meta y la app guarda lo que Meta devolvió. Con la «app propia» el cliente crea su
-- propia app en Meta, pega el App ID, el App Secret y un token, y la app habla con su
-- WABA con esas credenciales. Esta migración pone, en control:
--
--   1. public.whatsapp_wabas: una fila por inquilino con el estado del vínculo
--      (armando, cancelada, vinculada, suscripta, falta_codigo, falta_pin, conectada,
--      falla, revocada), el origen (embedded_signup o app_propia), los ids de Meta, el
--      número que Meta informó y el PIN cifrado. Las columnas de la app propia (app_id,
--      secreto cifrado, ruta del webhook, datos legales, marcas del primer mensaje)
--      sólo se llenan con ese origen. El token del cliente NO va acá: va en
--      whatsapp_numeros.token_cifrado, que ya existe y que el espejo a la base del
--      cliente ya borra.
--   2. public.claimmix_waba_propia: la única puerta con la que la app escribe en esa
--      tabla y en la fila de whatsapp_numeros del inquilino. SECURITY DEFINER, con
--      un paso por llamada (iniciar, cancelar, vincular, aceptar_numero, estado,
--      conectar, desconectar y, para la app propia, app_iniciar, app_credenciales y
--      app_token) y las transiciones permitidas escritas en cada UPDATE.
--
-- claimmix_app sólo lee la tabla: escriben la función y el rol dueño. La función
-- sólo toca al inquilino del contexto, sólo si es del alta automática y quien llama
-- es owner o admin, y con prueba vigente o plan activo (desconectar no pide eso: un
-- cliente con la prueba vencida también tiene que poder borrar su token). Nunca
-- guarda la WABA ni el número de la plataforma (de_la_plataforma) ni la app de la
-- plataforma como si fuera de un cliente, ni un id que ya tenga otro inquilino vivo
-- (id_ocupado, app_ocupada) o haya tenido de baja hace menos de 30 días, la misma
-- cuarentena que aplica conectarNumero. Serializa con el flujo viejo (0049) con el
-- mismo candado. El cupo semanal cuenta portfolios de Meta (business_id distintos con
-- vinculada_en de los últimos 7 días), no filas, y sólo rige para Embedded Signup.
--
-- Qué contesta (jsonb { resultado }): ok, no_aplica, datos_invalidos,
-- de_la_plataforma, id_ocupado, numero_ocupado, ya_conectado, transicion, cupo,
-- app_ocupada, otra_app, webhook_pendiente y apagado. El paso conectar repetido con el
-- mismo id contesta ok sin escribir de nuevo. Un 23505 de otro camino de escritura (el
-- rol dueño) o de un índice (whatsapp_wabas_ruta, whatsapp_wabas_slug_legal) lo
-- traduce quien llama, por el nombre de la restricción.
--
-- La fila manda: un paso sobre una fila viva del otro origen contesta transicion y no
-- escribe. Una fila app_propia muerta (cancelada o revocada) se suelta al volver a
-- conectar por Embedded Signup: el UPDATE previo la deja con origen embedded_signup y
-- sin ningún dato de la app, para que la restricción por origen no la rechace.
--
-- Lo que la función permite de más que el plano, para que W3 no lo busque:
--   · estado con falla también sale de «sin fila» y de cancelada: el canje del
--     código puede fallar antes de que haya un vincular que escriba la fila.
--   · estado conectada → conectada: sólo registra plantilla_enviada_en y
--     nombre_estado (el paso 8 de continuarWaba corre ya conectada).
--   · estado con falla o falta_pin también sale de conectada: volver a registrar el
--     número con el nombre aprobado puede fallar con la fila ya conectada.
--   · vinculada_en se renueva cuando el vincular trae una WABA distinta de la que
--     tenía la fila: es lo que cuenta el cupo semanal.
--   · un número suspendido por el operador también contesta ya_conectado.
--   · app_credenciales con falla secreto_invalido y el número conectado devuelve la
--     fila a conectada; app_token hace lo mismo con token_vencido.
--   · si esas dos fallas cayeron armando el alta (el número sigue pedido), la fila vuelve a
--     vinculada en vez de a conectada y el servidor sigue con el alta desde ahí; app_token
--     también cambia el token del número pedido en ese caso.
--
-- Aditiva e idempotente. Hay que aplicarla A MANO ANTES de mergear el código que la
-- usa, con `node scripts/migrate.mjs --apply` por TCP, en este orden:
--   1. ep-wispy-flower (QA, QA_DATABASE_URL).
--   2. ep-proud-resonance (la viva, y también la de los secretos DATABASE_URL del CI).
--   3. La rama production de Veltra (STAGING_DATABASE_URL, sólo para ci.yml).
--   4. `node scripts/migrar-bases.mjs --env prd`: control de prd, la rama ensayo y
--      las bases t_<hex>. La tabla queda vacía en las de cliente: es sólo de control.
-- Identificar cada base por su canal de casos, no por su nombre.
-- Después: `pnpm bases:empaquetar` y, contra cada base (con DATABASE_URL_APP en el
-- entorno):
--   pnpm permisos && pnpm tenancy
-- Si el CI corre antes de que esté aplicada en la base de los secretos, esos dos
-- chequeos quedan rojos: es el aviso, no un error del código.
--
-- La firma de la función tiene ocho argumentos (suma p_app_plataforma antes de p_ip).
-- Esta migración nunca se aplicó con la firma de siete: si alguna base la tuviera, hay
-- que soltarla a mano antes (ver la vuelta atrás), porque CREATE OR REPLACE crearía
-- una sobrecarga al lado y las dos quedarían con permisos de la app.
--
-- El código tolera que la migración todavía no esté: sin la función (42883) o sin la
-- tabla (42P01) el alta por WABA propia queda inactiva y la interfaz sigue con lo
-- de hoy.
--
-- Corre con el rol dueño (BYPASSRLS): la función SECURITY DEFINER escribe con sus
-- privilegios y, con RLS forzada, un dueño sin BYPASSRLS no vería ninguna fila.
-- whatsapp_numeros no gana ninguna columna.
--
-- Vuelta atrás (la función, la tabla y, para que migrate.mjs la vuelva a aplicar, su registro):
--   DROP FUNCTION IF EXISTS public.claimmix_waba_propia(uuid, uuid, text, jsonb, text, text, text, inet);
--   DROP TABLE IF EXISTS public.whatsapp_wabas;
--   node scripts/migrate.mjs --env <VAR> --forget 0051
-- =============================================================================

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_roles
     WHERE rolname = current_user AND (rolbypassrls OR rolsuper)
  ) THEN
    RAISE EXCEPTION '0051 tiene que correr con el rol dueño (BYPASSRLS): la función SECURITY DEFINER escribe con sus privilegios';
  END IF;
END $$;

-- 1. El vínculo de cada inquilino con su WABA
CREATE TABLE IF NOT EXISTS public.whatsapp_wabas (
  tenant_id uuid PRIMARY KEY REFERENCES public.tenants(id) ON DELETE CASCADE,
  estado text NOT NULL
    CHECK (estado IN ('armando', 'cancelada', 'vinculada', 'suscripta', 'falta_codigo', 'falta_pin', 'conectada', 'falla', 'revocada')),
  falla text CHECK (falla ~ '^[a-z_]{1,40}$'),
  paso_cancelado text CHECK (paso_cancelado IN (
    'business_account_selection', 'waba_phone_profile_picker', 'whatsapp_business_profile_setup',
    'phone_number_setup', 'phone_number_verification', 'permissions', 'otro'
  )),
  business_id text CHECK (business_id ~ '^[0-9]{6,20}$'),
  waba_id text CHECK (waba_id ~ '^[0-9]{6,20}$'),
  fb_user_id text CHECK (fb_user_id ~ '^[0-9]{1,30}$'),
  numero_meta text CHECK (numero_meta ~ '^\+[1-9][0-9]{7,14}$'),
  numero_aceptado boolean NOT NULL DEFAULT false,
  nombre_estado text CHECK (nombre_estado ~ '^[A-Z_]{1,30}$'),
  plantilla_enviada_en timestamptz,
  pin_cifrado text,
  intentos integer NOT NULL DEFAULT 0,
  vinculada_en timestamptz,
  -- La app propia: sólo se llena con origen app_propia (restricción whatsapp_wabas_por_origen).
  origen text NOT NULL DEFAULT 'embedded_signup' CHECK (origen IN ('embedded_signup', 'app_propia')),
  app_id text CHECK (app_id ~ '^[0-9]{6,20}$'),
  -- Sobre v2 del App Secret: un secreto de 128 caracteres en base64url entra con holgura.
  app_secreto_cifrado text CHECK (length(app_secreto_cifrado) <= 512),
  ruta_webhook text CHECK (ruta_webhook ~ '^[A-Za-z0-9_-]{22}$'),
  webhook_app_verificado_en timestamptz,
  datos_app_en timestamptz,
  primer_mensaje_en timestamptz,
  primera_respuesta_en timestamptz,
  slug_legal text CHECK (slug_legal ~ '^[a-z0-9]{16}$'),
  razon_social text CHECK (char_length(razon_social) BETWEEN 1 AND 120),
  cuit text CHECK (cuit ~ '^[0-9]{11}$'),
  acuerdo_version text CHECK (acuerdo_version ~ '^[0-9]{4}-[0-9]{2}$'),
  recordatorio_en timestamptz,
  puede_enviar text CHECK (puede_enviar IN ('AVAILABLE', 'LIMITED', 'BLOCKED')),
  -- El rubro que el cliente eligió para el perfil del número: la lista de Meta la valida el servidor, acá sólo la forma.
  categoria_perfil text CHECK (categoria_perfil ~ '^[A-Z_]{3,20}$'),
  creado_en timestamptz NOT NULL DEFAULT now(),
  actualizado_en timestamptz NOT NULL DEFAULT now(),
  -- Embedded Signup no tiene nada de la app propia y nunca está armando. La app propia viva necesita sus
  -- datos legales y la ruta; desde que se arma necesita también app_id y secreto. No exige slug_legal: el
  -- operador puede despublicar las páginas legales en cualquier estado.
  CONSTRAINT whatsapp_wabas_por_origen CHECK (CASE origen
    WHEN 'embedded_signup' THEN app_id IS NULL AND app_secreto_cifrado IS NULL AND ruta_webhook IS NULL
      AND webhook_app_verificado_en IS NULL AND datos_app_en IS NULL AND primer_mensaje_en IS NULL
      AND primera_respuesta_en IS NULL AND slug_legal IS NULL AND razon_social IS NULL AND cuit IS NULL
      AND acuerdo_version IS NULL AND recordatorio_en IS NULL AND puede_enviar IS NULL AND categoria_perfil IS NULL
      AND estado <> 'armando'
    ELSE (estado IN ('cancelada', 'revocada')
          OR (ruta_webhook IS NOT NULL AND razon_social IS NOT NULL AND cuit IS NOT NULL AND acuerdo_version IS NOT NULL))
     AND (estado IN ('armando', 'cancelada', 'revocada') OR (app_id IS NOT NULL AND app_secreto_cifrado IS NOT NULL))
  END)
);

-- Una WABA pertenece a un solo inquilino vivo; revocada y cancelada la sueltan.
CREATE UNIQUE INDEX IF NOT EXISTS whatsapp_wabas_waba_viva
  ON public.whatsapp_wabas (waba_id)
  WHERE waba_id IS NOT NULL AND estado NOT IN ('revocada', 'cancelada');
-- Meta avisa por usuario de Facebook (revocación, borrado de datos).
CREATE INDEX IF NOT EXISTS whatsapp_wabas_fb_user
  ON public.whatsapp_wabas (fb_user_id)
  WHERE fb_user_id IS NOT NULL;
-- Una app de Meta es de un solo inquilino vivo, igual que la WABA.
CREATE UNIQUE INDEX IF NOT EXISTS whatsapp_wabas_app_viva
  ON public.whatsapp_wabas (app_id)
  WHERE app_id IS NOT NULL AND estado NOT IN ('revocada', 'cancelada');
-- La ruta del webhook identifica al inquilino en la URL: no puede repetirse en ningún estado.
CREATE UNIQUE INDEX IF NOT EXISTS whatsapp_wabas_ruta
  ON public.whatsapp_wabas (ruta_webhook)
  WHERE ruta_webhook IS NOT NULL;
-- El slug de las páginas legales públicas identifica a un solo inquilino.
CREATE UNIQUE INDEX IF NOT EXISTS whatsapp_wabas_slug_legal
  ON public.whatsapp_wabas (slug_legal)
  WHERE slug_legal IS NOT NULL;

-- 2. RLS: cada inquilino ve sólo su fila
ALTER TABLE public.whatsapp_wabas ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.whatsapp_wabas FORCE ROW LEVEL SECURITY;

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_policies
     WHERE schemaname = 'public' AND tablename = 'whatsapp_wabas'
       AND policyname = 'claimmix_tenant_isolation'
  ) THEN
    CREATE POLICY claimmix_tenant_isolation ON public.whatsapp_wabas
      USING (public.claimmix_tenant_matches(tenant_id))
      WITH CHECK (public.claimmix_tenant_matches(tenant_id));
  END IF;
END $$;

-- 3. La única forma de escribirla desde la app.
--    Se llama por enTenant({ tenantId }): el contexto tiene que ser el inquilino que conecta.
CREATE OR REPLACE FUNCTION public.claimmix_waba_propia(
  p_tenant_id uuid,
  p_user_id uuid,
  p_paso text,
  p_datos jsonb,
  p_waba_plataforma text,
  p_id_plataforma text,
  p_app_plataforma text,
  p_ip inet DEFAULT NULL
) RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, public
AS $$
DECLARE
  -- iv.tag.ct en base64url: lo único que se guarda, nunca un token en claro.
  c_sobre CONSTANT text := '^[A-Za-z0-9_-]+[.][A-Za-z0-9_-]+[.][A-Za-z0-9_-]+$';
  -- v2.<kid>.<iv>.<tag>.<ct>: el sobre del App Secret, que lleva el id de su clave.
  c_sobre_secreto CONSTANT text := '^v2[.][a-z0-9]{1,16}[.][A-Za-z0-9_-]+[.][A-Za-z0-9_-]+[.][A-Za-z0-9_-]+$';
  v_datos jsonb := coalesce(p_datos, '{}'::jsonb);
  v_waba_plat text := nullif(btrim(coalesce(p_waba_plataforma, '')), '');
  v_id_plat text := nullif(btrim(coalesce(p_id_plataforma, '')), '');
  v_app_plat text := nullif(btrim(coalesce(p_app_plataforma, '')), '');
  v_fila public.whatsapp_wabas%ROWTYPE;
  v_hay_fila boolean := false;
  v_numero_id uuid;
  v_numero_estado text;
  v_numero_phone text;
  v_numero_waba text;
  v_numero_e164 text;
  v_numero_con_token boolean;
  -- El número vivo es el que este vínculo creó y sigue conectado: la WABA puede estar en falla sin que el número se haya ido.
  v_propio boolean := false;
  -- La fila es una app propia viva (ni cancelada ni revocada): manda sobre los pasos que comparten los dos orígenes.
  v_app boolean := false;
  -- La fila es una app propia muerta: antes de escribirle como Embedded Signup hay que soltarla.
  v_limpiar boolean := false;
  -- app_credenciales en armando trae otra app que la guardada: hay ruta nueva y el callback se verifica de nuevo.
  v_cambia boolean := false;
  v_tope integer;
  v_usadas integer;
  v_business text;
  v_waba text;
  v_phone text;
  v_meta text;
  v_fb text;
  v_token text;
  v_pin text;
  v_categoria text;
  v_app_id text;
  v_secreto text;
  v_ruta text;
  v_slug text;
  v_razon text;
  v_cuit text;
  v_acuerdo text;
  v_numero text;
  v_datos_app boolean;
  v_que text;
  v_estado_nuevo text;
  v_falla text;
  v_nombre text;
  v_plantilla timestamptz;
  v_paso_cancelado text;
  v_permitido boolean;
  v_baja boolean := false;
  v_evento text;
  v_objetivo text;
  v_objetivo_id text;
  v_carga jsonb;
BEGIN
  IF p_tenant_id IS NULL
     OR p_tenant_id IS DISTINCT FROM public.claimmix_current_tenant_id() THEN
    RAISE EXCEPTION 'claimmix_waba_propia: el contexto no es el inquilino'
      USING ERRCODE = '42501';
  END IF;

  IF p_paso IS NULL
     OR p_paso NOT IN (
       'iniciar', 'cancelar', 'vincular', 'aceptar_numero', 'estado', 'conectar', 'desconectar',
       'app_iniciar', 'app_credenciales', 'app_token'
     )
     OR jsonb_typeof(v_datos) <> 'object' THEN
    RETURN jsonb_build_object('resultado', 'datos_invalidos');
  END IF;

  -- Sin el App ID de la plataforma no hay forma de saber si el que pega el cliente es el de la
  -- plataforma: un despliegue sin META_APP_ID no guarda nada de la app propia (S1).
  IF p_paso IN ('app_iniciar', 'app_credenciales', 'app_token') AND v_app_plat IS NULL THEN
    RETURN jsonb_build_object('resultado', 'apagado');
  END IF;

  -- Serializa los pasos, también contra el flujo viejo (0049): sin esto, dos a la
  -- vez se pisan la misma fila de whatsapp_numeros.
  PERFORM pg_advisory_xact_lock(hashtext('claimmix_numero'));

  IF NOT EXISTS (
       SELECT 1 FROM public.tenants t
        WHERE t.id = p_tenant_id
          AND t.autoalta
          AND (
            p_paso = 'desconectar'
            OR (
              t.billing_status IN ('trial', 'active')
              AND (t.billing_status <> 'trial' OR t.trial_ends_at IS NULL OR t.trial_ends_at > now())
            )
          )
     )
     OR NOT EXISTS (
       SELECT 1 FROM public.users u
        WHERE u.id = p_user_id AND u.tenant_id = p_tenant_id AND u.role IN ('owner', 'admin')
     ) THEN
    RETURN jsonb_build_object('resultado', 'no_aplica');
  END IF;

  SELECT w.* INTO v_fila
    FROM public.whatsapp_wabas w
   WHERE w.tenant_id = p_tenant_id
     FOR UPDATE;
  v_hay_fila := FOUND;

  -- La fila viva del número: la que el flujo viejo y este comparten.
  SELECT n.id, n.estado, n.phone_number_id, n.waba_id, n.numero_e164, n.token_cifrado IS NOT NULL
    INTO v_numero_id, v_numero_estado, v_numero_phone, v_numero_waba, v_numero_e164, v_numero_con_token
    FROM public.whatsapp_numeros n
   WHERE n.tenant_id = p_tenant_id AND n.estado <> 'baja'
     FOR UPDATE;

  v_propio := v_hay_fila
    AND v_fila.waba_id IS NOT NULL
    AND v_numero_waba = v_fila.waba_id
    AND v_numero_estado = 'conectado'
    AND coalesce(v_numero_con_token, false);
  v_app := v_hay_fila AND v_fila.origen = 'app_propia' AND v_fila.estado NOT IN ('cancelada', 'revocada');
  v_limpiar := v_hay_fila AND v_fila.origen = 'app_propia' AND v_fila.estado IN ('cancelada', 'revocada');

  -- ── iniciar: ¿queda cupo semanal de portfolios de Meta? No escribe nada. ──────
  IF p_paso = 'iniciar' THEN
    -- Una app propia viva no abre el popup de Embedded Signup: son dos caminos distintos.
    IF v_app THEN
      RETURN jsonb_build_object('resultado', 'transicion');
    END IF;
    IF coalesce(v_datos->>'tope', '') !~ '^[0-9]{1,4}$' THEN
      RETURN jsonb_build_object('resultado', 'datos_invalidos');
    END IF;
    v_tope := (v_datos->>'tope')::integer;

    -- La función corre con el rol dueño: ve a todos los inquilinos, no sólo al del contexto.
    -- Quien ya entró esta semana (como `vincular`, que no le cuenta su propia WABA) puede volver a abrir el popup.
    SELECT count(DISTINCT w.business_id) INTO v_usadas
      FROM public.whatsapp_wabas w
     WHERE w.vinculada_en > now() - interval '7 days';
    IF v_usadas >= v_tope AND NOT EXISTS (
         SELECT 1 FROM public.whatsapp_wabas w
          WHERE w.tenant_id = p_tenant_id AND w.vinculada_en > now() - interval '7 days'
       ) THEN
      RETURN jsonb_build_object('resultado', 'cupo', 'usadas', v_usadas, 'tope', v_tope);
    END IF;

  -- ── cancelar: el cliente cerró el popup de Meta, o abandonó el armado de su app. ──
  ELSIF p_paso = 'cancelar' THEN
    v_paso_cancelado := v_datos->>'paso';
    IF v_paso_cancelado IS NULL OR v_paso_cancelado NOT IN (
         'business_account_selection', 'waba_phone_profile_picker', 'whatsapp_business_profile_setup',
         'phone_number_setup', 'phone_number_verification', 'permissions', 'otro'
       ) THEN
      RETURN jsonb_build_object('resultado', 'datos_invalidos');
    END IF;

    IF NOT v_hay_fila THEN
      INSERT INTO public.whatsapp_wabas (tenant_id, estado, paso_cancelado)
      VALUES (p_tenant_id, 'cancelada', v_paso_cancelado);
    ELSIF v_fila.estado = 'armando' THEN
      -- Sólo se cancela una app propia mientras se arma. Se sueltan el secreto y la ruta; la razón social, el
      -- CUIT y el slug quedan (las páginas legales dan 404 aunque el slug siga).
      UPDATE public.whatsapp_wabas
         SET estado = 'cancelada', falla = NULL, paso_cancelado = v_paso_cancelado,
             app_secreto_cifrado = NULL, ruta_webhook = NULL, webhook_app_verificado_en = NULL, actualizado_en = now()
       WHERE tenant_id = p_tenant_id AND estado IN ('armando');
    ELSIF v_app THEN
      RETURN jsonb_build_object('resultado', 'transicion');
    ELSIF v_fila.estado = 'falla' AND v_propio THEN
      -- Cerrar el popup de volver a conectar no desconecta nada: la falla sigue y el número sigue vivo.
      NULL;
    ELSIF v_fila.estado IN ('cancelada', 'falla') THEN
      UPDATE public.whatsapp_wabas
         SET estado = 'cancelada', falla = NULL, paso_cancelado = v_paso_cancelado, actualizado_en = now()
       WHERE tenant_id = p_tenant_id AND estado IN ('cancelada', 'falla');
    ELSE
      RETURN jsonb_build_object('resultado', 'transicion');
    END IF;

  -- ── vincular: el popup terminó y el código ya se canjeó por un token, o el cliente pegó el de su app. ──
  ELSIF p_paso = 'vincular' THEN
    v_business := v_datos->>'business_id';
    v_waba := v_datos->>'waba_id';
    v_phone := v_datos->>'phone_number_id';
    v_meta := v_datos->>'numero_meta';
    v_fb := v_datos->>'fb_user_id';
    v_token := v_datos->>'token_cifrado';
    v_pin := v_datos->>'pin_cifrado';
    v_categoria := v_datos->>'categoria_perfil';

    -- La fila dice de qué camino es: una app propia viva no recibe portfolio, usuario de Facebook ni cupo.
    IF v_app AND coalesce(v_business, v_fb, v_datos->>'tope') IS NOT NULL THEN
      RETURN jsonb_build_object('resultado', 'transicion');
    END IF;
    IF (NOT v_app AND (coalesce(v_business, '') !~ '^[0-9]{6,20}$' OR coalesce(v_datos->>'tope', '') !~ '^[0-9]{1,4}$'))
       OR coalesce(v_waba, '') !~ '^[0-9]{6,20}$'
       OR coalesce(v_phone, '') !~ '^[0-9]{6,20}$'
       OR coalesce(v_meta, '') !~ '^\+[1-9][0-9]{7,14}$'
       OR (v_fb IS NOT NULL AND v_fb !~ '^[0-9]{1,30}$')
       OR (v_categoria IS NOT NULL AND (NOT v_app OR v_categoria !~ '^[A-Z_]{3,20}$'))
       OR coalesce(v_token, '') !~ c_sobre OR char_length(v_token) > 4096
       OR coalesce(v_pin, '') !~ c_sobre OR char_length(v_pin) > 4096
       OR v_id_plat IS NULL THEN
      RETURN jsonb_build_object('resultado', 'datos_invalidos');
    END IF;
    IF NOT v_app THEN
      v_tope := (v_datos->>'tope')::integer;
    END IF;

    -- Ni la WABA ni el número de la plataforma se le asignan a nadie.
    IF v_phone = v_id_plat OR v_waba = v_waba_plat THEN
      RETURN jsonb_build_object('resultado', 'de_la_plataforma');
    END IF;

    IF v_numero_estado IN ('conectado', 'suspendido') OR (v_hay_fila AND v_fila.estado = 'conectada') THEN
      -- Sólo se vuelve a vincular una WABA propia caída o a medias (lo que TS llama `reconectando`) cuyo número sigue vivo, y sólo la misma WABA con el mismo número.
      IF NOT (v_hay_fila AND v_fila.estado IN ('falla', 'vinculada', 'suscripta', 'falta_codigo', 'falta_pin') AND v_propio) THEN
        RETURN jsonb_build_object('resultado', 'ya_conectado');
      END IF;
      IF v_waba IS DISTINCT FROM v_fila.waba_id OR v_phone IS DISTINCT FROM v_numero_phone THEN
        RETURN jsonb_build_object('resultado', 'no_aplica');
      END IF;
    END IF;
    IF v_hay_fila AND v_fila.estado NOT IN
         ('armando', 'cancelada', 'falla', 'vinculada', 'suscripta', 'falta_codigo', 'falta_pin', 'revocada') THEN
      RETURN jsonb_build_object('resultado', 'transicion');
    END IF;
    -- La app propia no empieza a vincular sin su app y su secreto guardados.
    IF v_fila.estado = 'armando' AND (v_fila.app_id IS NULL OR v_fila.app_secreto_cifrado IS NULL) THEN
      RETURN jsonb_build_object('resultado', 'transicion');
    END IF;

    -- El id lo tiene otro inquilino vivo, o lo tuvo de baja hace menos de 30 días
    -- (la cuarentena de conectarNumero), o la WABA ya es de otra fila viva.
    IF EXISTS (
         SELECT 1 FROM public.whatsapp_numeros q
          WHERE q.phone_number_id = v_phone
            AND q.tenant_id <> p_tenant_id
            AND (q.estado <> 'baja' OR q.actualizado_en > now() - make_interval(days => 30))
       )
       OR EXISTS (
         SELECT 1 FROM public.whatsapp_wabas o
          WHERE o.waba_id = v_waba
            AND o.tenant_id <> p_tenant_id
            AND o.estado NOT IN ('revocada', 'cancelada')
       ) THEN
      RETURN jsonb_build_object('resultado', 'id_ocupado');
    END IF;

    -- El número que Meta informó ya es de otro: se corta acá, antes de gastar llamadas a Graph.
    IF EXISTS (
         SELECT 1 FROM public.whatsapp_numeros o
          WHERE o.tenant_id <> p_tenant_id
            AND o.estado <> 'baja'
            AND regexp_replace(o.numero_e164, '^[+]549', '+54') = regexp_replace(v_meta, '^[+]549', '+54')
       ) THEN
      RETURN jsonb_build_object('resultado', 'numero_ocupado');
    END IF;

    -- Cupo semanal: sólo cuenta una WABA nueva de un portfolio que esta semana todavía no entró. La app propia no lo tiene.
    IF NOT v_app AND v_fila.waba_id IS DISTINCT FROM v_waba THEN
      SELECT count(DISTINCT w.business_id) INTO v_usadas
        FROM public.whatsapp_wabas w
       WHERE w.vinculada_en > now() - interval '7 days';
      IF v_usadas >= v_tope AND NOT EXISTS (
           SELECT 1 FROM public.whatsapp_wabas w
            WHERE w.vinculada_en > now() - interval '7 days' AND w.business_id = v_business
         ) THEN
        RETURN jsonb_build_object('resultado', 'cupo', 'usadas', v_usadas, 'tope', v_tope);
      END IF;
    END IF;

    -- Una app propia muerta que vuelve por Embedded Signup deja de serlo: sin esto la restricción por origen rechaza el UPDATE.
    IF v_limpiar THEN
      UPDATE public.whatsapp_wabas
         SET origen = 'embedded_signup', app_id = NULL, app_secreto_cifrado = NULL, ruta_webhook = NULL,
             webhook_app_verificado_en = NULL, datos_app_en = NULL, primer_mensaje_en = NULL,
             primera_respuesta_en = NULL, slug_legal = NULL, razon_social = NULL, cuit = NULL,
             acuerdo_version = NULL, recordatorio_en = NULL, puede_enviar = NULL, categoria_perfil = NULL, actualizado_en = now()
       WHERE tenant_id = p_tenant_id AND estado IN ('cancelada', 'revocada') AND origen = 'app_propia';
    END IF;

    IF v_hay_fila THEN
      UPDATE public.whatsapp_wabas
         SET estado = 'vinculada',
             falla = NULL,
             paso_cancelado = NULL,
             business_id = v_business,
             fb_user_id = v_fb,
             numero_meta = v_meta,
             numero_aceptado = false,
             nombre_estado = NULL,
             plantilla_enviada_en = CASE WHEN waba_id IS NOT DISTINCT FROM v_waba THEN plantilla_enviada_en END,
             pin_cifrado = v_pin,
             categoria_perfil = CASE WHEN v_app THEN coalesce(v_categoria, categoria_perfil) END,
             intentos = intentos + 1,
             vinculada_en = CASE
               WHEN vinculada_en IS NULL OR waba_id IS DISTINCT FROM v_waba THEN now()
               ELSE vinculada_en
             END,
             waba_id = v_waba,
             actualizado_en = now()
       WHERE tenant_id = p_tenant_id
         AND estado IN ('armando', 'cancelada', 'falla', 'vinculada', 'suscripta', 'falta_codigo', 'falta_pin', 'revocada');
    ELSE
      INSERT INTO public.whatsapp_wabas
        (tenant_id, estado, business_id, waba_id, fb_user_id, numero_meta, pin_cifrado, intentos, vinculada_en)
      VALUES
        (p_tenant_id, 'vinculada', v_business, v_waba, v_fb, v_meta, v_pin, 1, now());
    END IF;

    IF v_numero_id IS NULL THEN
      -- Sin fila viva (el alta dejó el número en revisión): nace pedido, con el número de Meta.
      INSERT INTO public.whatsapp_numeros (tenant_id, numero_e164, phone_number_id, waba_id, token_cifrado)
      VALUES (p_tenant_id, v_meta, v_phone, v_waba, v_token)
      RETURNING id INTO v_numero_id;
    ELSE
      UPDATE public.whatsapp_numeros
         SET phone_number_id = v_phone, waba_id = v_waba, token_cifrado = v_token, actualizado_en = now()
       WHERE id = v_numero_id AND estado IN ('pedido', 'conectado');
    END IF;

    v_evento := 'whatsapp.waba_vinculada';
    v_objetivo := 'whatsapp_waba';
    v_objetivo_id := v_waba;
    v_carga := jsonb_build_object(
      'via', CASE WHEN v_app THEN 'app_propia' ELSE 'embedded_signup' END,
      'waba_id', v_waba,
      'phone_number_id', v_phone
    );

  -- ── aceptar_numero: el cliente confirma que el número de Meta es el suyo. ─────
  ELSIF p_paso = 'aceptar_numero' THEN
    -- También a mitad de camino: quien retoma desde «suscripta» o «falta código» y no aceptó el número no vuelve a `vincular`.
    IF NOT v_hay_fila OR v_fila.estado NOT IN ('vinculada', 'suscripta', 'falta_codigo', 'falta_pin', 'falla') THEN
      RETURN jsonb_build_object('resultado', 'transicion');
    END IF;

    UPDATE public.whatsapp_wabas
       SET numero_aceptado = true, actualizado_en = now()
     WHERE tenant_id = p_tenant_id AND estado IN ('vinculada', 'suscripta', 'falta_codigo', 'falta_pin', 'falla');

  -- ── estado: lo que fue pasando con Graph (suscripta, falta código o PIN, falla). ──
  ELSIF p_paso = 'estado' THEN
    v_estado_nuevo := v_datos->>'estado';
    v_falla := v_datos->>'falla';
    v_pin := v_datos->>'pin_cifrado';
    v_nombre := v_datos->>'nombre_estado';
    IF v_estado_nuevo IS NULL
       OR v_estado_nuevo NOT IN ('suscripta', 'falta_codigo', 'falta_pin', 'falla', 'conectada')
       OR (v_estado_nuevo = 'falla' AND coalesce(v_falla, '') NOT IN (
            'canje', 'token_invalido', 'suscripcion', 'registro', 'webhook',
            'token_vencido', 'nombre_rechazado', 'coexistencia', 'sin_numero',
            'secreto_invalido', 'waba_restringida', 'waba_bloqueada', 'pago_pendiente'
          ))
       OR (v_estado_nuevo <> 'falla' AND v_falla IS NOT NULL)
       OR (v_pin IS NOT NULL AND (v_pin !~ c_sobre OR char_length(v_pin) > 4096))
       OR (v_nombre IS NOT NULL AND v_nombre !~ '^[A-Z_]{1,30}$')
       OR (
         v_datos->>'plantilla_enviada_en' IS NOT NULL
         AND v_datos->>'plantilla_enviada_en'
             !~ '^[0-9]{4}-[0-9]{2}-[0-9]{2}[T ][0-9]{2}:[0-9]{2}(:[0-9]{2}([.][0-9]{1,6})?)?(Z|[+-][0-9]{2}(:?[0-9]{2})?)?$'
       ) THEN
      RETURN jsonb_build_object('resultado', 'datos_invalidos');
    END IF;
    v_plantilla := (v_datos->>'plantilla_enviada_en')::timestamptz;

    v_permitido := CASE v_estado_nuevo
      WHEN 'conectada' THEN v_hay_fila AND v_fila.estado = 'conectada'
      -- Una conectada puede caer en falla o en falta_pin: volver a registrar el número con el nombre aprobado
      -- falla desde ahí, y el estado tiene que quedar anotado.
      WHEN 'falla' THEN NOT v_hay_fila
        OR v_fila.estado IN ('cancelada', 'vinculada', 'suscripta', 'falta_codigo', 'falta_pin', 'falla', 'conectada')
      WHEN 'falta_pin' THEN v_hay_fila AND v_fila.estado IN ('vinculada', 'suscripta', 'falta_codigo', 'falta_pin', 'falla', 'conectada')
      ELSE v_hay_fila AND v_fila.estado IN ('vinculada', 'suscripta', 'falta_codigo', 'falta_pin', 'falla')
    END;
    IF NOT v_permitido THEN
      RETURN jsonb_build_object('resultado', 'transicion');
    END IF;

    IF NOT v_hay_fila THEN
      INSERT INTO public.whatsapp_wabas (tenant_id, estado, falla)
      VALUES (p_tenant_id, 'falla', v_falla);
    ELSE
      -- Lo mismo que en vincular: una app propia cancelada que cae en falla por Embedded Signup deja de serlo.
      IF v_limpiar THEN
        UPDATE public.whatsapp_wabas
           SET origen = 'embedded_signup', app_id = NULL, app_secreto_cifrado = NULL, ruta_webhook = NULL,
               webhook_app_verificado_en = NULL, datos_app_en = NULL, primer_mensaje_en = NULL,
               primera_respuesta_en = NULL, slug_legal = NULL, razon_social = NULL, cuit = NULL,
               acuerdo_version = NULL, recordatorio_en = NULL, puede_enviar = NULL, categoria_perfil = NULL, actualizado_en = now()
         WHERE tenant_id = p_tenant_id AND estado IN ('cancelada', 'revocada') AND origen = 'app_propia';
      END IF;

      UPDATE public.whatsapp_wabas
         SET estado = v_estado_nuevo,
             falla = v_falla,
             pin_cifrado = coalesce(v_pin, pin_cifrado),
             nombre_estado = coalesce(v_nombre, nombre_estado),
             plantilla_enviada_en = coalesce(v_plantilla, plantilla_enviada_en),
             actualizado_en = now()
       WHERE tenant_id = p_tenant_id
         AND estado IN ('cancelada', 'vinculada', 'suscripta', 'falta_codigo', 'falta_pin', 'falla', 'conectada');
    END IF;

  -- ── conectar: el número quedó verificado y registrado; pasa a conectado. ──────
  ELSIF p_paso = 'conectar' THEN
    v_phone := v_datos->>'phone_number_id';
    IF coalesce(v_phone, '') !~ '^[0-9]{6,20}$' OR v_id_plat IS NULL THEN
      RETURN jsonb_build_object('resultado', 'datos_invalidos');
    END IF;

    IF v_phone = v_id_plat OR (v_hay_fila AND v_fila.waba_id = v_waba_plat) THEN
      RETURN jsonb_build_object('resultado', 'de_la_plataforma');
    END IF;

    IF NOT v_hay_fila THEN
      RETURN jsonb_build_object('resultado', 'transicion');
    END IF;

    -- Repetido con el mismo id: ya quedó así, no hay nada que escribir ni asentar.
    IF v_fila.estado = 'conectada' AND v_numero_estado = 'conectado' AND v_numero_phone = v_phone THEN
      RETURN jsonb_build_object('resultado', 'ok');
    END IF;

    IF v_fila.estado NOT IN ('suscripta', 'falta_codigo', 'falta_pin') THEN
      RETURN jsonb_build_object('resultado', 'transicion');
    END IF;

    -- La app propia no conecta hasta que Meta le haya verificado el callback: sin él no llegarían los mensajes.
    IF v_fila.origen = 'app_propia' AND v_fila.webhook_app_verificado_en IS NULL THEN
      RETURN jsonb_build_object('resultado', 'webhook_pendiente');
    END IF;

    -- Sólo el pedido de este vínculo, con el id dado y con token propio. Si el número ya
    -- estaba conectado (volver a conectar una WABA en falla) no se toca: sólo se levanta la WABA.
    IF v_numero_id IS NULL
       OR (v_numero_estado <> 'pedido' AND NOT v_propio)
       OR v_numero_phone IS DISTINCT FROM v_phone
       OR v_numero_waba IS DISTINCT FROM v_fila.waba_id
       OR NOT v_numero_con_token THEN
      RETURN jsonb_build_object('resultado', 'no_aplica');
    END IF;

    -- El número de Meta tiene que ser el pedido (sin el 9 de los móviles argentinos) o estar aceptado.
    IF v_fila.numero_meta IS NULL
       OR (
         NOT v_fila.numero_aceptado
         AND regexp_replace(v_fila.numero_meta, '^[+]549', '+54') <> regexp_replace(v_numero_e164, '^[+]549', '+54')
       ) THEN
      RETURN jsonb_build_object('resultado', 'no_aplica');
    END IF;

    IF EXISTS (
         SELECT 1 FROM public.whatsapp_numeros o
          WHERE o.id <> v_numero_id
            AND o.estado <> 'baja'
            AND regexp_replace(o.numero_e164, '^[+]549', '+54') = regexp_replace(v_fila.numero_meta, '^[+]549', '+54')
       ) THEN
      RETURN jsonb_build_object('resultado', 'numero_ocupado');
    END IF;

    UPDATE public.whatsapp_numeros
       SET numero_e164 = v_fila.numero_meta, estado = 'conectado', conectado_en = now(), actualizado_en = now()
     WHERE id = v_numero_id AND estado IN ('pedido');

    UPDATE public.whatsapp_wabas
       SET estado = 'conectada', falla = NULL, actualizado_en = now()
     WHERE tenant_id = p_tenant_id AND estado IN ('suscripta', 'falta_codigo', 'falta_pin');

    v_evento := 'whatsapp.numero_conectado';
    v_objetivo := 'whatsapp_numero';
    v_objetivo_id := v_numero_id::text;
    v_carga := jsonb_build_object('via', CASE WHEN v_app THEN 'app_propia' ELSE 'embedded_signup' END, 'phone_number_id', v_phone);
    IF v_propio THEN
      v_carga := v_carga || jsonb_build_object('reconexion', true);
    END IF;

  -- ── app_iniciar: el cliente aceptó el acuerdo y empieza a armar su app. ───────
  ELSIF p_paso = 'app_iniciar' THEN
    v_ruta := v_datos->>'ruta';
    v_slug := v_datos->>'slug';
    v_razon := btrim(v_datos->>'razon_social');
    v_cuit := v_datos->>'cuit';
    v_acuerdo := v_datos->>'acuerdo';
    v_numero := v_datos->>'numero';
    IF coalesce(v_ruta, '') !~ '^[A-Za-z0-9_-]{22}$'
       OR coalesce(v_slug, '') !~ '^[a-z0-9]{16}$'
       OR char_length(coalesce(v_razon, '')) NOT BETWEEN 1 AND 120
       OR coalesce(v_cuit, '') !~ '^[0-9]{11}$'
       OR coalesce(v_acuerdo, '') !~ '^[0-9]{4}-[0-9]{2}$'
       OR (v_numero IS NOT NULL AND v_numero !~ '^\+[1-9][0-9]{7,14}$') THEN
      RETURN jsonb_build_object('resultado', 'datos_invalidos');
    END IF;

    IF v_numero_estado IN ('conectado', 'suspendido') THEN
      RETURN jsonb_build_object('resultado', 'ya_conectado');
    END IF;
    -- Se empieza de cero, de una cancelada o revocada de cualquier origen, o se retoma el armado.
    IF v_hay_fila AND v_fila.estado NOT IN ('armando', 'cancelada', 'revocada') THEN
      RETURN jsonb_build_object('resultado', 'transicion');
    END IF;

    IF v_numero IS NOT NULL AND EXISTS (
         SELECT 1 FROM public.whatsapp_numeros o
          WHERE o.tenant_id <> p_tenant_id
            AND o.estado <> 'baja'
            AND regexp_replace(o.numero_e164, '^[+]549', '+54') = regexp_replace(v_numero, '^[+]549', '+54')
       ) THEN
      RETURN jsonb_build_object('resultado', 'numero_ocupado');
    END IF;

    IF NOT v_hay_fila THEN
      INSERT INTO public.whatsapp_wabas
        (tenant_id, estado, origen, ruta_webhook, slug_legal, razon_social, cuit, acuerdo_version)
      VALUES
        (p_tenant_id, 'armando', 'app_propia', v_ruta, v_slug, v_razon, v_cuit, v_acuerdo);
    ELSIF v_fila.estado = 'armando' THEN
      -- Retomar el armado no cambia la ruta ni el slug: la app del cliente en Meta ya apunta a ellos.
      UPDATE public.whatsapp_wabas
         SET razon_social = v_razon, cuit = v_cuit, acuerdo_version = v_acuerdo, actualizado_en = now()
       WHERE tenant_id = p_tenant_id AND estado IN ('armando');
    ELSE
      -- Una cancelada o revocada vuelve a armarse de cero. El slug se reusa si lo había, para que la app que el
      -- cliente ya tiene en Meta siga apuntando a sus páginas legales.
      UPDATE public.whatsapp_wabas
         SET estado = 'armando', origen = 'app_propia', ruta_webhook = v_ruta,
             slug_legal = coalesce(slug_legal, v_slug), razon_social = v_razon, cuit = v_cuit, acuerdo_version = v_acuerdo,
             app_id = NULL, app_secreto_cifrado = NULL, webhook_app_verificado_en = NULL, datos_app_en = NULL,
             primer_mensaje_en = NULL, primera_respuesta_en = NULL, recordatorio_en = NULL, puede_enviar = NULL,
             categoria_perfil = NULL, waba_id = NULL, business_id = NULL, fb_user_id = NULL, paso_cancelado = NULL, falla = NULL, pin_cifrado = NULL,
             numero_meta = NULL, numero_aceptado = false, nombre_estado = NULL, plantilla_enviada_en = NULL,
             actualizado_en = now()
       WHERE tenant_id = p_tenant_id AND estado IN ('cancelada', 'revocada');
    END IF;

    IF v_numero IS NOT NULL THEN
      IF v_numero_id IS NULL THEN
        INSERT INTO public.whatsapp_numeros (tenant_id, numero_e164)
        VALUES (p_tenant_id, v_numero);
      ELSIF v_numero_phone IS NULL THEN
        UPDATE public.whatsapp_numeros
           SET numero_e164 = v_numero, actualizado_en = now()
         WHERE id = v_numero_id AND estado IN ('pedido');
      END IF;
    END IF;

    v_evento := 'whatsapp.app_acuerdo';
    v_objetivo := 'whatsapp_waba';
    v_objetivo_id := p_tenant_id::text;
    v_carga := jsonb_build_object('acuerdo', v_acuerdo);

  -- ── app_credenciales: el App ID y el App Secret de la app del cliente (cifrado). ──
  ELSIF p_paso = 'app_credenciales' THEN
    v_app_id := v_datos->>'app_id';
    v_secreto := v_datos->>'app_secreto_cifrado';
    v_ruta := v_datos->>'ruta';
    IF coalesce(v_app_id, '') !~ '^[0-9]{6,20}$'
       OR coalesce(v_secreto, '') !~ c_sobre_secreto OR char_length(v_secreto) > 512
       OR coalesce(v_ruta, '') !~ '^[A-Za-z0-9_-]{22}$'
       OR (v_datos->'datos_app' IS NOT NULL AND jsonb_typeof(v_datos->'datos_app') <> 'boolean') THEN
      RETURN jsonb_build_object('resultado', 'datos_invalidos');
    END IF;
    -- Ausente (modo actualizar): la columna queda como está.
    v_datos_app := (v_datos->>'datos_app')::boolean;

    -- La app de la plataforma nunca se guarda como si fuera de un cliente.
    IF v_app_id = v_app_plat THEN
      RETURN jsonb_build_object('resultado', 'de_la_plataforma');
    END IF;
    IF NOT v_app THEN
      RETURN jsonb_build_object('resultado', 'transicion');
    END IF;
    -- Armando se puede cambiar de app (S5); una vez vinculada, sólo se vuelve a escribir el secreto de la misma.
    IF v_fila.estado <> 'armando' AND v_fila.app_id IS DISTINCT FROM v_app_id THEN
      RETURN jsonb_build_object('resultado', 'otra_app');
    END IF;
    IF EXISTS (
         SELECT 1 FROM public.whatsapp_wabas o
          WHERE o.app_id = v_app_id
            AND o.tenant_id <> p_tenant_id
            AND o.estado NOT IN ('revocada', 'cancelada')
       ) THEN
      RETURN jsonb_build_object('resultado', 'app_ocupada');
    END IF;

    v_cambia := v_fila.estado = 'armando' AND v_fila.app_id IS DISTINCT FROM v_app_id;

    -- Con otra app en armando, la ruta es nueva (la anterior ya está pegada en la app vieja) y el callback hay que verificarlo de nuevo.
    UPDATE public.whatsapp_wabas
       SET app_id = v_app_id,
           app_secreto_cifrado = v_secreto,
           ruta_webhook = CASE WHEN v_cambia THEN v_ruta ELSE ruta_webhook END,
           webhook_app_verificado_en = CASE WHEN v_cambia THEN NULL ELSE webhook_app_verificado_en END,
           datos_app_en = CASE
             WHEN v_datos_app THEN now()
             WHEN v_datos_app IS FALSE OR v_cambia THEN NULL
             ELSE datos_app_en
           END,
           estado = CASE
             WHEN estado = 'falla' AND falla = 'secreto_invalido' AND v_numero_estado = 'conectado' THEN 'conectada'
             WHEN estado = 'falla' AND falla = 'secreto_invalido' AND v_numero_estado = 'pedido' THEN 'vinculada'
             ELSE estado
           END,
           falla = CASE
             WHEN estado = 'falla' AND falla = 'secreto_invalido' AND v_numero_estado IN ('conectado', 'pedido') THEN NULL
             ELSE falla
           END,
           actualizado_en = now()
     WHERE tenant_id = p_tenant_id
       AND estado IN ('armando', 'vinculada', 'suscripta', 'falta_codigo', 'falta_pin', 'conectada', 'falla');

    v_que := CASE WHEN v_cambia THEN 'app' ELSE 'secreto' END;
    v_evento := 'whatsapp.app_credenciales';
    v_objetivo := 'whatsapp_waba';
    v_objetivo_id := coalesce(v_fila.waba_id, p_tenant_id::text);
    v_carga := jsonb_build_object('que', v_que);

  -- ── app_token: el cliente pegó un token nuevo del usuario del sistema de su app. ──
  ELSIF p_paso = 'app_token' THEN
    v_token := v_datos->>'token_cifrado';
    IF coalesce(v_token, '') !~ c_sobre OR char_length(v_token) > 4096 THEN
      RETURN jsonb_build_object('resultado', 'datos_invalidos');
    END IF;

    IF NOT v_app OR NOT (v_fila.estado = 'conectada' OR (v_fila.estado = 'falla' AND v_fila.falla = 'token_vencido')) THEN
      RETURN jsonb_build_object('resultado', 'transicion');
    END IF;
    -- Sólo el token del número que este vínculo creó, con la misma WABA. El número todavía pedido es el de un alta
    -- que cayó armándose: el token se cambia igual, para que el alta siga desde donde se cortó.
    IF v_numero_id IS NULL
       OR NOT (v_numero_estado IN ('conectado', 'suspendido') OR (v_numero_estado = 'pedido' AND v_fila.estado = 'falla'))
       OR v_numero_waba IS DISTINCT FROM v_fila.waba_id THEN
      RETURN jsonb_build_object('resultado', 'no_aplica');
    END IF;

    UPDATE public.whatsapp_numeros
       SET token_cifrado = v_token, actualizado_en = now()
     WHERE id = v_numero_id AND estado IN ('conectado', 'suspendido', 'pedido');

    -- Con el número pedido la fila no se conectó nunca: vuelve a vinculada, y quien llama retoma el alta.
    UPDATE public.whatsapp_wabas
       SET estado = CASE WHEN v_numero_estado = 'pedido' THEN 'vinculada' ELSE 'conectada' END, falla = NULL, actualizado_en = now()
     WHERE tenant_id = p_tenant_id AND estado IN ('conectada', 'falla')
       AND (estado = 'conectada' OR falla = 'token_vencido');

    v_evento := 'whatsapp.app_credenciales';
    v_objetivo := 'whatsapp_waba';
    v_objetivo_id := v_fila.waba_id;
    v_carga := jsonb_build_object('que', 'token');

  -- ── desconectar: el cliente se va. Se borran el token, el PIN y, en la app propia, el secreto y la ruta. ──
  ELSE
    IF NOT v_hay_fila OR v_fila.estado NOT IN
         ('cancelada', 'vinculada', 'suscripta', 'falta_codigo', 'falta_pin', 'conectada', 'falla') THEN
      RETURN jsonb_build_object('resultado', 'transicion');
    END IF;
    IF v_fila.waba_id = v_waba_plat THEN
      RETURN jsonb_build_object('resultado', 'de_la_plataforma');
    END IF;

    -- Sólo la fila de número que este vínculo creó: un número del flujo viejo no se toca.
    IF v_numero_id IS NOT NULL AND v_fila.waba_id IS NOT NULL AND v_numero_waba = v_fila.waba_id THEN
      UPDATE public.whatsapp_numeros
         SET estado = 'baja', token_cifrado = NULL, actualizado_en = now()
       WHERE id = v_numero_id AND estado IN ('pedido', 'conectado', 'suspendido');
      v_baja := true;
    END IF;

    -- app_id, datos_app_en y slug_legal quedan: el historial, y la app del cliente sigue apuntando a sus páginas legales.
    UPDATE public.whatsapp_wabas
       SET estado = 'revocada', falla = NULL, pin_cifrado = NULL,
           app_secreto_cifrado = NULL, ruta_webhook = NULL, webhook_app_verificado_en = NULL, actualizado_en = now()
     WHERE tenant_id = p_tenant_id
       AND estado IN ('cancelada', 'vinculada', 'suscripta', 'falta_codigo', 'falta_pin', 'conectada', 'falla');

    v_evento := CASE WHEN v_baja THEN 'whatsapp.numero_baja' ELSE 'whatsapp.waba_revocada' END;
    v_objetivo := CASE WHEN v_baja THEN 'whatsapp_numero' ELSE 'whatsapp_waba' END;
    v_objetivo_id := CASE WHEN v_baja THEN v_numero_id::text ELSE coalesce(v_fila.waba_id, p_tenant_id::text) END;
    v_carga := jsonb_build_object('via', 'cliente');
  END IF;

  IF v_evento IS NOT NULL THEN
    INSERT INTO public.audit_log (tenant_id, actor_id, event_type, target_type, target_id, payload, ip)
    VALUES (p_tenant_id, p_user_id, v_evento, v_objetivo, v_objetivo_id, v_carga, p_ip);
  END IF;

  RETURN jsonb_build_object('resultado', 'ok');
END;
$$;

REVOKE ALL ON FUNCTION public.claimmix_waba_propia(uuid, uuid, text, jsonb, text, text, text, inet) FROM PUBLIC;
REVOKE ALL ON TABLE public.whatsapp_wabas FROM PUBLIC;

-- 4. Permisos del rol de la app (sólo si existe en esta base)
DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'claimmix_app') THEN
    GRANT EXECUTE ON FUNCTION public.claimmix_waba_propia(uuid, uuid, text, jsonb, text, text, text, inet) TO claimmix_app;

    -- whatsapp_wabas: la app sólo la lee; escriben la función y el rol dueño.
    REVOKE INSERT, UPDATE, DELETE, TRUNCATE ON public.whatsapp_wabas FROM claimmix_app;
    GRANT SELECT ON public.whatsapp_wabas TO claimmix_app;
  ELSE
    RAISE NOTICE 'claimmix_app no existe en esta base: nada que conceder ni revocar (corré pnpm rol-app y después pnpm permisos)';
  END IF;
END $$;
