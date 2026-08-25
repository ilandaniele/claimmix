# Arquitectura — diagnóstico, opciones y plan

> Documento de decisión. Escrito el 2026-08-25, después de **medir** el código,
> no de recordarlo. Todos los números se pueden reproducir con los comandos que
> están al final.

---

## 1. Qué es esta aplicación, en realidad

No es un CRUD con pantallas. Es **una cañería con un flujo de trabajo en el
medio**:

```
   mensaje real            decisión automática           persona
  (mail / WhatsApp)   →   extraer · analizar faltantes  →  confirma
                          preguntar · escalar · cerrar
```

Y tiene dos mitades que no se parecen en nada:

| | **El núcleo de decisiones** | **El borde de integraciones** |
|---|---|---|
| Qué hace | qué falta, qué preguntar, cuándo escalar, cuándo cerrar | Gmail, WhatsApp, Vertex, Neon, Vercel |
| Cómo es | determinista, sin red, sin reloj | poco confiable, cambia solo, con permisos que vencen |
| Cuánto vale | es el producto | es plomería |
| Dónde pasan los incidentes | casi nunca | **siempre** |

Toda la sesión de estos dos días fue el borde: el push que se apagó solo, el
permiso que vencía a los siete días, el proxy borrado, la casilla que
desapareció por un 500 de Google. **Ninguno fue un error de lógica de negocio.**

Eso es un dato de arquitectura, no una anécdota: cualquier propuesta que no
separe esas dos mitades está resolviendo el problema equivocado.

---

## 2. Diagnóstico medido

### 2.1 El problema más grave: el aislamiento entre aseguradoras es de memoria

```
la app se conecta como:  neondb_owner   ← tiene rolbypassrls = SÍ
tablas con RLS activado:      28
tablas con FORCE RLS:          0
políticas escritas:           28   ← ninguna se aplica jamás
filtros eq(tenant_id) a mano: 198  ← repartidos en 107 archivos
```

Las 28 políticas de seguridad a nivel de fila **no corren nunca**. El rol de la
aplicación es dueño de las tablas y saltea RLS. La migración `0004` lo dice en
un comentario, con honestidad, pero el efecto es que **lo único que separa los
datos de una aseguradora de los de otra son 198 cláusulas `WHERE` escritas a
mano**.

Ciento noventa y ocho oportunidades de olvidarse una. Una sola alcanza para que
una aseguradora vea los siniestros de otra — que es exactamente el riesgo N.º 1
de OWASP, presente en el 94 % de las aplicaciones auditadas.

El pen test cubre las rutas que existen hoy. No cubre la ruta que escribas el
mes que viene con un filtro de menos.

### 2.2 La lógica está pegada a la infraestructura

```
archivos en src/server que NO tocan infra ni env:   23 de 77
llamadas a vi.mock en los tests:                   349 en 74 archivos
el peor:              tests/unit/extractor-ac6-happy-path.test.ts → 26 mocks
```

Trescientos cuarenta y nueve mocks no son una elección de estilo: son la
factura del acoplamiento. Para probar una decisión de negocio —«¿le falta la
patente?»— hay que simular la base, Gmail, Vertex y el reloj.

Y hay un costo peor que la incomodidad: **un test con 26 mocks confirma el
diseño que tenés, no el comportamiento que querés**. Cuando el diseño está mal,
el test lo bendice.

### 2.3 Dos archivos saben demasiado

```
src/server/worker/extract.ts             1564 líneas · 33 imports
src/server/confirmations/orchestrate.ts  1424 líneas · db + IA + mensajería
                                                       + auditoría + alertas
```

`extract.ts` importa base de datos, presupuesto de IA, tres extractores,
clasificador de severidad, dos matchers, la máquina de estados, autenticación
interna, mensajería y entrenamiento. Es el archivo donde toda decisión toca
todo lo demás.

### 2.4 Se mezclan los tres enfoques de datos, contra lo que dice Next

La guía de seguridad de Next 16 —la que está en `node_modules/next/dist/docs/`,
o sea la que el propio framework instala— es explícita: *elegí un enfoque de
acceso a datos y no los mezcles*. Hoy están los tres a la vez:

