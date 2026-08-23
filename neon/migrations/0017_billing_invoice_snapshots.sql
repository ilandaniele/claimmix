-- Que la factura de un mes cerrado deje de moverse.
--
-- /api/admin/billing recalcula desde `cases` en cada llamada. Mientras el mes
-- corre eso es lo correcto: la cifra tiene que reflejar lo que va pasando. Una
-- vez que el mes terminó deja de serlo, porque la misma consulta puede dar otro
-- número mañana:
--
--   · alguien borra casos viejos con cleanup-junk-cases o reset-cases;
--   · un analista corrige un caso y `is_claim` pasa de true a false;
--   · se afinan los precios del catálogo, o el cliente cambia de plan.
--
-- Ninguna de esas tres es un error — las tres son cosas que el producto hace a
-- propósito. El error es que cambien una factura ya emitida. Un cliente que
-- pide el detalle de marzo en junio tiene que recibir marzo, no marzo
-- recalculado con la realidad de junio, y la diferencia no se nota mirando el
-- total: se nota cuando alguien compara con el PDF que ya pagó.
--
-- Así que el período se congela: la primera vez que se pide un mes que YA
-- TERMINÓ, se guarda la liquidación entera y desde ahí se sirve la copia. Se
-- congela al leer y no por cron porque el plan Hobby permite dos crons por día
-- y los dos ya están ocupados (gmail-poll y reap-stuck).
--
-- Se guardan también los términos que se usaron —abono, incluidos, precio del
-- excedente— y no sólo el total: sin eso la factura no se puede defender línea
-- por línea si el plan del tenant cambió después. Y el detalle completo queda
-- en `payload`, que es lo que respondió la API el día que se cerró.

CREATE TABLE IF NOT EXISTS public.billing_invoices (
  id                 uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id          uuid NOT NULL REFERENCES public.tenants(id) ON DELETE CASCADE,

  -- El período, en el mismo formato canónico que usa resolveBillingPeriod.
  month              text NOT NULL,
  period_start       timestamptz NOT NULL,
  period_end         timestamptz NOT NULL,

  -- Los números que se facturan. Duplicados fuera del payload a propósito:
  -- una consulta de ingresos no tiene que abrir un JSON para sumar.
  billable_claims    integer NOT NULL,
  total_usd          numeric(12, 2) NOT NULL,
  ai_cost_usd        numeric(12, 4) NOT NULL,

  -- Los términos vigentes cuando se cerró. Un contrato firmado no cambia
  -- porque alguien editó la lista de precios en abril.
  plan               text NOT NULL,
  monthly_fee_usd    numeric(10, 2) NOT NULL,
  included_claims    integer NOT NULL,
  overage_price_usd  numeric(10, 4) NOT NULL,

  -- La respuesta entera del día del cierre, para defender la factura completa.
  payload            jsonb NOT NULL,

  frozen_at          timestamptz NOT NULL DEFAULT now(),

  -- Un mes se cierra una sola vez por tenant. Es lo que hace que congelar al
  -- leer sea seguro: dos pedidos simultáneos compiten por esta restricción y
  -- gana uno, en vez de dejar dos liquidaciones distintas del mismo mes.
  CONSTRAINT billing_invoices_tenant_month_key UNIQUE (tenant_id, month),

  -- Un mes es exactamente YYYY-MM. Un typo acá es una factura archivada bajo
  -- un período que no existe, y no se encuentra nunca más.
  CONSTRAINT billing_invoices_month_format CHECK (month ~ '^\d{4}-(0[1-9]|1[0-2])$'),

  -- Nadie factura un total negativo. Un crédito es otra cosa y va aparte.
  CONSTRAINT billing_invoices_amounts_non_negative CHECK (
    billable_claims >= 0 AND total_usd >= 0 AND ai_cost_usd >= 0
  ),

  CONSTRAINT billing_invoices_period_ordered CHECK (period_end > period_start)
);

-- El listado natural: las facturas de un tenant, de la más nueva a la más
-- vieja. Es la consulta que hace la pantalla de facturación.
CREATE INDEX IF NOT EXISTS billing_invoices_tenant_month_idx
  ON public.billing_invoices (tenant_id, month DESC);
