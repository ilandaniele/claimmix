-- =============================================================================
-- ClaimMix — Neon (plain Postgres 17) consolidated init migration
-- =============================================================================
-- Provenance: adapted from supabase/all.sql (migrations 0001–0013 + inline
-- gmail_accounts block) merged with supabase/migrations/0014_agent_learning.sql,
-- 0015_tenant_ai_settings.sql and 0016_user_locale.sql, so this file is the
-- FINAL schema as of 0016.
--
-- Differences vs. the Supabase original:
--   * ALL Row Level Security (ENABLE/FORCE RLS + CREATE POLICY) removed —
--     tenant isolation is enforced at the application layer now.
--   * current_tenant_id() and everything referencing auth.uid()/auth.jwt()
--     removed (no Supabase auth schema on Neon).
--   * No GRANT/REVOKE for anon/authenticated/service_role roles.
--   * No storage schema / supabase_realtime artifacts (the claim-attachments
--     bucket is replaced by app-level object storage).
--   * Better Auth tables ("user", session, account, verification) added at the
--     top; public.users.id now references "user"(id) instead of auth.users(id).
--   * users.role already widened to ('owner','admin','specialist','analyst',
--     'viewer') and users.locale included (0014/0016 merged in).
--   * New index idx_cases_tenant_updated_at for the case-list polling endpoint.
--   * Reference/config seeds kept (required_docs_config, global
--     known_claim_patterns). Demo data lives in neon/seed.sql (optional).
--
-- Runnable top-to-bottom in a single transaction on a fresh database, e.g.:
--   psql "$DATABASE_URL" -1 -f neon/migrations/0001_init.sql
-- =============================================================================

-- =============================================================================
-- Extensions
-- =============================================================================
CREATE EXTENSION IF NOT EXISTS "uuid-ossp";
CREATE EXTENSION IF NOT EXISTS pgcrypto;

-- =============================================================================
-- Better Auth tables (snake_case columns, uuid ids)
-- Must come before public.users, which references "user"(id).
-- =============================================================================
create table "user" (
  id uuid primary key default gen_random_uuid(),
  name text not null,
  email text not null unique,
  email_verified boolean not null default false,
  image text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  role text,
  banned boolean default false,
  ban_reason text,
  ban_expires timestamptz
);

create table session (
  id uuid primary key default gen_random_uuid(),
  expires_at timestamptz not null,
  token text not null unique,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  ip_address text,
  user_agent text,
  user_id uuid not null references "user"(id) on delete cascade,
  impersonated_by text
);

create index session_user_id_idx on session(user_id);