```
componentes/páginas con SQL directo:   9
rutas de API con SQL directo:         31
que pasan por src/server:             42
archivos que leen process.env:        48   (Next: sólo la capa de datos)
lecturas de process.env:             147
```

### 2.5 Ya hay un motor de flujos, escrito a mano y desparramado

```
MAX_CHAIN = 6, BATCH_BUDGET_MS = 240_000   ← planificador de continuaciones casero
17 referencias a auto-invocación por HTTP  ← la app se llama a sí misma para seguir
 9 referencias a leases a mano             ← cola de trabajo con candados propios
77 reintentos dispersos por el código      ← cada uno con su criterio
```

```
/api/worker/extract   maxDuration = 60 s   ← el que hace el trabajo
un caso tarda         ~15 s
→ entran ~4 casos por invocación, y de ahí MAX_CHAIN = 6

/api/cron/reap-stuck  "recoger los atascados"
```

Son cuatro piezas de un motor de ejecución durable, hechas a mano y sin estar
unidas, para esquivar el límite de tiempo de una función serverless.

**Y hay un cron cuyo trabajo es juntar los casos que queden atascados**
(`reap-stuck`). Nació porque la cañería sí perdía casos: la invocación se
cortaba a mitad y los que faltaban quedaban en `procesando` para siempre.
`batch-budget.ts` corrigió eso, y **hoy el barrendero no atrapa nada** — cero
casos atascados sobre 464. Lo que queda no es pérdida de datos sino cuatro
piezas caseras que sostienen algo que un motor hace solo.

Y explica un bug real: **«los batches grandes pierden casos»** es exactamente
cómo falla una cadena casera cuando se le acaba el presupuesto de tiempo. Se
parchó subiendo el presupuesto; el modo de falla sigue ahí.

### 2.6 Lo que se veía sano y no lo estaba

Tres incidentes en dos días, todos con la misma forma: **el sistema informaba
salud y estaba degradado.**

- `/api/health` decía «casilla conectada, token legible» —las dos cosas
  ciertas— mientras el push estaba muerto hacía horas.
- El proxy borrado: producción sirvió `/bandeja` sin sesión, y el build lo
  decía en una línea que nadie miró.
- La demo figuraba como «hecha y verificada» durante semanas sin ser
  alcanzable sin cuenta.

No es mala suerte tres veces. Es que **el sistema no tiene forma de afirmar sus
propias invariantes**: cada chequeo mide lo que es fácil de medir, no lo que
importa.

---

## 3. Las opciones

Las tres respetan tres restricciones que no son negociables: hay siniestros
reales entrando por esta cañería **hoy**; el desarrollo es de una persona; y son
52.163 líneas. Cualquier plan que empiece con «reescribamos» está mal antes de
la primera línea.

---

### Opción A — Hexagonal con núcleo funcional (Puertos y Adaptadores)

**La idea.** El dominio queda en el centro, sin importar nada de afuera. Todo lo
externo entra por *puertos* (interfaces) y se implementa en *adaptadores*.

```
src/core/          ← cero imports de db, red, env o reloj
   case/fsm.ts             la máquina de estados
   case/gaps.ts            qué falta y qué preguntar
   case/severity.ts        cuándo escalar
   billing/statement.ts    ya vive así hoy, y no es casualidad

src/ports/         ← interfaces, no implementaciones
   CaseRepository · Messenger · Extractor · Clock · Budget

src/adapters/      ← acá vive lo feo
   drizzle/ · gmail/ · whatsapp/ · vertex/
```

**Qué compra.** Los 349 mocks se caen solos: probás decisiones con datos planos,
sin simular nada. Cambiar Vertex por otro modelo, o Neon por otra base, deja de
ser cirugía. Es la arquitectura que mejor le calza al **núcleo** de esta app.

**Qué cuesta.** Es la más cara: hay que reubicar buena parte de las 24.750
líneas de `src/server`. Y trae un riesgo real, que es la crítica mejor fundada
que se le hace a *Clean Code*: **la sobre-abstracción**. Un puerto para cada
cosa es ceremonia — indirección sin claridad. Si se elige esta, la regla es:
puertos sólo en los cinco bordes de verdad, no en cada función.

