-- Make Gemini the default AI provider.
-- Rows that only reflect the old OpenAI defaults are moved to Gemini. Tenants
-- with an activated OpenAI fine-tuned model keep that active model.

ALTER TABLE public.tenant_ai_settings
  ALTER COLUMN provider SET DEFAULT 'gemini';

ALTER TABLE public.tenant_ai_settings
  ALTER COLUMN active_model_provider SET DEFAULT 'gemini';

ALTER TABLE public.agent_runs
  ALTER COLUMN model_provider SET DEFAULT 'gemini';

UPDATE public.tenant_ai_settings
SET
  provider = 'gemini',
  active_model_provider = 'gemini',
  active_model = NULL,
  updated_at = now()
WHERE provider = 'openai'
  AND active_model_provider = 'openai'
  AND active_model IS NULL
  AND model_activated_at IS NULL;
