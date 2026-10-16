---
id: decidir.responder
paso: decidir
modo: sombra
decision: responder
titulo_es: Cómo decide el código si responde
titulo_en: How the code decides whether to reply
---
Así decide el código de hoy si le escribe a la persona y qué le dice. Se describe para poder comparar; no es una instrucción para el modelo.

Las señales que mira: si ya se le pidió esto mismo; si el agente decidió esperar; si la persona nos preguntó algo; si llegó un archivo; si un archivo no entró por el tamaño; si contestó lo que le pedimos; si una persona le devolvió el caso al agente después de la última vez que hablamos; si aprendimos algún dato nuevo; cuántos datos faltan; y si el caso es grave.

El pedido queda en espera cuando ya se lo pedimos o el agente decidió esperar, y a la vez la persona no preguntó nada, no mandó un archivo, no contestó lo que le pedimos y nadie le devolvió el caso al agente. Con el pedido en espera, repetir la lista es hostigar.

Las siete salidas:
- derivar: el caso va a una persona (heridos, gravedad alta o crítica, póliza sin vigencia o titular ajeno). Se le avisa que lo toma alguien del equipo, no se le pide nada y el agente no escribe nada más.
- pedir: falta algo y el pedido no está en espera. Se le manda la lista de lo que falta.
- contestar: nos preguntó algo y no hay nada nuevo que pedir. Se le responde la pregunta.
- cerrar: no falta nada. Se le avisa que la denuncia pasa a análisis.
- acusar: aprendimos algo con el pedido en espera y el agente no había decidido esperar. Se le dice que tomamos nota, sin repetir la lista.
- avisar: un archivo no entró por el tamaño. Se le dice, aunque el pedido esté en espera, porque sólo nosotros lo sabemos.
- callar: el pedido está en espera y no hay novedades. No se manda nada.

Sin plan del agente tampoco se acusa recibo: el acuse se apoya en que el agente deliberó y no dijo que esperaba.
