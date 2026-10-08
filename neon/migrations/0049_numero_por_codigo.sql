-- =============================================================================
-- 0049 — Número de WhatsApp por código: la función con la que el inquilino conecta el suyo
-- =============================================================================
--
-- Un espacio del alta automática conecta su propio número: Graph lo agrega a la
-- WABA de la plataforma, manda el código y lo registra. Esta migración pone la
-- única puerta con la que la app escribe lo que Graph contestó.
--
-- public.claimmix_numero_automatico es SECURITY DEFINER porque claimmix_app no
-- tiene UPDATE sobre whatsapp_numeros. Sólo toca la fila del inquilino del
-- contexto, sólo mientras está en 'pedido', sólo si el inquilino es del alta
-- automática, tiene prueba vigente (o está activo) y quien llama es owner o admin.
-- Nunca guarda el id del número de la plataforma, ni uno que ya tenga otra fila.
-- Con el paso 'agregado' deja el phone_number_id; con 'conectado' pasa la fila a
-- 'conectado'. Repetir cualquiera de los dos con el mismo id contesta ok sin
-- escribir de nuevo (un doble clic en «Conectar» no es un error). El token, el
-- PIN y el código no pasan por acá.
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
-- El código tolera que la migración todavía no esté: sin la función (42883) el
-- número automático queda inactivo, nada llama a Graph y la interfaz sigue con lo
-- de hoy («lo conectamos nosotros»).
--
-- Corre con el rol dueño (BYPASSRLS): la función SECURITY DEFINER escribe con
-- sus privilegios y, con RLS forzada, un dueño sin BYPASSRLS no vería ninguna fila.
--
-- Vuelta atrás (la función y, para que migrate.mjs la vuelva a aplicar, su registro):
--   DROP FUNCTION IF EXISTS public.claimmix_numero_automatico(uuid, uuid, text, text, text, text, inet);
--   node scripts/migrate.mjs --env <VAR> --forget 0049
-- =============================================================================

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_roles
     WHERE rolname = current_user AND (rolbypassrls OR rolsuper)
  ) THEN
    RAISE EXCEPTION '0049 tiene que correr con el rol dueño (BYPASSRLS): la función SECURITY DEFINER escribe con sus privilegios';
  END IF;
END $$;

-- Se llama por enTenant({ tenantId }): el contexto tiene que ser el inquilino que conecta.
CREATE OR REPLACE FUNCTION public.claimmix_numero_automatico(
  p_tenant_id uuid,
  p_user_id uuid,
  p_paso text,
  p_phone_number_id text,
  p_waba_id text,
  p_id_plataforma text,
  p_ip inet DEFAULT NULL
) RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, public
AS $$
DECLARE
  v_numero_id uuid;
  v_estado text;
  v_actual text;
BEGIN
  IF p_tenant_id IS NULL
     OR p_tenant_id IS DISTINCT FROM public.claimmix_current_tenant_id() THEN
    RAISE EXCEPTION 'claimmix_numero_automatico: el contexto no es el inquilino'
      USING ERRCODE = '42501';
  END IF;

  IF p_paso IS NULL OR p_paso NOT IN ('agregado', 'conectado')
     OR p_phone_number_id IS NULL OR p_phone_number_id !~ '^[0-9]{6,20}$'
     OR p_waba_id IS NULL OR p_waba_id !~ '^[0-9]{6,20}$'
     OR nullif(btrim(coalesce(p_id_plataforma, '')), '') IS NULL THEN
    RETURN jsonb_build_object('resultado', 'datos_invalidos');
  END IF;

  -- El número de la plataforma no se le asigna a nadie.
  IF p_phone_number_id = btrim(p_id_plataforma) THEN
    RETURN jsonb_build_object('resultado', 'id_de_la_plataforma');
  END IF;

  -- Serializa los pasos: sin esto, dos a la vez se pisan la misma fila.
  PERFORM pg_advisory_xact_lock(hashtext('claimmix_numero'));

  IF NOT EXISTS (
       SELECT 1 FROM public.tenants t
        WHERE t.id = p_tenant_id
          AND t.autoalta
          AND t.billing_status IN ('trial', 'active')
          AND (t.billing_status <> 'trial' OR t.trial_ends_at IS NULL OR t.trial_ends_at > now())
     )
     OR NOT EXISTS (
       SELECT 1 FROM public.users u
        WHERE u.id = p_user_id AND u.tenant_id = p_tenant_id AND u.role IN ('owner', 'admin')
     ) THEN
    RETURN jsonb_build_object('resultado', 'no_aplica');
  END IF;

  SELECT n.id, n.estado, n.phone_number_id
    INTO v_numero_id, v_estado, v_actual
    FROM public.whatsapp_numeros n
   WHERE n.tenant_id = p_tenant_id AND n.estado <> 'baja'
   FOR UPDATE;

  -- 'conectado' repetido: la fila ya quedó así con este mismo id, no hay nada que hacer.
  IF p_paso = 'conectado' AND v_estado = 'conectado' AND v_actual = p_phone_number_id THEN
    RETURN jsonb_build_object('resultado', 'ok');
  END IF;

  IF NOT FOUND OR v_estado <> 'pedido'
     OR (p_paso = 'agregado' AND v_actual IS NOT NULL AND v_actual <> p_phone_number_id)
     OR (p_paso = 'conectado' AND v_actual IS DISTINCT FROM p_phone_number_id) THEN
    RETURN jsonb_build_object('resultado', 'no_aplica');
  END IF;

  -- Repetir el paso con el mismo id no escribe ni asienta nada de nuevo.
  IF p_paso = 'agregado' AND v_actual = p_phone_number_id THEN
    RETURN jsonb_build_object('resultado', 'ok');
  END IF;

  IF EXISTS (
       SELECT 1 FROM public.whatsapp_numeros
        WHERE phone_number_id = p_phone_number_id AND id <> v_numero_id
     ) THEN
    RETURN jsonb_build_object('resultado', 'id_ocupado');
  END IF;

  IF p_paso = 'agregado' THEN
    UPDATE public.whatsapp_numeros
       SET phone_number_id = p_phone_number_id, waba_id = p_waba_id, actualizado_en = now()
     WHERE id = v_numero_id;
  ELSE
    UPDATE public.whatsapp_numeros
       SET estado = 'conectado', waba_id = p_waba_id, conectado_en = now(), actualizado_en = now()
     WHERE id = v_numero_id;
  END IF;

  INSERT INTO public.audit_log (tenant_id, actor_id, event_type, target_type, target_id, payload, ip)
  VALUES (
    p_tenant_id,
    p_user_id,
    CASE p_paso WHEN 'agregado' THEN 'whatsapp.numero_agregado' ELSE 'whatsapp.numero_conectado' END,
    'whatsapp_numero',
    v_numero_id::text,
    jsonb_build_object('via', 'codigo', 'phone_number_id', p_phone_number_id),
    p_ip
  );

  RETURN jsonb_build_object('resultado', 'ok');
END;
$$;

REVOKE ALL ON FUNCTION public.claimmix_numero_automatico(uuid, uuid, text, text, text, text, inet) FROM PUBLIC;

DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'claimmix_app') THEN
    GRANT EXECUTE ON FUNCTION public.claimmix_numero_automatico(uuid, uuid, text, text, text, text, inet) TO claimmix_app;
  ELSE
    RAISE NOTICE 'claimmix_app no existe en esta base: nada que conceder (corré pnpm rol-app y después pnpm permisos)';
  END IF;
END $$;
