---
id: extraccion.ramo
paso: extraccion
modo: prompt
titulo_es: Ramo del siniestro
titulo_en: Claim type
---
  ⚠️ DECISIVE TEST FOR COLLISIONS (apply this BEFORE anything else when there is a crash/golpe/impacto):
  Ask "¿quién sufrió el daño que se está reclamando?"
    • "Yo choqué y se dañó MI auto" (the insured claims for their OWN vehicle/property) → choque
    • "Yo choqué y le dañé a UN TERCERO" (the insured CAUSED damage to someone else — another
      vehicle, a pedestrian/ciclista, a parked car, a wall/propiedad ajena — and that third party
      is the damnificado who reclaims) → **rc** (responsabilidad civil), NOT choque.
  Do not default collisions to choque. If a tercero damnificado is present and their loss is the
  subject of the claim, it is rc even though a collision occurred. Examples that are rc, not choque:
  golpe de puerta a un ciclista; chocar y abollar un auto estacionado; embestir un poste/pared
  ajena; atropellar a un peatón causándole daños.

  Then classify using these rules (evaluate in order; pick the FIRST that matches):
  • art — a WORK accident or occupational illness of a WORKER reported as a workers' compensation claim
    (ART, accidente laboral, enfermedad profesional, in itinere, empleador, lesión de un empleado), even
    though it is also a bodily injury. NOT art, whatever the place or the hour: (1) damage to or theft of
    the insured's own VEHICLE that merely happened at work or on the way to or from it ("iba hacia el
    trabajo", "en horario laboral") — that is choque, robo, etc.; (2) a person who says there is no ART,
    who works alone or is self-employed, or who is claiming under a personal accident policy — that is
    accidente_personal.
  • vida — a beneficiary or relative reports the DEATH or permanent disability of the insured PERSON
    under a life policy (seguro de vida, beneficiario, fallecimiento del asegurado). A death in a vehicle
    crash claimed on a vehicle policy is NOT vida.
  • integral_comercio — damage or theft at a shop, business or office premises (local, comercio,
    mercadería, vidriera), not a vehicle.
  • consorcio — damage to the COMMON areas of a building (consorcio, administración, expensas, ascensor,
    filtración en el edificio), not a private unit or a vehicle.
  • accidente_personal — the claim is primarily about a PERSON's bodily injury
    (lesiones, fractura, herido, internación, certificado médico), regardless of how it happened.
  • rc (responsabilidad civil) — see the DECISIVE TEST above: damage the insured CAUSED TO A THIRD
    PARTY, where covering that third party's loss / the insured's liability is the purpose. Signals:
    a named damnificado (tercero), "le ocasioné/causé daños a", "responsabilidad civil", "daños a
    terceros", door-ding to a parked car, hitting a pedestrian/cyclist or another vehicle where THE
    OTHER PARTY's damage is the subject.
  • cristales — damage limited to glass/cristales (parabrisas, luneta, ventanilla), no collision.
  • robo_contenido — theft of belongings/contents FROM a vehicle (objetos, herramientas,
    pertenencias), where the vehicle itself was NOT stolen. (robo = the whole vehicle was stolen.)
  • granizo — hail damage. incendio — fire.
  • choque — collision damaging the INSURED's OWN vehicle (no third-party claim — see DECISIVE TEST).
  • robo — theft of the entire vehicle. other — anything that fits none of the above.
