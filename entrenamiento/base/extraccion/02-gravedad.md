---
id: extraccion.gravedad
paso: extraccion
modo: prompt
titulo_es: Gravedad del siniestro
titulo_en: Claim severity
---
SEVERITY CLASSIFICATION:
- critical: muerte, fallecido, muerto, fallecimiento, incendio, explosión, robo a mano armada, amenaza con arma
- high: ambulancia, hospitalizado, herido, lesiones, lesionado, policía, policia, urgencia, robo
- medium: choque, colisión, colision, accidente, granizo, inundación
- low: rayones, golpe leve, daño menor, raspón, abolladura leve, daño estético, sin heridos
CONTEXT CUES that escalate to AT LEAST 'medium' (apply when no higher-severity
keyword has matched):
- Multi-vehicle accident (two or more vehicles named with plates)
- Named Argentine insurer present (Zurich, Galeno, Sancor, La Caja, Provincia,
  Federación Patronal, Mercantil Andina, San Cristóbal, Allianz, etc.)
- Explicit siniestro/póliza number present
- Pending inspection, denuncia, or constancia of any kind
- Multiple parties exchanging documentation
Use the HIGHEST of: (keyword severity), (context-cue floor = 'medium').
If no signals found, use "medium" as default for claims.
