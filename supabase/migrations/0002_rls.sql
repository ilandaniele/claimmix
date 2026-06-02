-- =============================================================================
-- Migration 0002: Row Level Security policies for ClaimMix
-- =============================================================================
-- RLS strategy: tenant isolation via current_tenant_id() helper function.
-- All authenticated users can access only rows in their own tenant.
-- Service-role key bypasses RLS entirely (used only server-side in worker).
-- audit_log is append-only: INSERT allowed, no UPDATE/DELETE policies.
-- required_docs_config has no RLS (it is a config seed table, not user data).
-- =============================================================================

-- =============================================================================
-- tenants
-- =============================================================================
ALTER TABLE public.tenants ENABLE ROW LEVEL SECURITY;

-- Analysts can only read their own tenant's row.
CREATE POLICY "tenants_read_own"
  ON public.tenants
  FOR SELECT
  USING (id = public.current_tenant_id());

-- =============================================================================
-- users
-- =============================================================================
ALTER TABLE public.users ENABLE ROW LEVEL SECURITY;

-- Analysts can read other analysts in the same tenant.
CREATE POLICY "users_read_same_tenant"
  ON public.users
  FOR SELECT
  USING (tenant_id = public.current_tenant_id());

-- Analysts can update their own profile only (no tenant hop).
CREATE POLICY "users_update_own"
  ON public.users
  FOR UPDATE
  USING (id = auth.uid())
  WITH CHECK (tenant_id = public.current_tenant_id());

-- =============================================================================
-- cases
-- =============================================================================
ALTER TABLE public.cases ENABLE ROW LEVEL SECURITY;

CREATE POLICY "cases_tenant_all"
  ON public.cases
  FOR ALL
  USING (tenant_id = public.current_tenant_id())
  WITH CHECK (tenant_id = public.current_tenant_id());

-- =============================================================================
-- raw_messages
-- =============================================================================
ALTER TABLE public.raw_messages ENABLE ROW LEVEL SECURITY;

CREATE POLICY "raw_messages_tenant_all"
  ON public.raw_messages
  FOR ALL
  USING (tenant_id = public.current_tenant_id())
  WITH CHECK (tenant_id = public.current_tenant_id());

-- =============================================================================
-- extracted_fields
-- =============================================================================
ALTER TABLE public.extracted_fields ENABLE ROW LEVEL SECURITY;

CREATE POLICY "extracted_fields_tenant_all"
  ON public.extracted_fields
  FOR ALL
  USING (tenant_id = public.current_tenant_id())
  WITH CHECK (tenant_id = public.current_tenant_id());

-- =============================================================================
-- missing_docs
-- =============================================================================
ALTER TABLE public.missing_docs ENABLE ROW LEVEL SECURITY;

CREATE POLICY "missing_docs_tenant_all"
  ON public.missing_docs
  FOR ALL
  USING (tenant_id = public.current_tenant_id())
  WITH CHECK (tenant_id = public.current_tenant_id());

-- =============================================================================
-- outbound_messages
-- =============================================================================
ALTER TABLE public.outbound_messages ENABLE ROW LEVEL SECURITY;

CREATE POLICY "outbound_messages_tenant_all"
  ON public.outbound_messages
  FOR ALL
  USING (tenant_id = public.current_tenant_id())
  WITH CHECK (tenant_id = public.current_tenant_id());

-- =============================================================================
-- audit_log — APPEND ONLY
-- Analysts can read their tenant's audit log.
-- No UPDATE or DELETE policies — audit records are immutable.
-- System (service role) writes to audit_log; RLS is bypassed by service role.
-- =============================================================================
ALTER TABLE public.audit_log ENABLE ROW LEVEL SECURITY;

CREATE POLICY "audit_log_tenant_read"
  ON public.audit_log
  FOR SELECT
  USING (tenant_id = public.current_tenant_id());

-- INSERT only — no UPDATE/DELETE policy means those operations are denied for
-- row-level-security-respecting clients (anon + authenticated).
CREATE POLICY "audit_log_tenant_insert"
  ON public.audit_log
  FOR INSERT
  WITH CHECK (tenant_id = public.current_tenant_id());

-- =============================================================================
-- ai_usage
-- =============================================================================
ALTER TABLE public.ai_usage ENABLE ROW LEVEL SECURITY;

CREATE POLICY "ai_usage_tenant_read"
  ON public.ai_usage
  FOR SELECT
  USING (tenant_id = public.current_tenant_id());

-- INSERT only — usage records are immutable.
CREATE POLICY "ai_usage_tenant_insert"
  ON public.ai_usage
  FOR INSERT
  WITH CHECK (tenant_id = public.current_tenant_id());

-- =============================================================================
-- required_docs_config — no RLS
-- This is a config/seed table; all authenticated users can read it.
-- No user data stored here; no tenant scoping needed.
-- =============================================================================
-- (Intentionally left without RLS — public read for authenticated users)
