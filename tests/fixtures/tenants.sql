-- =============================================================================
-- Two-tenant isolation fixture for RLS integration tests
-- =============================================================================
-- Used by tests/integration/rls.test.ts to verify cross-tenant isolation.
-- Run against a local Neon instance (Neon start).
--
-- Creates:
--   - Tenant T1 with analyst user U1 and 2 cases
--   - Tenant T2 with analyst user U2 and 2 cases
--
-- U1 should be able to see only T1 cases; U2 only T2 cases.
-- =============================================================================

-- Tenants
INSERT INTO public.tenants (id, name) VALUES
  ('aaaaaaaa-0000-0000-0000-000000000001', 'Aseguradora Alfa'),
  ('aaaaaaaa-0000-0000-0000-000000000002', 'Aseguradora Beta')
ON CONFLICT (id) DO NOTHING;

-- Auth users (local Neon only)
INSERT INTO auth.users (
  id, email, encrypted_password, email_confirmed_at,
  created_at, updated_at, raw_app_meta_data, raw_user_meta_data
) VALUES
  (
    'bbbbbbbb-0000-0000-0000-000000000001',
    'u1@alfa.com',
    crypt('Test1234!', gen_salt('bf', 10)),
    now(), now(), now(),
    '{"provider":"email","providers":["email"]}', '{}'
  ),
  (
    'bbbbbbbb-0000-0000-0000-000000000002',
    'u2@beta.com',
    crypt('Test1234!', gen_salt('bf', 10)),
    now(), now(), now(),
    '{"provider":"email","providers":["email"]}', '{}'
  )
ON CONFLICT (id) DO NOTHING;

-- Public users
INSERT INTO public.users (id, tenant_id, full_name, role) VALUES
  ('bbbbbbbb-0000-0000-0000-000000000001', 'aaaaaaaa-0000-0000-0000-000000000001', 'Usuario Uno', 'analyst'),
  ('bbbbbbbb-0000-0000-0000-000000000002', 'aaaaaaaa-0000-0000-0000-000000000002', 'Usuario Dos', 'analyst')
ON CONFLICT (id) DO NOTHING;

-- Cases for Tenant T1 (2 cases)
INSERT INTO public.cases (id, tenant_id, policy_number, policyholder_name, claim_type, status, channel) VALUES
  ('cccccccc-0000-0000-0000-000000000001', 'aaaaaaaa-0000-0000-0000-000000000001', 'ALFA-001', 'Asegurado Alfa 1', 'choque', 'listo', 'email_sim'),
  ('cccccccc-0000-0000-0000-000000000002', 'aaaaaaaa-0000-0000-0000-000000000001', 'ALFA-002', 'Asegurado Alfa 2', 'robo', 'procesando', 'email_sim')
ON CONFLICT (id) DO NOTHING;

-- Cases for Tenant T2 (2 cases)
INSERT INTO public.cases (id, tenant_id, policy_number, policyholder_name, claim_type, status, channel) VALUES
  ('dddddddd-0000-0000-0000-000000000001', 'aaaaaaaa-0000-0000-0000-000000000002', 'BETA-001', 'Asegurado Beta 1', 'granizo', 'esperando', 'email_sim'),
  ('dddddddd-0000-0000-0000-000000000002', 'aaaaaaaa-0000-0000-0000-000000000002', 'BETA-002', 'Asegurado Beta 2', 'incendio', 'escalado', 'email_sim')
ON CONFLICT (id) DO NOTHING;
