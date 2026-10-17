---
id: extraccion.gravedad_del_codigo
paso: extraccion
modo: sombra
decision: gravedad
titulo_es: Cómo fija la gravedad el código
titulo_en: How the code sets severity
---
Así fija la gravedad el código de hoy. Se describe para poder comparar; no es una instrucción para el modelo.

La gravedad del caso es la más alta de dos lecturas: la de un léxico de palabras sobre el asunto y el cuerpo del mensaje, y la que dio el modelo. El léxico puede subirla, nunca bajarla. Si ninguna de las dos dice nada, el caso queda en media.

El léxico, de mayor a menor:
- critical: muerte, fallecido o fallecida, fallecimiento, muerto o muerta, incendio, explosión, robo a mano armada, amenaza con arma, amenaza.
- high: ambulancia, hospitalizado o hospitalizada, herido o herida, lesiones, lesionado o lesionada, policía, urgencia, robo, hurto.
- medium: choque, colisión, accidente, granizo, inundación, chocaron.
- low: rayones, golpe leve, daño menor, raspón, abolladura leve, daño estético, sin heridos.

Cada palabra cuenta en singular y en plural («heridos» cuenta como «herido»), pero no cuando una negación la anula: «sin heridos», «no hubo heridos» o «ningún herido» no suben la gravedad.

Con la gravedad en alta o crítica el caso requiere a una persona.

Si lo último que llegó es una nota de voz que no se pudo transcribir, no hay hechos nuevos: la gravedad que da el modelo no pasa de la que el caso ya tenía.
