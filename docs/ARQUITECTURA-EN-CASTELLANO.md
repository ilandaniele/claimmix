# La oficina — la arquitectura sin jerga

> Si el sistema fuera una oficina de siniestros con empleados, cada módulo sería
> uno de ellos. Esto es quién es quién, para leer antes que
> [ARQUITECTURA.md](./ARQUITECTURA.md) (el diagnóstico) y
> [ARQUITECTURA-EJEMPLOS.md](./ARQUITECTURA-EJEMPLOS.md) (el código).

---

## El plano

```
        📧 correo · 💬 WhatsApp                    ✉️ respuesta al asegurado
                  │                                          ▲
                  ▼                                          │
   ┌──────────────────────────────────────────────────────────────────────┐
   │                                                                      │
   │   ┌───────────┐    ┌───────────┐    ┌───────────┐    ┌───────────┐   │
   │   │    📥     │ →  │    🔤     │ →  │    ⚖️     │ →  │    📤     │   │
   │   │ RECEPCIÓN │    │ TRADUCTOR │    │ EL QUE    │    │ EL CADETE │   │
   │   │           │    │           │    │  DECIDE   │    │           │   │
   │   │abre puerta│    │arma ficha │    │qué falta  │    │lleva la   │   │
   │   │           │    │           │    │y si urge  │    │respuesta  │   │
   │   └───────────┘    └───────────┘    └───────────┘    └───────────┘   │
   │     adapters      adapters+core         core           adapters      │
   │                                                                      │
   │   🗒️ EL CAPATAZ — lleva la lista de pasos y sabe dónde quedó         │
   │                    si algo se corta                       workflows  │
   └──────────────────────────────────────────────────────────────────────┘
                        ┊                    ┊
   ┌──────────────────────────────────────────────────────────────────────┐
   │  🗄️ EL ARCHIVO                                                data   │
   │  El único con la llave. Sólo entrega las carpetas de la aseguradora  │
   │  que pregunta — ni siquiera puede sacar las de otra.                 │
   └──────────────────────────────────────────────────────────────────────┘
                                    ┊
                  ┌─────────────────────────────────────┐
                  │ 🧑‍💼 EL MOSTRADOR         features   │
                  │ el analista mira y confirma         │
                  └─────────────────────────────────────┘
```

Las flechas llenas (`→`) son el camino del siniestro. **El capataz no es un
paso: es el marco que rodea a los cuatro**, porque su trabajo es saber en cuál
va cada expediente. Las líneas punteadas (`┊`) son «este le pide papeles a
aquel».

---

## Quién es quién

### 📥 Recepción · `adapters`
Atiende la puerta. Sabe abrir el correo, recibir un WhatsApp, reconocer si el
mensaje es auténtico. Nada más.
**No hace:** no entiende de siniestros. Le da igual si el mensaje habla de un
choque o de una receta de flan.

### 🔤 El traductor · `adapters + core`
Lee el mensaje escrito por una persona —desordenado, con faltas, con fotos— y
lo pasa a una ficha ordenada: patente, fecha, lugar, qué pasó. Es la parte que
usa inteligencia artificial.
**No hace:** no decide nada. Sólo pasa en limpio lo que la persona dijo.

### ⚖️ El que decide · `core`
**Es el corazón del producto.** Mira la ficha y dice: le falta la patente; esto
parece grave y hay que avisarle a un perito; esto ya está completo y se puede
cerrar; a esta persona ya le preguntamos ayer y no hace falta molestarla otra
vez.
**No hace:** no manda mensajes, no toca el archivo, no sabe que existe internet.
Le entregan una ficha y devuelve una decisión — como un tasador que trabaja en
un cuarto sin ventanas.

### 📤 El cadete · `adapters`
Lleva la respuesta al asegurado por donde haya escrito: si mandó un mail,
contesta por mail; si escribió por WhatsApp, contesta por ahí.
**No hace:** no elige qué decir. Le dan el sobre cerrado y lo entrega.

### 🗄️ El archivo · `data`
Guarda todo y es **el único que tiene la llave**. Cuando alguien le pide una
carpeta, primero mira de qué aseguradora es quien pregunta, y sólo le da las
suyas.
**Lo importante:** hoy cada empleado entra al archivo por su cuenta y se acuerda
de mirar de quién es cada carpeta — 198 veces. Alcanza con que uno se distraiga.
Con el archivero, distraerse no alcanza: **aunque se equivoque, el archivo no le
entrega lo que no le corresponde.**

