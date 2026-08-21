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

## Las capas

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

Doce denuncias enteras, de punta a punta, contra el mismo código, la misma base
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
contestar, la póliza que hay que buscar por DNI, la póliza vencida, la foto que
no es ningún documento, y los tres equivalentes por mail.

Imprime la conversación completa. **Leela.** La mitad del valor está en que una
persona note una respuesta que pasa todas las verificaciones y suena mal.

```bash
pnpm rehearse                  # todos
pnpm rehearse poliza-vencida   # uno solo, por nombre
pnpm rehearse --keep           # deja los casos en la base para inspeccionarlos
```

Los casos de ensayo se borran al terminar. Si sembró una póliza de prueba,
también se borra.

### Las fotos

El reconocimiento de documentos sólo se puede ensayar con documentos de verdad.
Las fotos **no están en el repositorio y no van a estar**: la licencia que
usamos tiene nombre, domicilio, fecha de nacimiento y firma del titular, y eso
no entra a un historial de git, donde queda para siempre y viaja con cada clon.

Viven en la máquina de quien corre el ensayo, en `tests/fixtures/`:

| Archivo | Qué es | Para qué |
|---|---|---|
| `danos.jpg` | Un auto chocado | Que lo reconozca como las fotos de los daños |
| `licencia.jpg` | Una licencia de conducir | El caso difícil: dos documentos de papel pendientes, tiene que elegir el correcto |
| `irrelevante.jpg` | Cualquier foto que no sea un documento | El caso negativo: no tiene que cerrar ningún pedido |

Sin ellas la suite corre igual, avisa cuáles faltan, y no da por probado lo que
no probó. El caso negativo sí se verifica siempre: una imagen que no
reconocemos no puede cerrar nada, y esa es la dirección de la cautela que
importa — un documento marcado como recibido por error desaparece de la lista
del analista y nadie se entera hasta que el reclamo se traba.

### 3. `pnpm prove` — segundos, **manda mensajes de verdad**

Lo único que las otras capas no pueden probar: que un mensaje salga del
edificio. Un token de WhatsApp que caducó, una cuenta que Meta restringió, un
refresh token de Gmail revocado al cambiar la contraseña — todas fallan en
silencio desde nuestro lado. El webhook sigue aceptando mensajes, el agente
sigue decidiendo qué decir, y no llega nada.

```bash
pnpm prove --whatsapp +5492916426930
pnpm prove --email vos@gmail.com
```

Sin destino no hace nada. Es el único comando de la suite que manda algo, así
que no corre por accidente y no entra en `pnpm check`.

**El envío lo hace el deploy, no tu máquina.** No es comodidad: la clave que
descifra el token de la casilla (`GMAIL_TOKEN_ENCRYPTION_KEY`) está marcada
*Sensitive* en Vercel, o sea **de sólo escritura** — nadie la puede leer de
vuelta, ni quien la cargó. Es la configuración correcta para una clave que
abre credenciales de correo, así que la prueba va a donde las credenciales ya
están. Y de paso prueba lo que importa: que tu laptop pueda mandar no dice
nada sobre producción.

Detrás hay un `POST /api/health/delivery` con la misma llave que el resto. El
cuerpo del mensaje lo fija el servidor —quien llama elige a quién, nunca qué—
y no acepta más de un envío por minuto.

WhatsApp sólo acepta texto libre hacia un número que le escribió al negocio en
las últimas 24 horas; fuera de esa ventana Meta lo rechaza, y el script
distingue "ventana cerrada" de "token roto", porque piden respuestas opuestas.

### 4. `pnpm smoke` — segundos, gratis

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
| Después de un deploy | *nada — corre solo, ver abajo* |
| Antes de commitear algo que toca el agente | `pnpm check --local` |
| **Después de cada deploy** | `pnpm check` |
| Antes de mostrárselo a un cliente | `pnpm check --deep` |
| "Algo raro está pasando en producción" | `pnpm smoke --deep` |
| Dudás de si el bot puede mandar mensajes | `pnpm prove --whatsapp <número>` |

`--fast` saltea el ensayo (gratis, sin tokens). `--local` saltea el chequeo de
producción.

---

## Lo que corre solo

**En cada push a `main`** — `.github/workflows/ci.yml`, que ya existía: tipos,
lint, tests, build, auditoría de dependencias.

**Después de cada deploy de producción** — `.github/workflows/post-deploy.yml`.
GitHub recibe de Vercel el aviso de que el deploy terminó bien y dispara
`pnpm smoke --deep` contra el alias: base de datos, migraciones, una subida
real a R2, una llamada real al modelo, el token de WhatsApp y la casilla.

Antes de mirar nada, espera a que el alias sirva **el commit de ese deploy**.
Sin eso el chequeo puede interrogar al build anterior y darlo por bueno — la
respuesta más peligrosa posible, porque tapa justo el deploy que se está
preguntando.

Necesita un solo secreto en GitHub, `CRON_SECRET`. Todo lo demás ya vive en el
deploy, que es exactamente el punto.

También se puede disparar a mano desde la pestaña *Actions* → *Post-deploy* →
*Run workflow*, con una URL distinta si querés apuntar a un preview.

**Lo que NO corre solo es el ensayo de conversaciones.** Necesita el juego
completo de credenciales de producción —base, Vertex, R2— y la clave que
descifra la casilla está marcada *Sensitive* en Vercel, o sea que no se puede
copiar a ningún lado. Corrélo vos con `pnpm check` cuando toques el
comportamiento del agente.

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

- **La interfaz.** No hay tests de navegador. Las pantallas se prueban mirándolas.
- **La sincronización con el core del asegurador**, que nunca se ejercitó contra
  un sistema real.
- **La entrega en sí.** `pnpm prove` confirma que el proveedor aceptó el
  mensaje. Que haya llegado al teléfono o a la bandeja lo mira una persona —
  aunque un rechazo del proveedor es el 95% de las formas de fallar.
