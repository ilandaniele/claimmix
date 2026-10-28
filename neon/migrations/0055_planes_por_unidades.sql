-- =============================================================================
-- 0055 — Catálogo por unidades: el plan «inicial» y la marca de WABA propia por caso
-- =============================================================================
--
-- El cupo de cada plan pasa a contarse en unidades y no en denuncias: un siniestro
-- por WhatsApp en el número de Veltra gasta 1, uno por mail 0,5 y uno por WhatsApp
-- con la WABA propia del cliente 0,8. Tres cosas del esquema lo piden:
--
--   tenants_plan_check    suma el plan 'inicial'. 'piloto' se queda (es el plan
--                         de las altas automáticas en prueba y el default de la
--                         columna): sus términos pasan a ser los de la Prueba.
--   included_claims       el DEFAULT pasa de 300 a 50, las unidades de la Prueba.
--                         claimmix_crear_inquilino no pasa los términos: toma el
--                         default, y por eso su firma no cambia. Sólo alcanza a
--                         las pruebas nuevas: las que ya existen conservan sus
--                         300 guardados (abono 0 y excedente 0, inocuo).
--   cases.waba_propia     el caso nace marcado si entró por una WABA propia del
--                         cliente. Se guarda el hecho y no el peso: el peso es un
--                         término comercial y vive en plans.ts. No se puede
--                         derivar al facturar: en la base de un cliente el espejo
--                         de whatsapp_numeros trae token_cifrado NULL y
--                         whatsapp_wabas no existe, y el número puede cambiar a
--                         mitad del mes.
--
-- Sin UPDATE ni backfill: los términos que cada inquilino ya tiene guardados no
-- cambian, y los casos viejos quedan en false (WhatsApp pesa 1, correcto porque
-- ninguna WABA propia está activa todavía). Sin columna nueva en billing_invoices:
-- las facturas congeladas no se recalculan. Es aditiva y se puede repetir.
--
-- Drizzle nombra cases.waba_propia en cada INSERT y en cada select de la tabla
-- entera: el código desplegado sin la columna da 42703, se corta toda la ingesta
-- (WhatsApp, mail, web), la facturación y la cartera dan 500 y /api/health da
-- caído con «faltan: cases.waba_propia». Y activar el plan 'inicial' en una base
-- sin el CHECK nuevo da 23514. Aplicarla A MANO ANTES de mergear, con
-- `node scripts/migrate.mjs --apply` por TCP, en este orden:
--   1. ep-wispy-flower (QA, QA_DATABASE_URL).
--   2. ep-proud-resonance (la viva, y también la de los secretos DATABASE_URL del CI).
--   3. La rama production de Veltra (STAGING_DATABASE_URL, sólo para ci.yml).
--   4. `node scripts/migrar-bases.mjs --env prd`: control de prd, la rama ensayo y
--      cada base t_<hex> (confirmar el ensayo antes con `--env ensayo --dry`).
-- Identificar cada base por su canal de casos, no por su nombre.
--
-- Verificar después de aplicarla, en cada base:
--   SELECT pg_get_constraintdef(oid) FROM pg_constraint
--    WHERE conrelid = 'public.tenants'::regclass AND conname = 'tenants_plan_check';
--   (tiene que nombrar 'inicial')
--   SELECT column_default FROM information_schema.columns
--    WHERE table_schema = 'public' AND table_name = 'tenants' AND column_name = 'included_claims';
--   (50)
--   SELECT data_type, is_nullable, column_default FROM information_schema.columns
--    WHERE table_schema = 'public' AND table_name = 'cases' AND column_name = 'waba_propia';
--   (boolean, NO, false)
--
-- Vuelta atrás (primero el código; al revés vuelve el 42703). Antes de volver el
-- CHECK hay que llevar a otro plan las filas 'inicial', o el ADD falla:
--   ALTER TABLE public.cases DROP COLUMN IF EXISTS waba_propia;
--   ALTER TABLE public.tenants ALTER COLUMN included_claims SET DEFAULT 300;
--   ALTER TABLE public.tenants DROP CONSTRAINT tenants_plan_check;
--   ALTER TABLE public.tenants ADD CONSTRAINT tenants_plan_check
--     CHECK (plan IN ('piloto','operativo','profesional','corporativo','enterprise'));
--   node scripts/migrate.mjs --env <VAR> --forget 0055 --apply

DO $$
DECLARE
  vigente text;
BEGIN
  SELECT pg_get_constraintdef(c.oid) INTO vigente
    FROM pg_constraint c
   WHERE c.conrelid = 'public.tenants'::regclass AND c.conname = 'tenants_plan_check';

  IF vigente IS NULL THEN
    ALTER TABLE public.tenants ADD CONSTRAINT tenants_plan_check
      CHECK (plan IN ('piloto','inicial','operativo','profesional','corporativo','enterprise'));
  ELSIF vigente NOT ILIKE '%''inicial''%' THEN
    ALTER TABLE public.tenants DROP CONSTRAINT tenants_plan_check;
    ALTER TABLE public.tenants ADD CONSTRAINT tenants_plan_check
      CHECK (plan IN ('piloto','inicial','operativo','profesional','corporativo','enterprise'));
  END IF;
END $$;

ALTER TABLE public.tenants ALTER COLUMN included_claims SET DEFAULT 50;

ALTER TABLE public.cases ADD COLUMN IF NOT EXISTS waba_propia boolean NOT NULL DEFAULT false;
