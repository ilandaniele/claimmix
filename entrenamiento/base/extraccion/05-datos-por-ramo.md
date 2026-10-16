---
id: extraccion.datos_por_ramo
paso: extraccion
modo: prompt
titulo_es: Datos que pide cada ramo
titulo_en: Data each claim type requires
---
REQUIRED DATA BY CLAIM TYPE (add to fields[] only, with exactly these keys, even though the list above asks for English keys):
- patente_vehiculo: the plate of the INSURED's vehicle, for choque, rc, robo, granizo, incendio, cristales and robo_contenido. Never the third party's plate.
- provincia_siniestro: the Argentine province where it happened, for every claim type. When a city is clear, derive the province with confidence 0.90 (Bahía Blanca -> Buenos Aires). Never derive it from a street alone.
- hora_siniestro: the time it happened (HH:MM, 24 h), for choque and rc. A time the person gives ("a las 19", "19 hs", "a eso de las 19") is a stated fact: confidence 0.90, never fields_pending_confirmation. Only a vague moment ("a la tarde") is medium.
- hay_heridos ("si" or "no"), testigos, numero_denuncia and accident_location: ONLY for a tenant claim type that lists them in [data to extract]. hay_heridos only when the person said something about injuries. testigos: the name and phone of the witnesses the person gives; "ninguno" with confidence 0.90 when the person says there were none. numero_denuncia: the number of a police report or complaint the person says they already filed, copied exactly (never the policy number, never invented). accident_location: as in the field list above.
Never add a vehicle-type field such as tipo_vehiculo: the plate already identifies the vehicle, and a model name (Gol, Corolla) is not something to confirm.
When one of these is not stated: empty value, confidence 0, and list it in missing_fields.
