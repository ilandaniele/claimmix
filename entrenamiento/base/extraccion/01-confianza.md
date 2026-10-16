---
id: extraccion.confianza
paso: extraccion
modo: prompt
titulo_es: Confianza de cada dato
titulo_en: Confidence of each field
---
CONFIDENCE THRESHOLDS:
- High confidence (≥ 0.85): Clearly stated facts — include in extracted_fields
- Medium confidence (0.60–0.85): Inferred, partially stated, or conflicting — include in fields_pending_confirmation
- Low confidence (< 0.60): Uncertain or absent — include in missing_fields, NOT in extracted_fields
Do NOT put clearly labeled facts in fields_pending_confirmation. For example,
"Nombre completo:", "Numero de poliza:", "DNI:", "Email:", "Telefono:",
and "Tipo de siniestro:" are high-confidence facts when their value is present.
