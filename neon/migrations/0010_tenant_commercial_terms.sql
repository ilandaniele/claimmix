-- Migration 0010: commercial terms on tenants
--
-- Until now `tenants` held only (id, name, created_at). The product was
-- sellable but the database could not express what a client had agreed to pay,
-- so an invoice could not be derived from the system that produced the work.
-- Cost per tenant was already measured (ai_usage.cost_usd); revenue was not.
--
-- The billable unit is a CLAIM, not a token: a tenant pays a monthly fee that
-- includes N claims, then an overage price per claim beyond that. These columns
-- record that contract so /api/admin/billing can compute what to invoice.
--
-- Plans mirror the commercial pricing sheet:
--   piloto       0 / 300 claims (60-day trial)   / no overage
--   operativo    390 / 750    / 0.45
--   profesional  1100 / 3000  / 0.35
--   corporativo  2900 / 10000 / 0.28
--   enterprise   negotiated   / from 0.20
--
-- Defaults describe a pilot, so every existing and future row is valid without
-- a backfill and nobody is accidentally billed for a plan they never signed.

ALTER TABLE tenants
  ADD COLUMN IF NOT EXISTS plan               text          NOT NULL DEFAULT 'piloto',
  ADD COLUMN IF NOT EXISTS billing_status     text          NOT NULL DEFAULT 'trial',
  ADD COLUMN IF NOT EXISTS monthly_fee_usd    numeric(10,2) NOT NULL DEFAULT 0,
  ADD COLUMN IF NOT EXISTS included_claims    integer       NOT NULL DEFAULT 300,
  ADD COLUMN IF NOT EXISTS overage_price_usd  numeric(10,4) NOT NULL DEFAULT 0,
  ADD COLUMN IF NOT EXISTS contact_email      text,
  ADD COLUMN IF NOT EXISTS trial_ends_at      timestamptz,
  ADD COLUMN IF NOT EXISTS activated_at       timestamptz;

-- Constraints are added separately and guarded: ADD CONSTRAINT has no
-- IF NOT EXISTS in Postgres, so a re-run would abort the whole migration.
DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'tenants_plan_check') THEN
    ALTER TABLE tenants ADD CONSTRAINT tenants_plan_check
      CHECK (plan IN ('piloto','operativo','profesional','corporativo','enterprise'));
  END IF;

  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'tenants_billing_status_check') THEN
    ALTER TABLE tenants ADD CONSTRAINT tenants_billing_status_check
      CHECK (billing_status IN ('trial','active','suspended','churned'));
  END IF;

  -- Negative money is always a bug, never a discount.
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'tenants_amounts_nonneg_check') THEN
    ALTER TABLE tenants ADD CONSTRAINT tenants_amounts_nonneg_check
      CHECK (monthly_fee_usd >= 0 AND overage_price_usd >= 0 AND included_claims >= 0);
  END IF;
END $$;

-- Billing reads "claims created by this tenant in month M". That is the same
-- shape the dashboard already queries, but unbounded over time, so it gets its
-- own index rather than riding on a status-filtered one.
CREATE INDEX IF NOT EXISTS idx_cases_tenant_created_at ON cases (tenant_id, created_at);