**Qué no resuelve.** Nada sobre multi-tenencia. El olvido de un `WHERE` sigue
siendo posible.

---

### Opción B — Rebanadas verticales + Capa de Acceso a Datos

**La idea.** Organizar por funcionalidad y no por capa, y meter **una sola
puerta a los datos**. Es lo que Next 16 recomienda para proyectos nuevos y lo
que más se usa en 2026.

```
src/data/          ← la ÚNICA puerta a la base. El único lugar con SQL.
                     El único que lee process.env.
                     Devuelve DTOs, no filas.

src/features/
   intake-email/     su ruta, su lógica, sus consultas, sus tests
   intake-whatsapp/
   case-review/
   billing/
   agent-training/
```

**Lo que la hace valiosa acá:** la capa de datos puede hacer que **el aislamiento
entre aseguradoras deje de ser un acto de memoria**. Si la única forma de armar
una consulta es pidiéndola con un contexto de tenant, olvidarse el filtro deja
de ser posible — no por disciplina, sino porque no compila.

**Qué cuesta.** Menos, y sobre todo: **se puede hacer de a una rebanada**, con la
app funcionando. Es la opción con menor riesgo de romper producción.

**Qué no resuelve.** Las rebanadas tienden a duplicar lógica. Y el núcleo
compartido —la máquina de estados, el análisis de faltantes— necesita un lugar
igual: no es de ninguna rebanada, es de todas.

---

### Opción C — Híbrida ⭐ (mi recomendación)

Las dos anteriores resuelven mitades distintas, y esta aplicación tiene las dos.
Por afuera es una app de Next; por adentro es un flujo de siniestros.

```
src/core/       ← núcleo funcional (de A): decisiones puras, sin infra
src/data/       ← capa de datos con tenencia obligatoria (de B)
src/features/   ← rebanadas verticales (de B)
src/adapters/   ← puertos SÓLO en los cinco bordes reales (de A):
                  base · mensajería · modelo · reloj · presupuesto
```

Más las dos defensas que los incidentes de estos días piden a gritos:

**1. Que la base se niegue, en vez de que el código se acuerde.**
Crear un rol de aplicación que **no** sea dueño de las tablas, activar
`FORCE ROW LEVEL SECURITY`, y que la capa de datos ponga
`SET LOCAL claimmix.tenant_id` en cada transacción. Las 28 políticas que hoy no
corren empiezan a correr. Si mañana alguien olvida un `WHERE`, la base devuelve
cero filas en vez de las de otra aseguradora.

> ⚠️ **La parte delicada.** El driver HTTP de Neon no mantiene sesión entre
> consultas, así que `SET LOCAL` exige transacción — y eso cambia cómo se
> escriben las consultas. Es lo que hay que probar **primero**, con un
> experimento chico, antes de comprometerse. Ver Fase 0.

**2. Invariantes que se miden, no que se suponen.**
El chequeo de push que agregué ayer es el molde: no pregunta «¿hay token?» sino
«¿este aviso pertenece al permiso vigente?». La regla que sale de los tres
incidentes: **un chequeo de salud tiene que medir la consecuencia, no la
configuración.**

**Qué cuesta.** Más que B, menos que A, y se recorre en el mismo orden
incremental que B — el núcleo se extrae a medida que cada rebanada lo necesita,
no de entrada.

---

---

### Opción C-máxima — la misma C, sin límite de tiempo

Si el objetivo es lo más limpio posible y el costo en semanas no manda, **la
respuesta no cambia a A**. Vale la pena decir por qué, porque es tentador
suponer que más caro es más limpio.

**Limpio no es lo mismo que abstracto.** La medida de limpieza acá no es cuántas
capas hay, es: *¿se puede escribir lo incorrecto?* Hexagonal pura, con
presupuesto infinito y ejecución impecable, **sigue permitiendo que alguien
olvide un `WHERE tenant_id`**. Ninguna cantidad de pureza de dominio detiene una
fuga entre aseguradoras. Una arquitectura que deja pasar el peor error posible
no es la más limpia, por elegante que sea el diagrama.

