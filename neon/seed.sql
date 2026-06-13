-- =============================================================================
-- ClaimMix — Neon optional demo seed
-- =============================================================================
-- OPTIONAL. Run only on dev/demo databases, never in production:
--   psql "$DATABASE_URL" -f neon/seed.sql
--
-- The Supabase seed (supabase/seed.sql) also created auth users, demo cases,
-- raw messages, extracted fields, missing docs and audit-log rows. Those are
-- NOT ported here: users are now created through Better Auth signup, and the
-- demo cases referenced those auth users. Only the demo tenant row is kept.
-- Reference config (required_docs_config, global known_claim_patterns) is
-- seeded by neon/migrations/0001_init.sql itself.
-- =============================================================================

INSERT INTO public.tenants (id, name, created_at)
VALUES (
  '10000000-0000-0000-0000-000000000001',
  'Seguros del Sur S.A.',
  now() - INTERVAL '30 days'
)
ON CONFLICT (id) DO NOTHING;
