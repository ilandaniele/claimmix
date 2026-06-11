-- =============================================================================
-- 0015 — Per-tenant AI provider setting
--
-- Lets each tenant choose which LLM provider runs claim extraction:
--   'openai' (GPT via OPENAI_API_KEY) or 'gemini' (Google Gemini free tier via
--   GEMINI_API_KEY). Selected from Configuración → "Modelo de IA".
--
-- Falls back at runtime to the AI_PROVIDER env var (default 'openai') when no
-- row exists, and to whichever provider has an API key configured.
-- Tenant-scoped with RLS (current_tenant_id()), same pattern as 0014.
-- =============================================================================

CREATE TABLE IF NOT EXISTS public.tenant_ai_settings (
  tenant_id   uuid PRIMARY KEY REFERENCES public.tenants(id) ON DELETE CASCADE,
  provider    text NOT NULL DEFAULT 'openai'
              CHECK (provider IN ('openai', 'gemini')),
  updated_at  timestamptz NOT NULL DEFAULT now()
);

ALTER TABLE public.tenant_ai_settings ENABLE ROW LEVEL SECURITY;

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_policies
    WHERE schemaname = 'public'
      AND tablename = 'tenant_ai_settings'
      AND policyname = 'tenant_ai_settings_tenant_all'
  ) THEN
    CREATE POLICY tenant_ai_settings_tenant_all ON public.tenant_ai_settings
      FOR ALL
      USING (tenant_id = public.current_tenant_id())
      WITH CHECK (tenant_id = public.current_tenant_id());
  END IF;
END $$;