Lo que cambia al sacar el límite es **hasta dónde llega cada pieza de C**:

**1. Ejecución durable para la cañería.** Reemplazar las cuatro piezas caseras
de §2.5 por un motor de verdad: cada paso —extraer, analizar, preguntar, esperar
respuesta, cerrar— se vuelve un paso durable, con reintentos, estado persistido
y reanudación. Se van `MAX_CHAIN`, la auto-invocación HTTP, los leases y los 77
reintentos ad-hoc. **Un caso deja de poder perderse porque a la función se le
acabó el tiempo.** Candidatos para este stack: **Inngest** (nativo de serverless,
TypeScript primero, corre sobre el cómputo que ya hay) o el **Workflow DevKit de
Vercel** (sin proveedor nuevo).

**2. Tenencia en dos capas, no en una.** Tipos *y* base: que no compile **y** que
Postgres lo rechace. Dos mecanismos independientes, uno que falla en tu máquina
y otro en la base.

**3. Los errores en el tipo, no en el aire.** Los tres incidentes de esta semana
fueron fallas silenciosas. Un canal de error explícito en las firmas hace que
«esto puede fallar y nadie se entera» sea imposible de escribir sin verlo.

**4. Workload Identity Federation.** Sacar la clave de cuenta de servicio de los
tres lugares donde vive.

#### Lo que NO haría ni con presupuesto infinito

Importa tanto como lo anterior: «sin importar el costo» es justo la condición
donde se cuela la sobre-ingeniería.

- **Effect-TS completo.** Es la respuesta más de moda en 2026 y la descarto
  igual: cambia el idioma de todo el proyecto, y su beneficio real —errores
  tipados y reintentos— se consigue con un `Result` chico más el motor durable.
- **Un puerto por cada cosa.** Cinco bordes reales: base, mensajería, modelo,
  reloj, presupuesto. El resto son funciones.
- **Microservicios o event sourcing completo.** Nada de lo medido los justifica,
  y ambos multiplican los modos de falla silenciosa que ya son el problema.

**Costo honesto: 10 a 12 semanas**, contra 3-5 de la C incremental.

---

### ¿Y si cambiamos de lenguaje o de framework?

La pregunta se hizo explícitamente, con la disposición a refactorizar todo. La
respuesta es **no**, y conviene que quede el porqué medido y no como opinión.

**TypeScript no causó ninguno de los problemas de §2.** Ni la tenencia de
memoria, ni los 349 mocks, ni los archivos gordos, ni las fallas silenciosas.
Cambiar a Go, Rust o C# no arregla uno solo — y se tiran 2.101 tests, 107
escenarios reales de siniestros argentinos y toda la cañería de afinado del
modelo. Es pagar meses para conservar los mismos defectos escritos distinto.

**Next.js tampoco.** Sirve la UI y las rutas bien, y su guía de datos es la que
vamos a seguir igual. Partirlo en NestJS + React deja dos cosas que desplegar y
toda la interfaz por reescribir, a cambio de una inyección de dependencias que
en TypeScript se hace con funciones.

**Lo que sí está mal elegido es dónde corre la cañería.** Un proceso de 15
segundos por caso, en rebanadas de 60, que se auto-invoca por HTTP para seguir y
necesita un barrendero programado. Eso no es un detalle de infraestructura: es
la causa de las cuatro piezas caseras y del bug de los lotes.

Dos salidas, **ninguna cambia de lenguaje**:

- **(a) Motor de ejecución durable, todo donde está.** Inngest o el Workflow
  DevKit de Vercel. Se van `MAX_CHAIN`, la auto-invocación, los leases y
  `reap-stuck`. Sin infraestructura nueva que mantener, y **reversible**.
- **(b) Separar la cañería de la app web.** La UI se queda en Vercel; el trabajo
  se muda a un proceso largo en contenedor. El límite de tiempo desaparece en
  vez de esquivarse, y resuelve el pendiente de «el techo es el plan, no el
  código». **No es reversible barato.**

