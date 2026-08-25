-- =============================================================================
-- 0018 — Que la base se niegue, en vez de que el código se acuerde
-- =============================================================================
--
-- Hasta acá, lo único que separaba los datos de una aseguradora de los de otra
-- eran 198 cláusulas `WHERE tenant_id = ...` escritas a mano en 107 archivos.
-- Ciento noventa y ocho oportunidades de olvidarse una.
--
-- La migración 0004 ya había dejado 28 políticas de RLS escritas, y decía en un
-- comentario que eran "un guardarraíl para un futuro rol no-dueño". Ese futuro
-- no llegó, y las políticas nunca corrieron. Se midió, no se dedujo:
--
--   la app se conecta como:  neondb_owner
--   BYPASSRLS:               SÍ          ← saltea toda política, siempre
--   tablas con FORCE RLS:    0
--   → con RLS activado, FORCE activado y la política puesta, una consulta
--     seguía viendo las filas de los DOS inquilinos.
--
-- Son dos agujeros distintos y hay que tapar los dos:
--
--   1. Ser DUEÑO de la tabla exime de sus políticas. Lo arregla FORCE.
--   2. Tener BYPASSRLS exime de todo, incluso con FORCE. Eso NO lo arregla
--      ninguna migración: exige conectarse con OTRO rol.
--
-- Este archivo hace lo que se puede hacer con SQL (1, más las dos políticas que
-- faltaban). El rol de aplicación se crea aparte, porque lleva contraseña y una
-- contraseña no va en un archivo versionado: ver `docs/TENENCIA.md`.
--
-- IMPORTANTE: mientras la app siga conectándose como neondb_owner, esto no
-- cambia nada de nada — ni protege ni rompe. La protección empieza el día que
-- DATABASE_URL apunta al rol nuevo. Está hecho a propósito en ese orden, para
-- que el cambio de riesgo sea una sola variable de entorno, reversible en un
-- minuto.
-- =============================================================================

-- ── 1. Las dos políticas que faltaban ───────────────────────────────────────
--
-- billing_invoices se creó en 0017, esta misma semana, y se le olvidó la
-- política. provider_usage_events viene de antes. Las dos tienen tenant_id y
-- las dos quedaron afuera del barrido de 0004 — que es exactamente la forma en
-- que este problema crece: una tabla nueva por vez.

DO $$
DECLARE
  t text;
BEGIN
  FOREACH t IN ARRAY ARRAY['billing_invoices', 'provider_usage_events'] LOOP
    IF EXISTS (SELECT 1 FROM information_schema.tables
               WHERE table_schema = 'public' AND table_name = t) THEN
      EXECUTE format('ALTER TABLE public.%I ENABLE ROW LEVEL SECURITY', t);
      IF NOT EXISTS (SELECT 1 FROM pg_policies
                     WHERE schemaname = 'public' AND tablename = t
                       AND policyname = 'claimmix_tenant_isolation') THEN
        EXECUTE format(
          'CREATE POLICY claimmix_tenant_isolation ON public.%I
             USING (public.claimmix_tenant_matches(tenant_id))', t);
      END IF;
    END IF;
  END LOOP;
END $$;

-- ── 2. FORCE en todo lo que tenga tenant_id ─────────────────────────────────
--
-- Se recorre el catálogo en vez de listar las tablas a mano, justamente para
-- que una tabla nueva no se quede afuera por olvido. Lo mismo vale para las
-- políticas: si una tabla tiene tenant_id y no tiene política, se le pone.

DO $$
DECLARE
  t text;
  sin_politica text[] := ARRAY[]::text[];
BEGIN
  FOR t IN
    SELECT c.table_name
    FROM information_schema.columns c
    JOIN information_schema.tables tb
      ON tb.table_schema = c.table_schema AND tb.table_name = c.table_name
    WHERE c.table_schema = 'public'
      AND c.column_name = 'tenant_id'
      AND tb.table_type = 'BASE TABLE'
    ORDER BY c.table_name
  LOOP
    EXECUTE format('ALTER TABLE public.%I ENABLE ROW LEVEL SECURITY', t);
    EXECUTE format('ALTER TABLE public.%I FORCE ROW LEVEL SECURITY', t);

    IF NOT EXISTS (SELECT 1 FROM pg_policies
                   WHERE schemaname = 'public' AND tablename = t) THEN
      sin_politica := sin_politica || t;
    END IF;
  END LOOP;

  -- Una tabla con FORCE y sin política no devuelve NADA, ni al dueño. Es un
  -- modo de falla ruidoso y eso está bien —mejor que devolver de más— pero no
  -- puede pasar en silencio.
  IF array_length(sin_politica, 1) > 0 THEN
    RAISE EXCEPTION 'Tablas con FORCE RLS y sin política (no devolverían nada): %',
      array_to_string(sin_politica, ', ');
  END IF;
END $$;

-- ── 3. Que la tabla `tenants` no se cierre sobre sí misma ───────────────────
--
-- `tenants` tiene la columna `id`, no `tenant_id`, así que el barrido de arriba
-- no la toca — y está bien: si se cerrara, ni siquiera se podría resolver a qué
-- inquilino pertenece una sesión. El aislamiento de esa tabla se hace en la
-- capa de datos, que nunca la lista entera.

-- ── 4. Dejar constancia de qué quedó, para poder verificarlo ────────────────

COMMENT ON FUNCTION public.claimmix_current_tenant_id() IS
  'Lee claimmix.tenant_id de la transacción en curso. Lo pone la capa de datos '
  'con set_config(..., true) al abrir cada transacción. Si no está puesto '
  'devuelve NULL, y entonces ninguna fila coincide: cero filas, no todas.';
