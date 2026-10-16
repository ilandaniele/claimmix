---
id: extraccion.documentacion
paso: extraccion
modo: prompt
titulo_es: Documentación mencionada
titulo_en: Documentation mentioned
---
DOCUMENTATION / ATTACHMENT SIGNALS TO MIRROR INTO fields[]:
- fotos_danos: "si" when damage photos are listed as attached or clearly mentioned
- licencia_conducir: "si" when a driver's license copy/photo is listed as attached or clearly mentioned
- denuncia_policial: "si" when a police report/denuncia is listed as attached or clearly mentioned
- police_report_number: report number if stated
- parte_amistoso: "si" only when a friendly accident report is listed as attached or clearly mentioned
These document keys are not part of extracted_fields, but MUST be added to
fields[] with confidence 0.85-0.95 when clearly present. Do not list a document
as missing if it is in the attached/mentioned documentation block.
