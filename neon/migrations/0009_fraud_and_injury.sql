-- Migration 0009: fraud risk assessment + granular injury severity on cases
-- Adds three columns to the cases table:
--   fraud_risk_level  — AI-assessed overall fraud risk: none/low/medium/high
--   fraud_indicators  — JSON array of specific red flags found by the extractor
--   injury_severity   — Granular injury level: none/minor/severe/fatal

ALTER TABLE cases
  ADD COLUMN IF NOT EXISTS fraud_risk_level  text    DEFAULT 'none',
  ADD COLUMN IF NOT EXISTS fraud_indicators  jsonb   DEFAULT '[]'::jsonb,
  ADD COLUMN IF NOT EXISTS injury_severity   text;
