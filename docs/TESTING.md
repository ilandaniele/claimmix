# Cómo probar que todo anda

Hasta agosto de 2026, probar ClaimMix era una persona escribiéndole al bot por
WhatsApp y por Gmail toda una tarde. Encontró errores reales — la foto que
nadie anotaba, la pregunta repetida tres veces — y tiene tres problemas: lleva
una tarde por ronda, cubre solamente el camino que a esa persona se le ocurrió
ese día, y cada mensaje sale por una cuenta de WhatsApp Business que se puede
bloquear por escribirle a números inventados.

Ahora es un comando.

```bash
pnpm check
```

**No le manda un mensaje a nadie.** Ni un WhatsApp, ni un mail.

---

## Las tres capas

Corren en ese orden — de la más barata a la más cara — y se detiene en la
primera que falla, porque las siguientes cuestan plata y con un test unitario
en rojo su resultado no dice nada.

### 1. `pnpm verify` — segundos, gratis

Tipos, lint y ~1950 tests unitarios y de integración. Atrapa todo lo que está
mal por sí solo: una función que devuelve lo que no debe, una guarda que dejó
de guardar, un tipo que no cierra.

Lo que **no** puede ver: cómo se comporta el agente cuando extracción, análisis
de huecos, orquestador y redactor corren juntos. Ahí vivió cada error de la
última semana.

### 2. `pnpm rehearse` — minutos, gasta tokens

Once denuncias enteras, de punta a punta, contra el mismo código, la misma base
y el mismo modelo que producción. Por los canales simulados: en WhatsApp el
mensajero redacta la respuesta exactamente como lo haría y la guarda en vez de
enviarla; en mail el despachador hace lo mismo con cualquier dirección
`@example.com`.

Los dos canales importan y son código distinto. El mail hila por asunto y por
cabecera, corre un filtro que decide que un mensaje es un newsletter antes de
que nadie lo lea, saca la copia citada de nuestro propio mail de la respuesta,
y arma HTML en vez de usar el redactor. Nada de eso existe en WhatsApp, y todo
eso se rompió alguna vez.

Escenarios: la denuncia completa hasta quedar lista, el incendio con heridos que
se deriva, la cotización que no es un reclamo, los datos que llegan de a uno, el
mensaje que no aporta nada y no merece respuesta, la pregunta que hay que
contestar, la póliza que hay que buscar por DNI, la póliza vencida, y los tres
equivalentes por mail.

Imprime la conversación completa. **Leela.** La mitad del valor está en que una
persona note una respuesta que pasa todas las verificaciones y suena mal.

```bash
pnpm rehearse                  # todos
pnpm rehearse poliza-vencida   # uno solo, por nombre
pnpm rehearse --keep           # deja los casos en la base para inspeccionarlos
```

Los casos de ensayo se borran al terminar. Si sembró una póliza de prueba,
también se borra.

**Lo que no puede ensayar:** el reconocimiento de documentos. Decidir que una
foto muestra un baúl destrozado requiere una foto de un baúl destrozado, y el
archivo de prueba es un píxel gris. Poné imágenes reales en
`tests/fixtures/danos.jpg` y `tests/fixtures/licencia.jpg` y esa parte también
corre.

### 3. `pnpm smoke` — segundos, gratis

Le pregunta **al deploy que está corriendo** qué alcanza a ver, por red, igual
que el webhook de un asegurado.

Esta capa existe por una clase de falla que las otras dos no pueden ver por
construcción: código correcto, entorno incompleto. R2 funcionó en cada corrida
local durante horas mientras producción descartaba silenciosamente todos los
adjuntos, porque las credenciales nunca se habían cargado en Vercel. Nada falló
en voz alta.

Verifica: base de datos, migraciones aplicadas, almacenamiento, modelo, token de
WhatsApp, casilla conectada, y qué comportamientos del agente están prendidos.
También comprueba, en cada corrida, que `/api/health` siga rechazando a quien no
tiene la llave.

```bash
pnpm smoke                      # configuración y conectividad
pnpm smoke --deep               # además sube un archivo real y llama al modelo
pnpm smoke --url https://…      # un preview en vez de producción
```

---

## Cuándo correr qué

| Situación | Comando |
|---|---|
| Mientras programás | `pnpm verify` |
| Antes de commitear algo que toca el agente | `pnpm check --local` |
| **Después de cada deploy** | `pnpm check` |
| Antes de mostrárselo a un cliente | `pnpm check --deep` |
| "Algo raro está pasando en producción" | `pnpm smoke --deep` |

`--fast` saltea el ensayo (gratis, sin tokens). `--local` saltea el chequeo de
producción.

---

## `/api/health`

Detrás de `pnpm smoke` hay un endpoint que corre **dentro** del deploy y reporta
lo que puede alcanzar. Sirve solo, sin el script:

```bash
curl -H "Authorization: Bearer $CRON_SECRET" https://claimmix.vercel.app/api/health
```

Responde 200 si no hay nada roto y 503 si hay algo caído, así cualquier cosa que
mire una URL se entera sin parsear el cuerpo.

Pide autenticación porque enumera las dependencias y cómo están cableadas: no
son secretos uno por uno, juntos son un mapa. `?deep=1` gasta plata: sube un
archivo de verdad y llama al modelo de verdad.

---

## Lo que sigue sin estar cubierto

Dicho de frente, para que nadie lea "todo verde" como "todo probado":

- **El reconocimiento de documentos**, por lo de arriba.
- **El envío real.** El ensayo prueba que el agente decide bien y redacta bien;
  que Meta entregue el mensaje y que Gmail lo mande son las dos cosas que
  siguen necesitando una prueba manual, y `pnpm smoke` sólo verifica que las
  credenciales sirvan.
- **La interfaz.** No hay tests de navegador. Las pantallas se prueban mirándolas.
- **La sincronización con el core del asegurador**, que nunca se ejercitó contra
  un sistema real.
