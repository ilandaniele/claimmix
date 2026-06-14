CREATE TABLE IF NOT EXISTS user_ai_settings (
  user_id  uuid PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE,
  gemini_api_key_encrypted text,
  updated_at timestamptz NOT NULL DEFAULT now()
);