create table account (
  id uuid primary key default gen_random_uuid(),
  account_id text not null,
  provider_id text not null,
  user_id uuid not null references "user"(id) on delete cascade,
  access_token text,
  refresh_token text,
  id_token text,
  access_token_expires_at timestamptz,
  refresh_token_expires_at timestamptz,
  scope text,
  password text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create index account_user_id_idx on account(user_id);

create table verification (
  id uuid primary key default gen_random_uuid(),
  identifier text not null,
  value text not null,
  expires_at timestamptz not null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create index verification_identifier_idx on verification(identifier);

-- =============================================================================
-- tenants
-- =============================================================================
CREATE TABLE public.tenants (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  name        text NOT NULL,
  created_at  timestamptz NOT NULL DEFAULT now()
);

-- =============================================================================
-- users (extends Better Auth "user"; final shape after 0014 + 0016)
-- =============================================================================
CREATE TABLE public.users (
  id          uuid PRIMARY KEY REFERENCES "user"(id) ON DELETE CASCADE,
  tenant_id   uuid NOT NULL REFERENCES public.tenants(id) ON DELETE CASCADE,
  full_name   text NOT NULL,
  role        text NOT NULL DEFAULT 'analyst'
                CONSTRAINT users_role_check
                CHECK (role IN ('owner', 'admin', 'specialist', 'analyst', 'viewer')),
  locale      text
                CHECK (locale IS NULL OR locale IN ('es-AR', 'en-US')),
  created_at  timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX idx_users_tenant_role ON public.users(tenant_id, role);

-- =============================================================================
-- Trigger function: set_updated_at (shared by all *_updated_at triggers)
-- =============================================================================
CREATE OR REPLACE FUNCTION public.set_updated_at()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
  NEW.updated_at = now();
  RETURN NEW;
END;
$$;

-- =============================================================================
-- customers (created before cases — cases.customer_id references it)
-- =============================================================================
CREATE TABLE public.customers (
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

CREATE TRIGGER trg_customers_updated_at
  BEFORE UPDATE ON public.customers
  FOR EACH ROW EXECUTE FUNCTION public.set_updated_at();

CREATE INDEX idx_customers_tenant_email
  ON public.customers(tenant_id, email)
  WHERE email IS NOT NULL;

CREATE UNIQUE INDEX idx_customers_tenant_dni
  ON public.customers(tenant_id, dni)
  WHERE dni IS NOT NULL;

-- =============================================================================
-- customer_contacts (alternate contact points for a customer)
-- =============================================================================
CREATE TABLE public.customer_contacts (
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

CREATE INDEX idx_customer_contacts_customer_id
  ON public.customer_contacts(customer_id);

CREATE INDEX idx_customer_contacts_tenant_type_value
  ON public.customer_contacts(tenant_id, contact_type, value);

-- =============================================================================
-- policies (created before cases — cases.policy_id references it)
-- =============================================================================
CREATE TABLE public.policies (
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

-- One policy_number per tenant (policy numbers are tenant-scoped)
CREATE UNIQUE INDEX idx_policies_tenant_policy_number
  ON public.policies(tenant_id, policy_number);

CREATE INDEX idx_policies_tenant_customer
  ON public.policies(tenant_id, customer_id);

-- =============================================================================
-- insured_assets (assets covered by a policy)
-- =============================================================================
CREATE TABLE public.insured_assets (
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

CREATE INDEX idx_insured_assets_tenant_policy
  ON public.insured_assets(tenant_id, policy_id);

-- =============================================================================
-- cases (final shape after 0005 email intake + 0006 FKs + 0012 nullable type)
-- =============================================================================
CREATE TABLE public.cases (
  id                 uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id          uuid NOT NULL REFERENCES public.tenants(id) ON DELETE CASCADE,
  policy_number      text,
  policyholder_name  text,
  claim_type         text
                       CONSTRAINT cases_claim_type_check
                       CHECK (
                         claim_type IS NULL
                         OR claim_type IN ('choque', 'robo', 'granizo', 'incendio', 'other')
                       ),
  status             text NOT NULL DEFAULT 'procesando'
                       CONSTRAINT cases_status_check
                       CHECK (status IN (
                         -- Original statuses
                         'procesando',
                         'listo',
                         'esperando',
                         'escalado',
                         'cerrado',
                         -- Email-intake statuses (IC6)
                         'recibido',
                         'info_faltante',
                         'confirmacion_pendiente',
                         'requiere_especialista',
                         'listo_para_core',
                         'enviado_a_core',
                         'error_core',
                         'no_relevante'
                       )),
  confidence_min     numeric(3, 2)
                       CHECK (confidence_min IS NULL OR (confidence_min >= 0 AND confidence_min <= 1)),
  assigned_to        uuid REFERENCES public.users(id) ON DELETE SET NULL,
  channel            text NOT NULL DEFAULT 'email_sim'
                       CHECK (channel IN ('email_sim', 'email', 'whatsapp_sim', 'whatsapp')),
  created_at         timestamptz NOT NULL DEFAULT now(),
  updated_at         timestamptz,
  closed_at          timestamptz,
  -- Email intake (0005)
  email_message_id   text,
  email_thread_id    text,
  is_claim           boolean DEFAULT NULL,
  not_relevant_reason text,
  requires_specialist boolean NOT NULL DEFAULT false,
  severity           text
                       CHECK (severity IS NULL OR severity IN ('low', 'medium', 'high', 'critical')),
  core_external_id   text,
  core_error_message text,
  core_sent_at       timestamptz,
  fields_pending_confirmation jsonb NOT NULL DEFAULT '[]',
  -- Customer/policy linkage (0006)
  customer_id        uuid REFERENCES public.customers(id) ON DELETE SET NULL,
  policy_id          uuid REFERENCES public.policies(id) ON DELETE SET NULL
);

CREATE INDEX idx_cases_tenant_status  ON public.cases(tenant_id, status);
CREATE INDEX idx_cases_tenant_type    ON public.cases(tenant_id, claim_type);
CREATE INDEX idx_cases_tenant_created ON public.cases(tenant_id, created_at DESC);
CREATE INDEX idx_cases_assigned_to    ON public.cases(assigned_to);

-- Idempotency: one provider MessageID per tenant (partial — email cases only)
CREATE UNIQUE INDEX idx_cases_tenant_email_message_id
  ON public.cases(tenant_id, email_message_id)
  WHERE email_message_id IS NOT NULL;

CREATE INDEX idx_cases_tenant_email_thread_id
  ON public.cases(tenant_id, email_thread_id)
  WHERE email_thread_id IS NOT NULL;

CREATE INDEX idx_cases_tenant_severity
  ON public.cases(tenant_id, severity)
  WHERE severity IS NOT NULL;

CREATE INDEX idx_cases_customer_id
  ON public.cases(customer_id)
  WHERE customer_id IS NOT NULL;

CREATE INDEX idx_cases_policy_id
  ON public.cases(policy_id)
  WHERE policy_id IS NOT NULL;

-- New on Neon: supports the case-list polling endpoint (ORDER BY updated_at)
CREATE INDEX idx_cases_tenant_updated_at
  ON public.cases(tenant_id, updated_at DESC);

CREATE TRIGGER trg_cases_updated_at
  BEFORE UPDATE ON public.cases
  FOR EACH ROW EXECUTE FUNCTION public.set_updated_at();

-- =============================================================================
-- raw_messages (inbound email/whatsapp bodies — stored verbatim, PII tagged)
-- =============================================================================
CREATE TABLE public.raw_messages (
  id           uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  case_id      uuid NOT NULL REFERENCES public.cases(id) ON DELETE CASCADE,
  tenant_id    uuid NOT NULL REFERENCES public.tenants(id) ON DELETE CASCADE,
  channel      text NOT NULL,
  from_addr    text,    -- [PII]
  subject      text,    -- [PII]
  body         text NOT NULL, -- [PII] full email body, stored verbatim
  received_at  timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX idx_raw_messages_case_id ON public.raw_messages(case_id);

-- =============================================================================
-- extracted_fields (per-field AI extraction results)
-- =============================================================================
CREATE TABLE public.extracted_fields (
  id               uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  case_id          uuid NOT NULL REFERENCES public.cases(id) ON DELETE CASCADE,
  tenant_id        uuid NOT NULL REFERENCES public.tenants(id) ON DELETE CASCADE,
  field_key        text NOT NULL,  -- e.g. 'date', 'location', 'party_a_plate'
  field_value      text NOT NULL,  -- [PII]
  confidence       numeric(3, 2) NOT NULL
                     CHECK (confidence >= 0 AND confidence <= 1),
  extracted_at     timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT uq_extracted_field UNIQUE (case_id, field_key)
);

CREATE INDEX idx_extracted_fields_case_id ON public.extracted_fields(case_id);

-- =============================================================================
-- missing_docs (gap analysis results)
-- =============================================================================
CREATE TABLE public.missing_docs (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  case_id       uuid NOT NULL REFERENCES public.cases(id) ON DELETE CASCADE,
  tenant_id     uuid NOT NULL REFERENCES public.tenants(id) ON DELETE CASCADE,
  doc_key       text NOT NULL,  -- e.g. 'foto_oblea_vtv', 'denuncia_policial'
  requested_at  timestamptz,
  satisfied_at  timestamptz
);

CREATE INDEX idx_missing_docs_case_id ON public.missing_docs(case_id);

-- =============================================================================
-- outbound_messages (legacy split model — superseded by claim_messages for
-- new writes, kept during the dual-write window)
-- =============================================================================
CREATE TABLE public.outbound_messages (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  case_id       uuid NOT NULL REFERENCES public.cases(id) ON DELETE CASCADE,
  tenant_id     uuid NOT NULL REFERENCES public.tenants(id) ON DELETE CASCADE,
  channel       text NOT NULL,
  template      text NOT NULL,  -- e.g. 'request_missing_docs'
  rendered_body text NOT NULL,
  status        text NOT NULL DEFAULT 'queued'
                  CHECK (status IN ('queued', 'sent', 'failed')),
  created_at    timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX idx_outbound_messages_case_id ON public.outbound_messages(case_id);

-- =============================================================================
-- audit_log (immutable audit trail — append-only by application convention)
-- =============================================================================
CREATE TABLE public.audit_log (
  id           bigserial PRIMARY KEY,
  tenant_id    uuid NOT NULL,  -- not FK'd to allow logging even on tenant delete events
  actor_id     uuid REFERENCES public.users(id) ON DELETE SET NULL,
  event_type   text NOT NULL,  -- e.g. 'auth.success', 'case.closed', 'ai.extracted'
  target_type  text,           -- e.g. 'case'
  target_id    text,
  payload      jsonb NOT NULL DEFAULT '{}',  -- NEVER include DNI/policy/full_name
  ip           inet,
  ua           text,
  created_at   timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX idx_audit_log_tenant_created ON public.audit_log(tenant_id, created_at DESC);
CREATE INDEX idx_audit_log_target         ON public.audit_log(target_type, target_id);

-- =============================================================================
-- ai_usage (token budget tracking — immutable)
-- =============================================================================
CREATE TABLE public.ai_usage (
  id                bigserial PRIMARY KEY,
  tenant_id         uuid NOT NULL,
  user_id           uuid REFERENCES public.users(id) ON DELETE SET NULL,
  model             text NOT NULL,
  prompt_tokens     integer NOT NULL DEFAULT 0,
  completion_tokens integer NOT NULL DEFAULT 0,
  cost_usd          numeric(10, 4) NOT NULL DEFAULT 0,
  created_at        timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX idx_ai_usage_tenant_created ON public.ai_usage(tenant_id, created_at DESC);
CREATE INDEX idx_ai_usage_user_created   ON public.ai_usage(user_id, created_at DESC);

-- =============================================================================
-- required_docs_config (reference config — required docs per claim type)
-- =============================================================================
CREATE TABLE public.required_docs_config (
  claim_type  text NOT NULL,
  doc_key     text NOT NULL,
  label_es    text NOT NULL,
  required    boolean NOT NULL DEFAULT true,
  PRIMARY KEY (claim_type, doc_key)
);

-- Reference config seed (kept in the init migration — not sample data).
INSERT INTO public.required_docs_config (claim_type, doc_key, label_es, required) VALUES
  -- choque (collision)
  ('choque', 'parte_amistoso',   'Parte de accidente amistoso',        true),
  ('choque', 'fotos_danos',      'Fotografías de los daños',           true),
  ('choque', 'licencia_conducir','Licencia de conducir del asegurado', true),

  -- robo (theft)
  ('robo',   'denuncia_policial','Denuncia policial',                  true),
  ('robo',   'fotos_lugar',      'Fotografías del lugar del hecho',    true),

  -- granizo (hail)
  ('granizo','foto_oblea_vtv',   'Fotografía de la oblea VTV',         true),
  ('granizo','fotos_danos',      'Fotografías de los daños por granizo',true),

  -- incendio (fire)
  ('incendio','informe_bomberos','Informe de bomberos',                true),
  ('incendio','fotos_danos',     'Fotografías de los daños por incendio',true),
  ('incendio','denuncia_policial','Denuncia policial (si aplica)',      true)

ON CONFLICT (claim_type, doc_key) DO UPDATE
  SET label_es = EXCLUDED.label_es,
      required = EXCLUDED.required;

-- =============================================================================
-- claim_messages (unified inbound + outbound email store — 0009)
-- =============================================================================
CREATE TABLE public.claim_messages (
  id                   uuid        PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id            uuid        NOT NULL REFERENCES public.tenants(id) ON DELETE CASCADE,
  case_id              uuid        NOT NULL REFERENCES public.cases(id) ON DELETE CASCADE,
  direction            text        NOT NULL
                         CHECK (direction IN ('inbound', 'outbound')),
  provider             text        NOT NULL DEFAULT 'postmark',
  -- NULL only for outbound rows in status='queued' (set after send).
  -- [PII-adjacent] — do not log this value.
  provider_message_id  text,
  thread_id            text,
  in_reply_to          text,
  from_addr            text,        -- [PII] inbound: claimant address
  to_addr              text,        -- [PII] outbound: claimant address; inbound: intake inbox
  subject              text,        -- [PII]
  body_text            text,        -- [PII]
  body_html            text,        -- [PII]
  headers              jsonb       NOT NULL DEFAULT '[]'::jsonb,  -- [PII]
  raw_payload          jsonb,       -- [PII] verbatim inbound JSON; NULL for outbound
  template             text,        -- outbound template key; NULL for inbound
  status               text        NOT NULL
                         CHECK (status IN ('received', 'queued', 'sent', 'failed')),
  error_code           text,
  received_at          timestamptz NOT NULL DEFAULT now(),
  sent_at              timestamptz
);

-- Deduplication: one provider MessageID per tenant (both directions)
CREATE UNIQUE INDEX idx_claim_messages_tenant_provider_msgid
  ON public.claim_messages (tenant_id, provider_message_id)
  WHERE provider_message_id IS NOT NULL;

-- Case timeline
CREATE INDEX idx_claim_messages_case_received
  ON public.claim_messages (case_id, received_at DESC);

-- Thread lookup (reply → case)
CREATE INDEX idx_claim_messages_tenant_thread
  ON public.claim_messages (tenant_id, thread_id)
  WHERE thread_id IS NOT NULL;

-- Operational queries (queued outbound / failed inbound)
CREATE INDEX idx_claim_messages_direction_status
  ON public.claim_messages (direction, status);

-- =============================================================================
-- claim_attachments (email attachment metadata — final shape after 0009)
-- =============================================================================
CREATE TABLE public.claim_attachments (
  id                 uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id          uuid NOT NULL REFERENCES public.tenants(id) ON DELETE CASCADE,
  case_id            uuid NOT NULL REFERENCES public.cases(id) ON DELETE CASCADE,
  created_at         timestamptz NOT NULL DEFAULT now(),
  file_name          text NOT NULL,
  content_type       text NOT NULL,
  size_bytes         integer NOT NULL CHECK (size_bytes >= 0),
  external_url       text,           -- provider CDN URL (expires ~7 days)
  storage_path       text,           -- re-hosted object storage path
  content_hash       text,           -- SHA-256 hex of file content
  source_message_id  text,           -- provider MessageID this attachment came from
  claim_message_id   uuid REFERENCES public.claim_messages(id) ON DELETE CASCADE,
  rejected_reason    text            -- NULL = accepted
);

CREATE INDEX idx_claim_attachments_case_id
  ON public.claim_attachments(case_id);

CREATE INDEX idx_claim_attachments_tenant_case
  ON public.claim_attachments(tenant_id, case_id);

CREATE INDEX idx_claim_attachments_claim_message_id
  ON public.claim_attachments (claim_message_id)
  WHERE claim_message_id IS NOT NULL;

-- =============================================================================
-- claim_field_confirmations (analyst review of AI-extracted fields)
-- =============================================================================
CREATE TABLE public.claim_field_confirmations (
  id                  uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id           uuid NOT NULL REFERENCES public.tenants(id) ON DELETE CASCADE,
  case_id             uuid NOT NULL REFERENCES public.cases(id) ON DELETE CASCADE,
  created_at          timestamptz NOT NULL DEFAULT now(),
  updated_at          timestamptz,
  field_name          text NOT NULL,       -- e.g. 'full_name', 'dni', 'policy_number'
  suggested_value     text,                -- [PII] AI-extracted value
  conflict_with_value text,                -- [PII] existing stored value (if conflict)
  confidence          numeric(3, 2) NOT NULL
                        CHECK (confidence >= 0 AND confidence <= 1),
  status              text NOT NULL DEFAULT 'pending'
                        CHECK (status IN ('pending', 'confirmed', 'rejected', 'corrected')),
  confirmed_by        uuid REFERENCES public.users(id) ON DELETE SET NULL,
  confirmed_at        timestamptz,
  notes               text
);

CREATE TRIGGER trg_claim_field_confirmations_updated_at
  BEFORE UPDATE ON public.claim_field_confirmations
  FOR EACH ROW EXECUTE FUNCTION public.set_updated_at();

CREATE INDEX idx_claim_field_confirmations_case_id
  ON public.claim_field_confirmations(case_id);

CREATE INDEX idx_claim_field_confirmations_tenant_status
  ON public.claim_field_confirmations(tenant_id, status)
  WHERE status = 'pending';

-- =============================================================================
-- claim_memory (per-sender memory store for extraction context)
-- =============================================================================
CREATE TABLE public.claim_memory (
  id                   uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id            uuid NOT NULL REFERENCES public.tenants(id) ON DELETE CASCADE,
  created_at           timestamptz NOT NULL DEFAULT now(),
  updated_at           timestamptz,
  memory_type          text NOT NULL DEFAULT 'sender_profile'
                         CHECK (memory_type IN (
                           'sender_profile',   -- per-sender confirmed fields
                           'field_correction', -- analyst-corrected field history
                           'pattern',          -- observed email structural patterns
                           'policy_link'       -- confirmed sender→policy association
                         )),
  key                  text NOT NULL,   -- typically sender_email (or pattern key)
  value                jsonb NOT NULL DEFAULT '{}',
  confidence           double precision CHECK (confidence IS NULL OR (confidence >= 0 AND confidence <= 1)),
  source               text,           -- e.g. 'manual', 'ai', 'confirmation'
  last_used_at         timestamptz,
  use_count            integer NOT NULL DEFAULT 0 CHECK (use_count >= 0)
);

CREATE TRIGGER trg_claim_memory_updated_at
  BEFORE UPDATE ON public.claim_memory
  FOR EACH ROW EXECUTE FUNCTION public.set_updated_at();

CREATE UNIQUE INDEX idx_claim_memory_tenant_type_key
  ON public.claim_memory(tenant_id, memory_type, key);

CREATE INDEX idx_claim_memory_tenant
  ON public.claim_memory(tenant_id);

-- =============================================================================
-- known_claim_patterns (keyword/phrase/regex signals for pre-LLM classification)
-- Global rows have tenant_id = NULL (visible to all tenants — app-layer rule).
-- =============================================================================
CREATE TABLE public.known_claim_patterns (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id     uuid REFERENCES public.tenants(id) ON DELETE CASCADE,  -- NULL = global
  created_at    timestamptz NOT NULL DEFAULT now(),
  pattern_text  text NOT NULL,
  pattern_type  text NOT NULL DEFAULT 'keyword'
                  CHECK (pattern_type IN ('keyword', 'phrase', 'regex')),
  claim_type    text,          -- e.g. 'auto', 'incendio', 'robo'; NULL = any
  severity_hint text
                  CHECK (severity_hint IS NULL OR severity_hint IN (
                    'low', 'medium', 'high', 'critical'
                  )),
  language      text NOT NULL DEFAULT 'es-AR',
  enabled       boolean NOT NULL DEFAULT true
);

CREATE INDEX idx_known_claim_patterns_tenant
  ON public.known_claim_patterns(tenant_id)
  WHERE tenant_id IS NOT NULL;

CREATE INDEX idx_known_claim_patterns_global
  ON public.known_claim_patterns(enabled)
  WHERE tenant_id IS NULL AND enabled = true;

-- Reference config seed (global es-AR severity signals — not sample data).
INSERT INTO public.known_claim_patterns
  (tenant_id, pattern_text, pattern_type, severity_hint, language, enabled)
VALUES
  -- ── CRITICAL ──
  (NULL, 'fallecido',              'keyword', 'critical', 'es-AR', true),
  (NULL, 'fallecimiento',          'keyword', 'critical', 'es-AR', true),
  (NULL, 'muerte',                 'keyword', 'critical', 'es-AR', true),
  (NULL, 'muerto',                 'keyword', 'critical', 'es-AR', true),
  (NULL, 'muerta',                 'keyword', 'critical', 'es-AR', true),
  (NULL, 'incendio',               'keyword', 'critical', 'es-AR', true),
  (NULL, 'robo a mano armada',     'phrase',  'critical', 'es-AR', true),
  (NULL, 'amenaza con arma',       'phrase',  'critical', 'es-AR', true),
  (NULL, 'amenaza',                'keyword', 'critical', 'es-AR', true),
  (NULL, 'explosión',              'keyword', 'critical', 'es-AR', true),
  (NULL, 'explosion',              'keyword', 'critical', 'es-AR', true),

  -- ── HIGH ──
  (NULL, 'ambulancia',             'keyword', 'high', 'es-AR', true),
  (NULL, 'hospitalizado',          'keyword', 'high', 'es-AR', true),
  (NULL, 'hospitalizada',          'keyword', 'high', 'es-AR', true),
  (NULL, 'herido',                 'keyword', 'high', 'es-AR', true),
  (NULL, 'herida',                 'keyword', 'high', 'es-AR', true),
  (NULL, 'lesiones',               'keyword', 'high', 'es-AR', true),
  (NULL, 'lesionado',              'keyword', 'high', 'es-AR', true),
  (NULL, 'lesionada',              'keyword', 'high', 'es-AR', true),
  (NULL, 'policía',                'keyword', 'high', 'es-AR', true),
  (NULL, 'policia',                'keyword', 'high', 'es-AR', true),
  (NULL, 'urgencia',               'keyword', 'high', 'es-AR', true),
  (NULL, 'robo',                   'keyword', 'high', 'es-AR', true),
  (NULL, 'hurto',                  'keyword', 'high', 'es-AR', true),

  -- ── MEDIUM ──
  (NULL, 'choque',                 'keyword', 'medium', 'es-AR', true),
  (NULL, 'colisión',               'keyword', 'medium', 'es-AR', true),
  (NULL, 'colision',               'keyword', 'medium', 'es-AR', true),
  (NULL, 'accidente',              'keyword', 'medium', 'es-AR', true),
  (NULL, 'granizo',                'keyword', 'medium', 'es-AR', true),
  (NULL, 'inundación',             'keyword', 'medium', 'es-AR', true),
  (NULL, 'inundacion',             'keyword', 'medium', 'es-AR', true),
  (NULL, 'chocaron',               'keyword', 'medium', 'es-AR', true),

  -- ── LOW ──
  (NULL, 'rayones',                'keyword', 'low', 'es-AR', true),
  (NULL, 'rayón',                  'keyword', 'low', 'es-AR', true),
  (NULL, 'golpe leve',             'phrase',  'low', 'es-AR', true),
  (NULL, 'daño menor',             'phrase',  'low', 'es-AR', true),
  (NULL, 'raspón',                 'keyword', 'low', 'es-AR', true),
  (NULL, 'raspones',               'keyword', 'low', 'es-AR', true),
  (NULL, 'abolladura leve',        'phrase',  'low', 'es-AR', true),
  (NULL, 'daño estético',          'phrase',  'low', 'es-AR', true),
  (NULL, 'sin heridos',            'phrase',  'low', 'es-AR', true)
ON CONFLICT DO NOTHING;

-- =============================================================================
-- gmail_poll_state (Gmail polling watermark — final shape after 0011)
-- =============================================================================
CREATE TABLE public.gmail_poll_state (
  id                   uuid        PRIMARY KEY DEFAULT gen_random_uuid(),
  gmail_account_email  text        NOT NULL,   -- PII-adjacent; do not log
  history_id           text        NOT NULL DEFAULT '1',
  last_polled_at       timestamptz,
  last_error           text,                   -- capped at 500 chars by the app
  created_at           timestamptz NOT NULL DEFAULT now(),
  updated_at           timestamptz NOT NULL DEFAULT now(),
  -- Watch subscription tracking (0011)
  watch_expiration     timestamptz NULL,
  watch_history_id     text        NULL
);

CREATE UNIQUE INDEX idx_gmail_poll_state_account
  ON public.gmail_poll_state (gmail_account_email);

COMMENT ON COLUMN public.gmail_poll_state.history_id IS
  'Last Gmail API historyId successfully processed. Incremented after all messages in that history batch succeed. Non-PII.';

COMMENT ON COLUMN public.gmail_poll_state.gmail_account_email IS
  'The Gmail address being polled. PII-adjacent — treat as sensitive.';

COMMENT ON COLUMN public.gmail_poll_state.last_error IS
  'Last non-fatal error string (capped at 500 chars). Watermark is NOT advanced when this is set.';

COMMENT ON COLUMN public.gmail_poll_state.watch_expiration IS
  'Timestamp when the active Gmail watch subscription expires (returned by users.watch() as ms epoch, converted to timestamptz). NULL means no active watch. Non-PII.';

COMMENT ON COLUMN public.gmail_poll_state.watch_history_id IS
  'historyId returned by users.watch() at subscription time. Used as starting watermark for the first Pub/Sub-triggered history.list call. NULL means no active watch. Non-PII.';

-- =============================================================================
-- gmail_accounts (multi Gmail intake accounts)
-- =============================================================================
CREATE TABLE public.gmail_accounts (
  id                      uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id               uuid NOT NULL REFERENCES public.tenants(id) ON DELETE CASCADE,
  email                   text NOT NULL,
  refresh_token_encrypted text NOT NULL,
  enabled                 boolean NOT NULL DEFAULT true,
  connected_by            uuid REFERENCES public.users(id) ON DELETE SET NULL,
  last_connected_at       timestamptz,
  last_error              text,
  created_at              timestamptz NOT NULL DEFAULT now(),
  updated_at              timestamptz
);

CREATE TRIGGER trg_gmail_accounts_updated_at
  BEFORE UPDATE ON public.gmail_accounts
  FOR EACH ROW EXECUTE FUNCTION public.set_updated_at();

CREATE UNIQUE INDEX idx_gmail_accounts_tenant_email
  ON public.gmail_accounts(tenant_id, email);

CREATE INDEX idx_gmail_accounts_enabled
  ON public.gmail_accounts(enabled)
  WHERE enabled = true;

-- =============================================================================
-- agent_training (tenant-level mutable agent training instructions — 0013)
-- =============================================================================
CREATE TABLE public.agent_training (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id   uuid NOT NULL REFERENCES public.tenants(id) ON DELETE CASCADE,
  created_at  timestamptz NOT NULL DEFAULT now(),
  updated_at  timestamptz,
  title       text NOT NULL DEFAULT 'Email intake agent training',
  content     text NOT NULL DEFAULT '',
  enabled     boolean NOT NULL DEFAULT true,
  updated_by  uuid REFERENCES public.users(id) ON DELETE SET NULL
);

CREATE TRIGGER trg_agent_training_updated_at
  BEFORE UPDATE ON public.agent_training
  FOR EACH ROW EXECUTE FUNCTION public.set_updated_at();

CREATE UNIQUE INDEX idx_agent_training_tenant_title
  ON public.agent_training(tenant_id, title);

CREATE INDEX idx_agent_training_tenant_enabled
  ON public.agent_training(tenant_id, enabled)
  WHERE enabled = true;

-- =============================================================================
-- prompt_versions (versioned system prompts — 0014)
-- =============================================================================
CREATE TABLE public.prompt_versions (
  id             uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id      uuid NOT NULL REFERENCES public.tenants(id) ON DELETE CASCADE,
  version        text NOT NULL,
  system_prompt  text NOT NULL DEFAULT '',
  active         boolean NOT NULL DEFAULT false,
  created_by     uuid REFERENCES public.users(id) ON DELETE SET NULL,
  created_at     timestamptz NOT NULL DEFAULT now()
);

CREATE UNIQUE INDEX idx_prompt_versions_tenant_version
  ON public.prompt_versions(tenant_id, version);

-- At most one active prompt version per tenant.
CREATE UNIQUE INDEX idx_prompt_versions_tenant_active
  ON public.prompt_versions(tenant_id)
  WHERE active = true;

-- =============================================================================
-- agent_runs (one row per agent execution over an email — 0014)
-- =============================================================================
CREATE TABLE public.agent_runs (
  id                       uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id                uuid NOT NULL REFERENCES public.tenants(id) ON DELETE CASCADE,
  case_id                  uuid REFERENCES public.cases(id) ON DELETE CASCADE,
  claim_message_id         uuid REFERENCES public.claim_messages(id) ON DELETE SET NULL,
  provider_message_id      text,
  model_provider           text NOT NULL DEFAULT 'openai',
  model_name               text NOT NULL,
  prompt_version_id        uuid REFERENCES public.prompt_versions(id) ON DELETE SET NULL,
  prompt_version           text NOT NULL DEFAULT 'builtin-v1',
  input_payload            jsonb NOT NULL DEFAULT '{}'::jsonb,
  output_payload           jsonb NOT NULL DEFAULT '{}'::jsonb,
  confidence_payload       jsonb NOT NULL DEFAULT '{}'::jsonb,
  missing_fields           jsonb NOT NULL DEFAULT '[]'::jsonb,
  is_trainable_suggestion  boolean NOT NULL DEFAULT false,
  trainability_score       numeric(4,3) NOT NULL DEFAULT 0,
  trainability_reasons     jsonb NOT NULL DEFAULT '[]'::jsonb,
  blocking_reasons         jsonb NOT NULL DEFAULT '[]'::jsonb,
  created_at               timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX idx_agent_runs_case_created
  ON public.agent_runs(case_id, created_at DESC);

CREATE INDEX idx_agent_runs_tenant_created
  ON public.agent_runs(tenant_id, created_at DESC);

-- =============================================================================
-- training_examples (human-approved few-shot/RAG examples — 0014)
-- =============================================================================
CREATE TABLE public.training_examples (
  id                uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id         uuid NOT NULL REFERENCES public.tenants(id) ON DELETE CASCADE,
  agent_run_id      uuid NOT NULL REFERENCES public.agent_runs(id) ON DELETE CASCADE,
  case_id           uuid REFERENCES public.cases(id) ON DELETE CASCADE,
  claim_message_id  uuid REFERENCES public.claim_messages(id) ON DELETE SET NULL,
  claim_type        text,
  input_payload     jsonb NOT NULL DEFAULT '{}'::jsonb,
  expected_output   jsonb NOT NULL DEFAULT '{}'::jsonb,
  status            text NOT NULL DEFAULT 'approved'
                      CHECK (status IN ('suggested', 'approved', 'rejected',
                                        'exported', 'queued_for_finetune', 'trained')),
  approved_by       uuid REFERENCES public.users(id) ON DELETE SET NULL,
  approved_at       timestamptz,
  created_at        timestamptz NOT NULL DEFAULT now()
);

CREATE UNIQUE INDEX idx_training_examples_agent_run
  ON public.training_examples(tenant_id, agent_run_id);

CREATE UNIQUE INDEX idx_training_examples_message
  ON public.training_examples(tenant_id, claim_message_id)
  WHERE claim_message_id IS NOT NULL;

CREATE INDEX idx_training_examples_tenant_status
  ON public.training_examples(tenant_id, status, created_at DESC);

-- =============================================================================
-- agent_feedback (reviewer corrections on agent output — 0014)
-- =============================================================================
CREATE TABLE public.agent_feedback (
  id                     uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id              uuid NOT NULL REFERENCES public.tenants(id) ON DELETE CASCADE,
  agent_run_id           uuid NOT NULL REFERENCES public.agent_runs(id) ON DELETE CASCADE,
  reviewer_id            uuid REFERENCES public.users(id) ON DELETE SET NULL,
  original_output        jsonb NOT NULL DEFAULT '{}'::jsonb,
  corrected_output       jsonb NOT NULL DEFAULT '{}'::jsonb,
  feedback_type          text NOT NULL DEFAULT 'correction',
  approved_for_training  boolean NOT NULL DEFAULT false,
  created_at             timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX idx_agent_feedback_run
  ON public.agent_feedback(agent_run_id, created_at DESC);

-- =============================================================================
-- agent_prompt_rules (operator-authored prompt rules — 0014)
-- =============================================================================
CREATE TABLE public.agent_prompt_rules (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id   uuid NOT NULL REFERENCES public.tenants(id) ON DELETE CASCADE,
  title       text NOT NULL,
  rule_text   text NOT NULL,
  rule_type   text NOT NULL DEFAULT 'extraction'
                CHECK (rule_type IN ('extraction', 'classification', 'severity',
                                     'missing_fields', 'reply_style', 'core_mapping')),
  active      boolean NOT NULL DEFAULT true,
  created_by  uuid REFERENCES public.users(id) ON DELETE SET NULL,
  created_at  timestamptz NOT NULL DEFAULT now(),
  updated_at  timestamptz
);

CREATE TRIGGER trg_agent_prompt_rules_updated_at
  BEFORE UPDATE ON public.agent_prompt_rules
  FOR EACH ROW EXECUTE FUNCTION public.set_updated_at();

CREATE INDEX idx_agent_prompt_rules_tenant_active
  ON public.agent_prompt_rules(tenant_id, active)
  WHERE active = true;

-- =============================================================================
-- model_training_jobs (batched fine-tuning queue — 0014)
-- =============================================================================
CREATE TABLE public.model_training_jobs (
  id                      uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id               uuid NOT NULL REFERENCES public.tenants(id) ON DELETE CASCADE,
  status                  text NOT NULL DEFAULT 'draft'
                            CHECK (status IN ('draft', 'queued', 'running', 'eval_pending',
                                              'approved', 'rejected', 'deployed', 'failed')),
  provider                text NOT NULL DEFAULT 'openai',
  base_model              text NOT NULL DEFAULT '',
  fine_tuned_model_id     text,
  training_example_count  integer NOT NULL DEFAULT 0,
  eval_result             jsonb,
  created_by              uuid REFERENCES public.users(id) ON DELETE SET NULL,
  created_at              timestamptz NOT NULL DEFAULT now(),
  completed_at            timestamptz
);

CREATE INDEX idx_model_training_jobs_tenant_status
  ON public.model_training_jobs(tenant_id, status, created_at DESC);

-- =============================================================================
-- tenant_ai_settings (per-tenant AI provider setting — 0015)
-- =============================================================================
CREATE TABLE public.tenant_ai_settings (
  tenant_id   uuid PRIMARY KEY REFERENCES public.tenants(id) ON DELETE CASCADE,
  provider    text NOT NULL DEFAULT 'openai'
              CHECK (provider IN ('openai', 'gemini')),
  updated_at  timestamptz NOT NULL DEFAULT now()
);