→ **(a) primero; (b) sólo si la extracción se pone más pesada o el costo lo
pide.** Ambas se prueban en la Fase 0-B antes de comprometer nada.

**La refactorización completa vale la pena — gastada en la arquitectura, no en
el lenguaje.**

## 4. Comparación

| | **A — Hexagonal** | **B — Rebanadas + DAL** | **C — Híbrida** |
|---|---|---|---|
| Arregla la tenencia | ✗ | ✓✓ | ✓✓✓ (código **y** base) |
| Mata los 349 mocks | ✓✓✓ | ✓ | ✓✓ |
| Desarma los archivos gordos | ✓✓ | ✓✓ | ✓✓ |
| Va con Next 16 | ~ (nada en contra) | ✓✓✓ (es su consejo) | ✓✓ |
| Se hace de a poco | ~ | ✓✓✓ | ✓✓ |
| Riesgo de romper producción | medio | bajo | bajo-medio |
| Riesgo de sobre-ingeniería | **alto** | bajo | medio |
| Esfuerzo estimado | ~4-6 semanas | ~2-3 semanas | ~3-5 semanas |

---

## 5. De *Clean Code*: qué aplico y qué descarto

Busqué el libro y también su crítica, porque aplicarlo entero sería un error.

**Lo que se sostiene, y sí aplico:**
- **Nombres que dicen la verdad.** `getStatement` no debería congelar una
  factura de paso; si lo hace, el nombre miente.
- **Un solo nivel de abstracción por función.** Es exactamente lo que rompe
  `extract.ts`: decide negocio y habla HTTP en el mismo cuerpo.
- **Fronteras y capa anticorrupción.** Lo que devuelve Gmail o Vertex no debería
  circular crudo por el sistema.
- **Errores como errores.** Ya está aprendido acá: devolver `is_claim:false`
  ante una falla técnica fue el peor bug del proyecto.

**Lo que descarto, y por qué:**
- **«Funciones de cuatro líneas».** Extraer cada condicional produce indirección
  sin claridad. Es la crítica mejor fundada al libro.
- **El rechazo a las funciones puras.** Es lo más flojo del libro y va contra lo
  que a esta app le conviene: **el núcleo tiene que ser puro**, porque es lo que
  permite probarlo sin mocks.
- **«Los comentarios son olor a código».** En este repo, los comentarios que
  explican *por qué* —qué incidente lo causó— son lo que evita repetir el error.
  Se quedan.

---

## 6. El plan, por fases

Cada fase termina con producción andando y `pnpm check` en verde. Ninguna
depende de terminar la siguiente.

### Fase 0-A — La tenencia por base (2-3 días) · *antes de elegir*
Probar `FORCE RLS` + rol no-dueño + `SET LOCAL` en transacción **contra una rama
de la base de Neon**, no contra producción. Es la parte que puede fallar por el
driver HTTP.
→ **Si funciona, C es claramente la mejor. Si no, la respuesta es B y la
tenencia se defiende sólo por tipos.**

### Fase 0-B — La ejecución durable (3-4 días) · *sólo para C-máxima*
Migrar **un** flujo real punta a punta a pasos durables y medir si sobrevive el
corte: se mata la función a mitad y el flujo tiene que retomar donde iba, sin
repetir el paso ya hecho. No se compromete el resto hasta que este ande.
→ Vale la misma regla que arriba: no se recomienda una pieza central sin
probarla. Es exactamente el error del proxy borrado, en versión arquitectura.

### Fase 1 — La puerta única a los datos (1 semana)
`src/data/` con contexto de tenant obligatorio. Migrar las 31 rutas y 9 páginas
que hoy hablan SQL directo. Los 147 `process.env` se concentran acá.

### Fase 2 — Extraer el núcleo (1-1½ semanas)
Sacar las decisiones puras de `extract.ts` y `orchestrate.ts` a `src/core/`.
Cada función que sale, sale **con sus tests sin mocks**. La medida del avance no
es «líneas movidas»: es **cuántos de los 349 mocks desaparecieron**.

