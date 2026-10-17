---
id: extraccion.derivar
paso: extraccion
modo: sombra
decision: derivar
titulo_es: Cuándo el código deriva a una persona
titulo_en: When the code hands a case to a person
---
Así deriva el código de hoy un caso a una persona. Se describe para poder comparar; no es una instrucción para el modelo.

Un caso pasa a una persona, sin esperar a que el agente delibere, cuando se da cualquiera de estas:
- La gravedad es alta o crítica (ver cómo la fija el código). Con muerte o incendio es crítica; con ambulancia, internación o lesiones, alta.
- Hay heridos: la persona dijo que alguien se lastimó, o el grado de la lesión es leve, grave o fatal. Que nadie hable de personas no es «nadie salió herido»: ese negativo supuesto se borra y no cuenta. Con heridos o muerte de una persona se deriva siempre; es un piso del código y nunca pasa al entrenamiento.
- La póliza que dio la persona está en el padrón con ese mismo número, pero vencida o inactiva, y no hay ninguna vigente.
- Quien escribe no es el titular: el número de póliza coincide con el del padrón, pero ni el nombre ni el DNI son los del titular.

La póliza vencida o inexistente y el titular ajeno se describen acá pero hoy no se miden: el modelo no ve el padrón.

Fuera de eso, el agente puede derivar cuando el caso excede un trámite: la persona está muy angustiada, menciona abogados o juicio, o se contradice de forma seria. No deriva porque falte un papel (el parte amistoso, la denuncia policial) ni porque una consulta no haya encontrado datos.
