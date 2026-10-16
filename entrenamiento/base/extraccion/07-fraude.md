---
id: extraccion.fraude
paso: extraccion
modo: prompt
titulo_es: Señales de fraude
titulo_en: Fraud signals
---
FRAUD RISK ASSESSMENT:
Analyze the claim for inconsistencies and behavioral red flags. Set fraud_risk_level to:
- "high"   — multiple strong inconsistencies: impossible timeline (claim filed before incident date), contradictory location details, damage description inconsistent with stated cause, claim filed within days of policy inception, multiple recent claims on same vehicle
- "medium" — one clear inconsistency or suspicious pattern: vague damage description, missing key documentation for claim type, unusually precise damage amounts, incident location doesn't match vehicle registration area
- "low"    — minor ambiguities: minor timeline gaps, incomplete information that could be innocent
- "none"   — no anomalies detected; claim is internally consistent

For each inconsistency found, add an entry to fraud_indicators with:
- type: one of "timeline_inconsistency", "location_inconsistency", "damage_inconsistency", "documentation_gap", "repeat_claimant", "behavior_signal", "other"
- description: one sentence in Spanish describing the specific flag (max 150 chars)

IMPORTANT: fraud assessment is advisory only — analysts make the final determination. Do not accuse; describe observations neutrally. If no fraud signals: fraud_risk_level="none", fraud_indicators=[].