### 🗒️ El capataz · `workflows`
Tiene la lista de pasos de cada siniestro y va tachando: traducido ✓, analizado
✓, preguntado ✓, esperando respuesta… Si se corta la luz en el paso tres, cuando
vuelve **retoma en el paso tres**, no desde el principio.
**Lo importante:** hoy no hay capataz. Cada empleado trabaja mientras le alcanza
el turno, y si no termina se llama a sí mismo por teléfono para seguir; después
de seis llamadas, se rinde. Hay un empleado nocturno que pasa a juntar
expedientes tirados — **y hoy no encuentra ninguno**, porque el sistema de
turnos anda. Lo que cuesta no son expedientes perdidos: es que nadie sabe en
qué paso va cada uno, no se puede esperar una semana por una respuesta, y si
algo se corta hay que empezar de nuevo.

### 🧑‍💼 El mostrador · `features`
Las pantallas: la bandeja, el caso abierto, las métricas. Donde una persona de
verdad mira lo que la oficina hizo, corrige lo que esté mal y confirma.
**No hace:** no entra al archivo por su cuenta ni decide por sí mismo. Le
pregunta al archivero y al que decide.

---

## Cómo viaja un siniestro

1. Alguien manda un WhatsApp: *«choqué en Bahía Blanca, mandá la grúa»*.
2. **Recepción** lo recibe y comprueba que sea auténtico.
3. **El capataz** abre una lista de pasos para ese siniestro.
4. **El traductor** lee el mensaje y arma la ficha con lo que se entiende.
5. **El archivo** guarda la ficha, bajo el nombre de esa aseguradora y de
   ninguna otra.
6. **El que decide** mira la ficha: falta la patente y falta la foto del carnet.
7. **El cadete** contesta por WhatsApp pidiendo esas dos cosas.
8. El capataz tacha «preguntado» y **deja el expediente esperando** — puede
   esperar una semana sin que nadie lo empuje.
9. La persona responde con la foto. Vuelve a empezar en el paso 2, y el capataz
   retoma donde había quedado.
10. Cuando no falta nada, el caso aparece en **el mostrador** para que un
    analista confirme y cierre.

---

## Las dos reglas que hacen que esto funcione

**El que decide trabaja sin ventanas.** No tiene teléfono, ni llave del archivo,
ni acceso a internet. Le entregan una ficha y devuelve una decisión. Por eso se
lo puede poner a prueba con una ficha de mentira y ver si contesta bien — en un
segundo, sin encender el resto de la oficina.

**El archivo es el único con llave.** Nadie más entra, y el archivero mira
siempre de quién es quien pregunta antes de entregar. Es la diferencia entre
confiar en que nadie se distraiga y que distraerse no alcance.

---

## Qué es distinto de hoy

| | Hoy | Después |
|---|---|---|
| **El archivo** | Cada empleado entra por su cuenta y se acuerda de mirar de quién es cada carpeta. 198 veces. | Hay un archivero. Nadie más tiene llave, y él mira siempre. |
| **Las decisiones** | El que decide y el que atiende el teléfono son la misma persona, en un escritorio de 1.424 papeles. Para probar si decide bien hay que montar la oficina entera. | Están separados. Al que decide se lo prueba solo, con una ficha de mentira, en un segundo. |
| **Los expedientes** | No hay capataz: hay un sistema de turnos hecho a mano que funciona —hoy no se pierde ninguno— pero que hay que mantener, y con el que nadie sabe en qué paso va cada uno. | Hay capataz y lista de pasos: se ve dónde está cada expediente, se puede esperar una semana por una respuesta, y si algo se corta retoma donde quedó. |


> **Corrección (2026-08-25).** Este documento afirmaba que la cañería pierde
> casos y que la existencia del cron `reap-stuck` lo probaba. **Lo verifiqué
> contra producción y no es cierto hoy:** de 464 casos, cero quedaron atascados
> en `procesando`. La pérdida silenciosa era el comportamiento *anterior* a
> `batch-budget.ts`, que la corrigió; el barrendero quedó como red de seguridad
> y no está atrapando nada. El argumento por la ejecución durable sigue en pie,
> pero por otros motivos —las cuatro piezas caseras, las esperas largas, la
> imposibilidad de reanudar y la falta de visibilidad—, no por pérdida de datos.