### Fase 3 — Rebanadas (1 semana)
Reorganizar por funcionalidad. Es sobre todo mover archivos: riesgo bajo,
beneficio de orientación alto.

### Fase 4 — Las pruebas, sobre la arquitectura nueva
No antes: probar la estructura vieja es pagar dos veces.
- **Unitarias:** el núcleo, con datos planos. Objetivo declarado: **menos de 100
  mocks en todo el repo** (hoy 349).
- **Punta a punta:** Playwright ya está instalado y sin usar. Los recorridos que
  importan: alta de tenant, un siniestro de principio a fin, confirmación
  humana, cierre.
- **Carga masiva:** hoy `pnpm load` es casero. Pasarlo a **k6** como portón en
  CI, y dejar el script actual para escenarios largos. El consenso 2026 es k6
  para CI y artillery para recorridos complejos.

### Fase 5 — Seguridad
`security-review` sobre la arquitectura nueva, más lo que hoy no se cubre:
prueba de tenencia cruzada real —dos tenants, una consulta a la que se le quita
el filtro a propósito, verificar que **la base** la rechaza— y las rotaciones
pendientes.

---

## 7. Lo que necesito que decidas

1. **¿A, B, C o C-máxima?** (mi voto: **C**, con la Fase 0-A primero — si el
   experimento falla, cae sola en B sin haber perdido nada. Si el objetivo es lo
   más limpio sin mirar el reloj, **C-máxima**, con las dos Fase 0).
2. **¿Corto o largo?** Si el objetivo es un piloto con una aseguradora en pocas
   semanas, B alcanza y sobra. Si es la base de un producto multi-cliente, la
   tenencia por base de datos de C se paga sola la primera vez que evita una
   fuga.
3. **¿Arrancamos por la Fase 0 ya**, o primero cierro los pendientes de rotación
   de credenciales?

---

## Reproducir estos números

```bash
grep -rn 'tenant_id' src --include='*.ts' | grep -c 'eq('
grep -rn 'vi.mock(' tests | wc -l
grep -rl 'from "@/lib/db"' src/app | wc -l
grep -rn 'process.env' src --include='*.ts' --include='*.tsx' | wc -l
```

El estado del RLS se mide **contra la base**, no contra las migraciones: las
migraciones dicen qué se pidió, `pg_class.relforcerowsecurity` dice qué pasa.

## Fuentes

- Next.js 16, guía de seguridad de datos — `node_modules/next/dist/docs/01-app/02-guides/data-security.md`
- [Complete Next.js security guide 2026 — TurboStarter](https://www.turbostarter.dev/blog/complete-nextjs-security-guide-2026-authentication-api-protection-and-best-practices)
- [Vertical Slice Architecture for Web Apps](https://cleancodeguy.com/blog/vertical-slice-architecture)
- [Hexagonal Architecture in Next.js — Cristian Fonseca](https://cristianfonseca.dev/blog/next-hexagonal-architecture/)
- [Functional Core with Ports and Adapters](https://dev.to/siy/functional-core-with-ports-and-adapters-3m0g)
- [It's probably time to stop recommending Clean Code — qntm](https://qntm.org/clean)
- [Clean Code: crítica capítulo por capítulo](https://bugzmanov.github.io/cleancode-critique/)
- [autocannon vs k6 vs artillery (2026)](https://www.pkgpulse.com/guides/autocannon-vs-k6-vs-artillery-load-testing-api-2026)


> **Corrección (2026-08-25).** Este documento afirmaba que la cañería pierde
> casos y que la existencia del cron `reap-stuck` lo probaba. **Lo verifiqué
> contra producción y no es cierto hoy:** de 464 casos, cero quedaron atascados
> en `procesando`. La pérdida silenciosa era el comportamiento *anterior* a
> `batch-budget.ts`, que la corrigió; el barrendero quedó como red de seguridad
> y no está atrapando nada. El argumento por la ejecución durable sigue en pie,
> pero por otros motivos —las cuatro piezas caseras, las esperas largas, la
> imposibilidad de reanudar y la falta de visibilidad—, no por pérdida de datos.
