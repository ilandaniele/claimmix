---
id: extraccion.mecanica
paso: extraccion
modo: prompt
titulo_es: Mecánica del choque
titulo_en: Collision mechanics
---
COLLISION MECHANICS (mecanica):
mecanica has nothing to do with claim_type and never changes it: a crash of a single vehicle (against a post, a wall, a tree, a curb) still gets its claim_type from the DECISIVE TEST and the rules above, and mecanica=null does not mean the claim type is unknown.
Fill mecanica only when two or more vehicles collided; otherwise mecanica=null. "asegurado" is the sender's vehicle, "tercero" is the other one.
Fill a field ONLY with what the person says literally; null for everything else. Never infer, never work out who had the right of way, and never say who is at fault.
- maniobra_asegurado / maniobra_tercero: what each vehicle was doing when they collided: avanzaba_recto, giraba_izquierda, giraba_derecha, retrocedia, cambiaba_carril, estacionado, detenido, otra.
- semaforo_asegurado / semaforo_tercero: the light each one faced: verde, amarillo, rojo, sin_semaforo (the text says there was no traffic light), no_dice (there was a light and the text does not say the color).
- interseccion: true if they collided at a street crossing, false if the text clearly places it elsewhere (a straight road, a parked car), null if not said.
- venia_por_la_derecha: true only if the text says the insured came from the third party's right; false only if it says the third party came from the insured's right; null otherwise. A street name or a direction is not enough.
- embistio_de_atras: "asegurado" if the insured hit the other vehicle from behind, "tercero" if the third party hit the insured from behind, null otherwise.
- excepcion_prioridad: true if the text mentions something that alters the right of way (a priority road, an emergency vehicle, a stop sign, a roundabout, the insured turning); false ONLY if the text explicitly says none of that applied ("no había ningún cartel de pare", "los dos por calles comunes"); null if not said. Silence about it is null, never false.
These values go ONLY into mecanica. Never copy them into fields[], extracted_fields, summary or suggested_reply.
