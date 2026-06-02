-- =============================================================================
-- Migration 0004: Create default tenant and link admin user
-- =============================================================================
-- Run once after creating the first auth user in Supabase dashboard.
-- Safe to re-run (ON CONFLICT DO NOTHING / DO UPDATE).
-- =============================================================================

-- 1. Create the default tenant
INSERT INTO public.tenants (id, name, created_at)
VALUES (
  '10000000-0000-0000-0000-000000000001',
  'Mi Aseguradora',
  now()
)
ON CONFLICT (id) DO NOTHING;

-- 2. Link the admin user (finds by email, sets role = admin)
INSERT INTO public.users (id, tenant_id, full_name, role, created_at)
SELECT
  au.id,
  '10000000-0000-0000-0000-000000000001',
  COALESCE(au.raw_user_meta_data->>'full_name', split_part(au.email, '@', 1)),
  'admin',
  now()
FROM auth.users au
WHERE au.email = 'ilan.daniele@gmail.com'
ON CONFLICT (id) DO UPDATE
  SET role = 'admin',
      tenant_id = EXCLUDED.tenant_id;
