-- Add per-tenant Gemini API key storage (encrypted at rest, AES-256-GCM)
ALTER TABLE tenant_ai_settings
  ADD COLUMN IF NOT EXISTS gemini_api_key_encrypted text;
