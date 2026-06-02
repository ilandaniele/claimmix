-- =============================================================================
-- Migration 0006: customers, customer_contacts, policies, insured_assets
-- =============================================================================
-- Creates tables for customer/policy preloaded data that the AI extraction
-- pipeline matches against. All tables are tenant-scoped with RLS.
--
-- RLS strategy: tenant_id = current_tenant_id() on all SELECT/INSERT/UPDATE/DELETE.
-- Service-role key bypasses RLS for admin bulk import and worker writes.
--
-- IC5: These tables are mandatory (not optional) per spec interpretation contract.
-- AC22: Customer matching priority: policy > dni > email.
-- =============================================================================

-- =============================================================================
-- customers
-- =============================================================================
CREATE TABLE IF NOT EXISTS public.customers (
  id           uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id    uuid NOT NULL REFERENCES public.tenants(id) ON DELETE CASCADE,
  full_name    text NOT NULL,                -- [PII]
  email        text,                         -- [PII]
  dni          text,                         -- [PII] Argentine national ID
  phone        text,                         -- [PII]
  birth_date   date,                         -- [PII]
  address      text,                         -- [PII]
  notes        text,
  created_at   timestamptz NOT NULL DEFAULT now(),
  updated_at   timestamptz
);

-- Trigger: auto-update updated_at on customers
CREATE TRIGGER trg_customers_updated_at
  BEFORE UPDATE ON public.customers
  FOR EACH ROW EXECUTE FUNCTION public.set_updated_at();

-- Indexes for matching (AC22)
CREATE INDEX IF NOT EXISTS idx_customers_tenant_email
  ON public.customers(tenant_id, email)
  WHERE email IS NOT NULL;

CREATE UNIQUE INDEX IF NOT EXISTS idx_customers_tenant_dni
  ON public.customers(tenant_id, dni)
  WHERE dni IS NOT NULL;

-- RLS
ALTER TABLE public.customers ENABLE ROW LEVEL SECURITY;

CREATE POLICY "customers_tenant_all"
  ON public.customers
  FOR ALL
  USING (tenant_id = public.current_tenant_id())
  WITH CHECK (tenant_id = public.current_tenant_id());

-- =============================================================================
-- customer_contacts
-- =============================================================================
-- Stores alternate contact points for a customer (multiple emails, phones, etc.)
-- The main customer.email / customer.phone fields are the primary contacts.
CREATE TABLE IF NOT EXISTS public.customer_contacts (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id     uuid NOT NULL REFERENCES public.tenants(id) ON DELETE CASCADE,
  customer_id   uuid NOT NULL REFERENCES public.customers(id) ON DELETE CASCADE,
  contact_type  text NOT NULL
                  CHECK (contact_type IN ('email', 'phone', 'address', 'dni')),
  value         text NOT NULL,               -- [PII]
  is_primary    boolean NOT NULL DEFAULT false,
  verified_at   timestamptz,
  created_at    timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_customer_contacts_customer_id
  ON public.customer_contacts(customer_id);

CREATE INDEX IF NOT EXISTS idx_customer_contacts_tenant_type_value
  ON public.customer_contacts(tenant_id, contact_type, value);

-- RLS
ALTER TABLE public.customer_contacts ENABLE ROW LEVEL SECURITY;

CREATE POLICY "customer_contacts_tenant_all"
  ON public.customer_contacts
  FOR ALL
  USING (tenant_id = public.current_tenant_id())
  WITH CHECK (tenant_id = public.current_tenant_id());

-- =============================================================================
-- policies
-- =============================================================================
CREATE TABLE IF NOT EXISTS public.policies (
  id             uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id      uuid NOT NULL REFERENCES public.tenants(id) ON DELETE CASCADE,
  customer_id    uuid NOT NULL REFERENCES public.customers(id) ON DELETE CASCADE,
  policy_number  text NOT NULL,              -- [PII]
  policy_type    text NOT NULL DEFAULT 'auto'
                   CHECK (policy_type IN ('auto', 'home', 'life', 'business', 'other')),
  status         text NOT NULL DEFAULT 'active'
                   CHECK (status IN ('active', 'expired', 'cancelled')),
  start_date     date,
  end_date       date,
  premium_amount numeric(12, 2),
  created_at     timestamptz NOT NULL DEFAULT now(),
  updated_at     timestamptz
);

CREATE TRIGGER trg_policies_updated_at
  BEFORE UPDATE ON public.policies
  FOR EACH ROW EXECUTE FUNCTION public.set_updated_at();

-- UNIQUE: one policy_number per tenant (policy numbers are tenant-scoped)
CREATE UNIQUE INDEX IF NOT EXISTS idx_policies_tenant_policy_number
  ON public.policies(tenant_id, policy_number);

CREATE INDEX IF NOT EXISTS idx_policies_tenant_customer
  ON public.policies(tenant_id, customer_id);

-- RLS
ALTER TABLE public.policies ENABLE ROW LEVEL SECURITY;

CREATE POLICY "policies_tenant_all"
  ON public.policies
  FOR ALL
  USING (tenant_id = public.current_tenant_id())
  WITH CHECK (tenant_id = public.current_tenant_id());

-- =============================================================================
-- insured_assets
-- =============================================================================
-- Assets covered by a policy (vehicles, properties, persons).
-- One policy may cover multiple assets.
CREATE TABLE IF NOT EXISTS public.insured_assets (
  id           uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id    uuid NOT NULL REFERENCES public.tenants(id) ON DELETE CASCADE,
  policy_id    uuid NOT NULL REFERENCES public.policies(id) ON DELETE CASCADE,
  asset_type   text NOT NULL
                 CHECK (asset_type IN ('vehicle', 'property', 'person', 'other')),
  make         text,           -- vehicle make (e.g. "Ford")
  model        text,           -- vehicle model (e.g. "Focus")
  year         smallint,       -- model year
  plate        text,           -- [PII] license plate
  vin          text,           -- [PII] vehicle identification number
  description  text,           -- free-text description for non-vehicle assets [PII]
  created_at   timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_insured_assets_tenant_policy
  ON public.insured_assets(tenant_id, policy_id);

-- RLS
ALTER TABLE public.insured_assets ENABLE ROW LEVEL SECURITY;

CREATE POLICY "insured_assets_tenant_all"
  ON public.insured_assets
  FOR ALL
  USING (tenant_id = public.current_tenant_id())
  WITH CHECK (tenant_id = public.current_tenant_id());

-- =============================================================================
-- Add FK columns from cases → customers and cases → policies
-- =============================================================================
-- These are added here (not in 0005) because customers and policies tables
-- must exist before the FK constraints can be defined.

ALTER TABLE public.cases
  ADD COLUMN IF NOT EXISTS customer_id uuid REFERENCES public.customers(id) ON DELETE SET NULL,
  ADD COLUMN IF NOT EXISTS policy_id   uuid REFERENCES public.policies(id) ON DELETE SET NULL;

CREATE INDEX IF NOT EXISTS idx_cases_customer_id
  ON public.cases(customer_id)
  WHERE customer_id IS NOT NULL;

CREATE INDEX IF NOT EXISTS idx_cases_policy_id
  ON public.cases(policy_id)
  WHERE policy_id IS NOT NULL;
