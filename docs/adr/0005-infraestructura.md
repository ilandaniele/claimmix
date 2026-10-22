# ADR 0005 — Infraestructura: quedarse en Vercel y Neon por ahora, y medir antes de mudar nada

**Date:** 2026-10-21
**Status:** Accepted (se revisa cuando exista el resultado de la prueba de 700 usuarios)
**Deciders:** Dueño de ClaimMix (decidió no usar planes pagos por ahora); borrador de Claude

## Context

El dueño anotó: «Ver si no conviene otra infraestructura con Amazon o algo así». Este ADR
responde esa nota para una carga de 700 usuarios registrados: unas 20 aseguradoras de 30 a
50 personas cada una, con unos cientos conectados a la vez en horario de oficina.

### Lo que hay hoy

- **Hosting:** tres proyectos de Vercel en el plan Hobby (`claimmix` para dev,
  `claimmix-qa`, `claimmix-prd`), región `gru1`, dominio `claimmix.vercel.app` para
  producción. Los términos de Hobby son de uso no comercial; el dueño ya lo dejó señalado
  y decidió no usar planes pagos (`docs/PROMOCION.md:809-810`).
- **Cron:** dos crons diarios en `vercel.json` (`gmail-poll` a las 03:00 y `reap-stuck` a las
  04:07). Hobby sólo admite crons que corran una vez por día.
- **Cañería de casos:** Workflow DevKit de Vercel (`workflow` 5, `withWorkflow`). Es un
  servicio administrado; `src/workflows/retomar-tras-corte.ts` duerme 45 s dentro de él.
  `docs/ARQUITECTURA.md` (alrededor de las líneas 340-352) ya discutió la alternativa de un
  contenedor aparte y la dejó descartada por «no es reversible barato».
- **Base:** Neon Postgres, plan Free, proyecto `claimmix-prd` en `aws-sa-east-1`, con el
  driver `drizzle-orm/neon-http`. Con `BASE_POR_CLIENTE=1` cada cliente tiene su base
  `t_<hex>` dentro del mismo proyecto, más una base de control. Es de una sola vía
  (`docs/PROMOCION.md:779-785`) y todas las bases comparten el cómputo y el almacenamiento
  del proyecto. Los topes de alta son `ALTA_TOPE_BASES=30` y `ALTA_TOPE_MB=350`, porque el
  repo toma 500 MB por proyecto en Free (`docs/PROMOCION.md:727-728`).
- **IA:** Gemini por Vertex AI, región `us`, autenticado por Workload Identity Federation
  (WIF) desde el OIDC de Vercel (pools `vercel` y `vercel-prd`, `src/server/gcp/credenciales.ts`).
- **Archivos:** Cloudflare R2. **CI:** GitHub Actions, gratis desde que el repo es público
  (16/10).
- **Entradas desde afuera, todas atadas a `claimmix.vercel.app`:** webhooks de WhatsApp de
  Meta (`/api/webhooks/whatsapp/app/[ruta]`), push de Gmail por Pub/Sub
  (`/api/webhooks/gmail`, tópico `gmail-push-prd` en el proyecto de GCP `claimmix-prd-veltra`),
  redirecciones de OAuth de Google, la URL base de Better Auth y los hostnames de Turnstile.
  Hoy no hay dominio propio.

### Lo que ya se midió

La prueba del 21/08/2026 (`docs/TESTING.md:495-520`), contra producción en Hobby y Neon:
100 denuncias simultáneas, ninguna perdida, respuesta p95 de 58,1 s, y el tablero del
analista en 391 ms de p95 durante la tormenta. Ese documento ya anticipa que lo que va a
aparecer no es el código sino los límites de plan y de cuota: «son escalones, no curvas».

### Carga esperada (supuestos míos, no datos)

Todo lo que sigue usa estos supuestos. Si el dueño tiene números reales de casos por mes,
reemplazan a los míos y hay que rehacer las cuentas.

- 700 usuarios registrados; unos 110 con la bandeja abierta de media durante las 198 horas
  hábiles del mes (22 días por 9 horas) y un pico cercano a 250.
- El tablero consulta cada 5 a 30 segundos (`useCasesRealtime.ts`: `POLL_MIN_MS` 5000,
  `POLL_MAX_MS` 30000, sube solo cuando no hay cambios). Supuse un pedido cada 10 s por
  usuario: unos 11 pedidos por segundo de media, 25 en el pico, unos 8 millones al mes.
- 60 ms de CPU activa por pedido (no lo medí).
- Unos 4.000 casos nuevos por mes (20 aseguradoras, unos 200 casos cada una) y 25 eventos
  de workflow por caso, o sea 100.000 eventos al mes.
- Entre 0,1 y 0,3 MB por caso. Sale de dos cifras del repo: `audit_log` pesa unos 59 kB por
  caso (142 filas) y cada fila de `claim_messages` pesa 31 kB (`docs/PROJECT_STATUS.md`,
  cerca de la línea 2569); lo demás es mi estimación. Con eso la base suma entre 5 y 14 GB
  por año; usé 10 GB en las cuentas de Neon.

## Qué se acaba primero en el stack actual

En orden de aparición, con los supuestos de arriba:

1. **Los términos de Hobby.** No es un límite técnico sino contractual: la primera
   aseguradora que pague convierte el uso en comercial. Es el único que llega con el primer
   cliente, sin esperar a ninguna carga.
2. **Las cuotas incluidas de Hobby.** Hobby incluye 4 horas de CPU activa, 360 GB-hora de
   memoria aprovisionada y 1 millón de invocaciones. Con mis supuestos el consumo sería de
   unas 133 horas, 1.742 GB-hora y 8 millones: 33, 5 y 8 veces la cuota. Hobby no cobra
   excedente; según su página, al pasarse hay que esperar 30 días para volver a usar la
   función. Es un corte, no una lentitud. Lo mismo vale para el Workflow DevKit: Hobby
   incluye 50.000 eventos al mes y 1 GB escrito, y con 25 eventos por caso alcanzan para unos
   2.000 casos; los 100.000 eventos supuestos son el doble de la cuota.
3. **El almacenamiento de Neon.** Con 4.000 casos por mes y 0,1 a 0,3 MB por caso, la base
   crece entre 0,4 y 1,2 GB por mes. El tope propio de 350 MB se alcanzaría entre la primera
   y la cuarta semana. `BASE_POR_CLIENTE` no ayuda: todas las bases comparten el almacenamiento del
   proyecto. Si el volumen real de casos es la décima parte, esto se mueve a meses.
4. **Las horas de cómputo de Neon Free.** Free incluye 100 CU-hora por proyecto. Una base
   despierta en horario hábil a 0,5 CU ya consume unas 99 CU-hora al mes, y a 1 CU son 198.
   Hoy rinde porque el cómputo se suspende casi todo el tiempo; no medí el consumo actual de
   CU-hora y habría que leerlo en la consola de Neon.
5. **Conexiones.** Neon da 104 conexiones directas a 0,25 CU, 209 a 0,5 CU, 419 a 1 CU y 839
   a 2 CU; el pooler admite 10.000 clientes y arma el pool por usuario y base. Con el driver
   HTTP la presión depende de las consultas en vuelo y no de los usuarios, así que no lo
   espero primero. No lo medí.
6. **Cadencia de los crons.** Hobby sólo permite uno por día con precisión de ±59 minutos.
   Mientras Gmail empuje por Pub/Sub y `retomar-tras-corte` cubra los cortes, el cron diario
   es un respaldo y no un problema.
7. **Deploys.** Hobby permite 100 deploys por día y 100 builds por hora, y un deploy
   concurrente. Con tres proyectos sobre el mismo repo ya obligó a promover a producción una
   vez por día (`docs/PROMOCION.md:586-589`). Es una limitación de trabajo, no de carga.
8. **Duración de las funciones.** 300 s en Hobby. La cañería tarda unos 15 s por caso y el
   p95 medido bajo 100 denuncias fue de 58 s; no es el cuello. Los recortes de Gemini son un
   problema de Vertex en `us`, y cambiar de hosting no los toca.

## Opciones

Los precios de la lista son de lista, sin descuentos, en dólares por mes. Cada dato externo
está en la sección «Datos externos y fuentes» con su URL y la fecha de consulta
(2026-10-21). Lo que no apareció está marcado como tal en vez de rellenarse.

El costo de Gemini por Vertex no entra en ninguna de las columnas: es igual en todas las
opciones y no lo investigué.

### A. Quedarse en Hobby y Free

Costo fijo de US$ 0. Los topes son los de la sección anterior. Es la única opción que no
viola ninguna decisión del dueño, y con aseguradoras que pagan choca con los términos de uso.

### B. Vercel Pro y Neon Launch

No cambia código ni infraestructura: sólo el plan de cada proveedor. Hecho con mis supuestos:

- Vercel Pro: US$ 20 de cuota de plataforma, que incluyen US$ 20 de crédito de uso. Uso en
  `gru1`: CPU activa 8 M × 0,06 s = 133 h × US$ 0.221 = US$ 29.5; memoria 4 instancias × 2 GB
  × 198 h × 1,1 = 1.742 GB-h × US$ 0.0183 = US$ 31.9; invocaciones 8 M × US$ 0.60 por
  millón = US$ 4.8; workflow 100.000 eventos × US$ 0.02 por mil = US$ 2. Uso total US$ 68.2,
  y como el crédito de US$ 20 queda dentro de la cuota, la factura ronda **US$ 68**.
  Duplicando o dividiendo el uso a la mitad queda entre US$ 34 y US$ 136. Cada asiento
  extra que despliegue cuesta US$ 20, y no cuento transferencia de datos.
- Neon Launch, sin mínimo mensual: 1 CU de media en horario hábil y 0,25 CU el resto son 331
  CU-hora × US$ 0.106 = US$ 35.1, más 10 GB × US$ 0.35 = US$ 3.5, o sea **US$ 39**. Con 2 CU de
  media en horario hábil son 529 CU-hora, **US$ 60**. Con 50 GB de almacenamiento suma US$ 14.
- Total: **de US$ 105 a 130** en el caso base; de US$ 75 a 195 en los extremos.
- Neon Scale cuesta US$ 77 a 121 sólo de cómputo y almacenamiento en los mismos supuestos
  (US$ 0.222 por CU-hora) a cambio de restauración puntual de hasta 30 días en vez de 7. Con
  Vercel Pro daría de US$ 145 a 190. No hay un motivo técnico hoy para Scale.

Es el escalón más barato de cambiar porque el código no se entera. Es también el único que
resuelve los dos primeros puntos de la lista de arriba.

### C. AWS: Amplify Hosting

No lo evalué en costo porque no tiene sentido hacerlo todavía. La documentación oficial
de Amplify dice que administra el renderizado del lado del servidor para Next.js 12 a 15; la
versión 16, que es la que usa este repo (16.4.1), no figura. Tampoco apareció el límite de
tiempo por pedido ni las cuotas de cómputo. Los precios sí aparecieron: US$ 0.30 por millón
de pedidos de SSR (8 M al mes serían US$ 2.40) y US$ 0.20 por GB-hora de duración, pero sin
memoria ni duración por pedido no puedo sumarlos. Además deja sin resolver el motor de
workflows, los crons y la base.

### D. AWS: ECS Fargate con RDS o Aurora

Dos tareas Fargate ARM de 1 vCPU y 2 GB, prendidas todo el mes, a tarifa de Virginia
(US$ 0.03238 por vCPU-hora y US$ 0.00356 por GB-hora): 2 × 730 h × (0,03238 + 2 × 0,00356) =
**US$ 57.7**. La tarifa de São Paulo no apareció.

Base, dos variantes:

- RDS PostgreSQL `db.t4g.medium` (2 vCPU, 4 GiB) de una sola zona: unos **US$ 47** al mes
  según un sitio de terceros que no es AWS. La página de AWS tiene las tablas colapsadas:
  no aparecieron el precio de Multi-AZ, el de gp3 ni el de respaldos. Lo único cercano es un
  ejemplo de AWS con volumen io1 donde Multi-AZ cuesta el doble que una zona (US$ 856
  contra US$ 428); no vale como precio de esta instancia.
- Aurora Serverless v2: US$ 0.12 por ACU-hora y US$ 0.10 por GB-mes, más US$ 0.20 por millón de
  pedidos de I/O. Con 2 ACU en horario hábil y 0,5 ACU el resto son 662 ACU-hora, **US$ 79**,
  más US$ 1 de 10 GB; el I/O no lo estimé. La página es incoherente sobre la capacidad
  mínima (0 ACU en una tabla, 0,5 ACU en un ejemplo).

Total mínimo: de **US$ 105** (Fargate y RDS) a **US$ 138** (Fargate y Aurora). Faltan el
balanceador, la salida a internet por NAT, los logs, el dominio y el scheduler de los crons:
ninguno de esos precios apareció. Hay que sumar el trabajo de armar la imagen, el pipeline de
deploy de tres ambientes y el autoescalado, que no tiene precio de lista.

### E. Google Cloud: Cloud Run con Cloud SQL

Cloud Run con cobro por pedido, tarifa de Iowa (US$ 0.000024 por vCPU-segundo, US$ 0.0000025
por GiB-segundo, US$ 0.40 por millón de pedidos), tres instancias de 1 vCPU y 2 GiB contadas
durante todas las horas hábiles aunque el cobro real sea sólo mientras atienden pedidos:
2.138.400 segundos, CPU US$ 51.3, memoria US$ 10.7, pedidos 8 M × US$ 0.40/M = US$ 3.2,
menos US$ 5.2 de cupo gratuito, unos **US$ 60**. São Paulo figura en el nivel 2 de precios, más
caro, pero la tarifa no apareció. Cloud Run admite hasta 60 minutos por pedido y 80 pedidos
concurrentes por instancia de manera predeterminada (hasta 1.000).

Cloud SQL Enterprise de 2 vCPU y 8 GiB, tarifa de Iowa (US$ 0.0413 por vCPU-hora y US$ 0.007 por GiB-hora):
(2 × 0,0413 + 8 × 0,007) × 730 = **US$ 101**, o **US$ 202** con alta disponibilidad
(US$ 0.0826 y US$ 0.014), más US$ 0.17 por GB-mes de SSD. El extracto de la página oficial
aparece en el índice con unos 629 días de antigüedad, así que pueden estar desactualizados.

Total: de **US$ 160** (sin alta disponibilidad) a **US$ 265** (con ella), en tarifas de Iowa. Falta
el scheduler de los crons: no apareció su precio.

### Comparación

Con estos supuestos las opciones B, D y E caen en el mismo orden de magnitud, entre US$ 100 y
US$ 270 al mes. No hay una que cueste claramente menos, y la diferencia que importa no es el
precio de lista sino lo que cuesta llegar. Dos aclaraciones que achican la diferencia real:
Neon cobra por uso y Cloud SQL o RDS por reloj; y la tarifa de Vercel en `gru1` es la más
cara de la tabla regional que leí (US$ 0.221 por hora de CPU contra US$ 0.128 en Virginia).

### Neon y Vercel ya corren sobre AWS

La región de Neon es `aws-sa-east-1`, o sea AWS en São Paulo, y la documentación de Vercel
mapea `gru1` a `sa-east-1`. No encontré una afirmación oficial de Vercel de que sus funciones
sean AWS Lambda, así que no la hago. Lo que sí vale: la aplicación y la base ya están en la
misma región geográfica, de modo que mudar la aplicación a ECS en `sa-east-1` no acerca nada
a la base. Y Gemini sigue en Vertex `us`, de modo que ningún hosting cambia ese salto.

## Costo y riesgos de una mudanza fuera de Vercel o de Neon

Esta lista no estima días. Sin un ambiente de prueba donde ensayarlo, un número sería
inventado. Es un proyecto, no una tarea de un día.

- **WIF.** Hoy el OIDC de Vercel entra a GCP por los pools `vercel` y `vercel-prd`, cuya
  condición mira el nombre del proyecto de Vercel. En Cloud Run se usaría la cuenta de servicio
  del propio servicio y el WIF de Vercel dejaría de hacer falta, pero hay que rehacer el
  camino de credenciales de todo lo que usa `@vercel/oidc`. En AWS haría falta otro proveedor
  en el pool; no investigué cómo se configura.
- **Webhooks de Meta.** La URL del webhook de cada WABA está registrada en la app de Meta y
  apunta a `claimmix.vercel.app`. Cambiarla exige entrar a Meta como administrador, volver a
  verificar el webhook y coordinar para no perder mensajes entre un host y el otro.
- **Push de Gmail.** La suscripción de Pub/Sub tiene como destino
  `/api/webhooks/gmail` en el dominio de Vercel. Hay que cambiar el destino de la
  suscripción y vigilar que no se pierdan notificaciones durante la ventana; el poll diario
  es el respaldo.
- **OAuth, Better Auth y Turnstile.** Las URI de redirección autorizadas, la URL base y los
  hostnames cambian con el dominio. Sin dominio propio, cada mudanza obliga a rehacerlas en
  tres ambientes. Poner un dominio propio antes de mudar convierte todo esto en una sola
  edición de DNS; es el primer paso de cualquier salida y no depende del proveedor elegido.
- **Base por cliente.** `BASE_POR_CLIENTE` es de una sola vía. Salir de Neon es migrar
  más de veinte bases con `pg_dump` y restauración, cambiar `src/lib/db/index.ts`, que usa
  `neon-http` y sólo anda contra Neon, y poner un pooler de conexiones. La capa de tenancy,
  `scripts/migrar-bases.mjs` y los topes de alta suponen un único proyecto de Neon.
- **Workflow DevKit.** Es un servicio de Vercel. No investigué si corre fuera; si no corre,
  vuelve el problema que `docs/ARQUITECTURA.md` resolvió: cañería sin motor durable, con
  leases y barrendero, o un motor distinto que hay que alojar y operar.
- **Crons.** Vercel Cron se reemplaza por EventBridge Scheduler o Cloud Scheduler. No encontré
  sus precios; mejoran la cadencia diaria.
- **Tres ambientes y el pipeline.** Dev, QA y producción son proyectos de Vercel ligados a
  ramas, con promoción por PR y ensayo del agente tras cada deploy
  (`docs/PROMOCION.md`). Cada uno pasaría a ser una pila entera de infraestructura y todo el
  pipeline de CI cambiaría.
- **Operación.** En un hosting administrado el parcheo, el autoescalado, los certificados y
  los logs los hace el proveedor. En Fargate o Cloud Run los hace alguien del equipo y no
  tiene precio de lista.

Mudar sólo el plan (opción B) no toca nada de esto.

## Decision

**Quedarse por ahora en Vercel Hobby, Neon Free, Vertex AI, R2 y GitHub Actions. No se
migra nada ni se contrata ningún plan, y se mide antes de decidir.**

1. **Medir con la prueba de 700 usuarios.** El escenario es
   `tests/load/scenarios/aseguradoras.js` (cómo correrlo, en `docs/TESTING.md`). Antes de pensar en mudar nada hay que correrla y
   anotar el resultado en este ADR o en uno nuevo. Para que sirva para decidir, además del
   p95 y de los errores, tiene que dejar leído de los paneles de cada proveedor, antes y
   después de la corrida: CPU activa, GB-hora e invocaciones de Vercel; CU-hora y
   almacenamiento de Neon; y las conexiones activas. La prueba consume cuota del plan.
   Correrla contra QA y no contra producción evita cortarle el mes a producción, aunque no
   verifiqué si la cuota de Hobby se cuenta por proyecto o por cuenta.
2. **Antes de gastar, bajar el consumo.** El intervalo de la bandeja ya sube de 5 a 30 s
   cuando no hay cambios; revisar otras fuentes de pedidos es gratis.
3. **Si un disparador se cumple, el orden de menor a mayor costo de cambio es** (a) Neon
   Launch y (b) Vercel Pro, ambos sin cambiar código, y recién después (c) evaluar salir de
   alguno. Esta lista ordena los cambios; no es una recomendación de contratar nada, que le
   corresponde al dueño.
4. **No se empieza una mudanza a AWS o GCP sin los disparadores de abajo.** Con estos
   supuestos el precio no la justifica.

### Disparadores que cambian la decisión

| Disparador | Cómo se mide | Qué cambia |
|---|---|---|
| Entra la primera aseguradora que paga | Contrato firmado | Los términos de Hobby ya no se cumplen. Es decisión del dueño: un plan que permita uso comercial, otro proveedor, o seguir como está sabiendo que los términos no se cumplen. Es la única pregunta que no espera a ninguna medición |
| El consumo de Vercel llega al 75 % de una cuota de Hobby (4 h de CPU, 360 GB-h, 1 M de invocaciones, 50.000 eventos de Workflow) | Panel de uso de Vercel, o la prueba | Hobby no cobra, corta 30 días. Antes del 100 %, decisión del dueño: cambiar de plan, recortar consumo o aceptar el corte |
| El almacenamiento de Neon pasa de 245 MB (70 % de `ALTA_TOPE_MB`), o las bases llegan a 21 de las 30 de `ALTA_TOPE_BASES` | `pg_database_size`, consola de Neon | Decisión del dueño: Launch (US$ 0.35 por GB-mes, sin mínimo), purgar datos viejos o aceptar el tope. Antes confirmar si Free admite 500 MB o 1 GB: el repo dice 500 y la documentación actual de Neon dice 1 GB por proyecto |
| Las CU-hora del mes pasan de 70 de las 100 de Free | Consola de Neon | Decisión del dueño: Launch, o bajar el consumo (sondeo, suspensión del cómputo) |
| El p95 del tablero pasa de 500 ms (`PRESUPUESTO_P95_MS`) bajo la carga de la prueba, o aparecen respuestas 429 o errores de conexión | `aseguradoras.js` y los paneles | Medir si es cómputo de Neon o de Vercel y subir sólo ese plan |
| Una ruta necesita más de 300 s | Logs de Vercel | Pro permite 300 s por defecto y 800 s como máximo; más que eso es un motivo para un contenedor, la opción (b) de `docs/ARQUITECTURA.md` |
| Hace falta un cron más frecuente que una vez por día, o con precisión mejor que ±59 minutos | Un caso de uso concreto | Pro permite uno por minuto |
| Los deploys por día llegan al tope de 100 | Mensajes del CLI | Hoy se evita con una promoción por día; si deja de alcanzar, es Pro |
| Un cliente pide un SLA, residencia de datos o que la aplicación corra en su propia cuenta de AWS o Google | El contrato | Es el único motivo que justifica salir de Vercel y Neon por una razón no técnica. No investigué los planes empresariales |
| La factura combinada de Vercel y Neon, medida durante tres meses, supera sostenidamente el doble de lo que cuesta la alternativa medida con la misma prueba (umbral propuesto por mí, el dueño puede cambiarlo) | Facturas y la prueba | Recién entonces se abre un ADR nuevo de mudanza, empezando por el dominio propio |

## Consequences

### Buenas

- No se gasta ni se rompe nada hoy. Se mantiene el camino reversible que eligió
  `docs/ARQUITECTURA.md` (motor durable en el lugar) y la decisión del dueño de no usar planes
  pagos.
- La decisión se apoya en una medición y no en una suposición. Los supuestos de este ADR
  quedan escritos y se pueden corregir uno por uno.
- Los escalones más baratos (Neon Launch, Vercel Pro) no necesitan cambiar el código.

### Malas

- Con aseguradoras que pagan, los términos de Hobby se incumplen. Es un riesgo que el dueño
  ya conoce y aceptó (`docs/PROMOCION.md:809-810`); este ADR no lo levanta.
- Si el volumen de casos se parece a mi supuesto, el almacenamiento y las cuotas de Hobby se
  acaban en semanas, y lo que se corta es el servicio entero hasta que pase el período o se
  cambie de plan, no una parte lenta.
- Sin dominio propio, cualquier mudanza futura es más cara de lo necesario. Poner el dominio es el
  paso previo que no cuesta una mudanza y la abarata.

## Limitations

- Los costos mensuales son estimaciones con supuestos míos de usuarios, pedidos, CPU por
  pedido, casos por mes y bytes por caso. La prueba de 700 usuarios es lo que los reemplaza
  por datos. En los extremos de sensibilidad (mitad y doble de uso) el total de Vercel y Neon
  va de US$ 75 a US$ 195.
- Faltan precios que no aparecieron en las fuentes: Multi-AZ, gp3, respaldos y proxy de RDS;
  balanceador, NAT, CloudWatch y scheduler de AWS; tarifa de Cloud Run en nivel 2 (São Paulo)
  y precio del scheduler de Google; tarifas de Fargate en São Paulo; el límite de tiempo y las
  cuotas de Amplify; planes empresariales de Vercel y Neon. Ninguno de estos números está
  incluido en las sumas.
- Las tarifas de AWS y Google son de Virginia e Iowa. São Paulo suele costar más, pero no
  lo verifiqué.
- No medí el consumo actual de CU-hora de Neon ni de Active CPU de Vercel. Tampoco medí
  las conexiones.
- No investigué si el Workflow DevKit corre fuera de Vercel, ni cómo se arma el WIF desde AWS.
- Este ADR no cubre el costo de Gemini por Vertex, que es igual en todas las opciones.

## Datos externos y fuentes

Todas las consultas son del 2026-10-21. «Oficial» quiere decir la página del proveedor;
«extracto» es lo que devolvió una búsqueda o una lectura de esa página cuando las tablas no
cargaron; «tercero» no es el proveedor. Dos lecturas de `cloud.google.com/run/pricing` y de
`cloud.google.com/sql/pricing` devolvieron sólo el título; descarté lo que el extractor
completó de memoria y me quedé con los extractos de búsqueda.

### Vercel

| Dato | Valor | Fuente (consultada 2026-10-21) | Tipo |
|---|---|---|---|
| Pro: cuota de plataforma | US$ 20 al mes, 1 asiento que despliega incluido, US$ 20 de crédito mensual | https://vercel.com/docs/plans/pro-plan | oficial |
| Pro: asientos extra | US$ 20 al mes cada uno. Una búsqueda mostró fuentes de terceros que dicen «US$ 20 por asiento»; la página oficial dice que uno está incluido | https://vercel.com/docs/plans/pro-plan | oficial |
| Hobby: uso comercial | Sólo no comercial y personal | https://vercel.com/docs/plans/hobby | oficial |
| Hobby: cuotas incluidas | 4 h de CPU activa, 360 GB-h de memoria, 1 M de invocaciones; al pasarse hay que esperar 30 días en la mayoría de los casos | https://vercel.com/docs/functions/usage-and-pricing y https://vercel.com/docs/plans/hobby | oficial |
| `gru1` (São Paulo) | CPU activa US$ 0.221 por hora; memoria US$ 0.0183 por GB-hora | https://vercel.com/docs/functions/usage-and-pricing | oficial |
| Invocaciones en Pro | US$ 0.60 por millón | https://vercel.com/docs/functions/usage-and-pricing | oficial |
| Cron | Hobby: una vez por día, precisión por hora (±59 min); Pro: una por minuto. La documentación dice 100 crons por proyecto en todos los planes; `docs/PROJECT_STATUS.md` dice 2 en Hobby. Con 2 crons en uso no cambia nada | https://vercel.com/docs/cron-jobs/usage-and-pricing | oficial |
| Límites de Hobby | 100 deploys por día; 100 builds por hora; 1 deploy concurrente; funciones de 300 s como máximo | https://vercel.com/docs/limits | oficial |
| Límites de Pro | Funciones de 300 s por defecto y 800 s como máximo (hasta 1.800 s en beta) | https://vercel.com/docs/limits | oficial |
| Workflow | Hobby: 50.000 eventos al mes y 1 GB escrito; Pro: US$ 0.02 por mil eventos y US$ 0.50 por GB escrito | https://vercel.com/docs/workflows/pricing | oficial |
| Región `gru1` | Mapeada a AWS `sa-east-1`. No apareció una afirmación oficial de que las funciones sean AWS Lambda | https://vercel.com/docs/regions | extracto |

### Neon

| Dato | Valor | Fuente (consultada 2026-10-21) | Tipo |
|---|---|---|---|
| Free | 100 CU-hora por proyecto; 1 GB por proyecto y 20 GB entre proyectos (el repo usa 500 MB); hasta 2 CU | https://neon.com/docs/introduction/plans y https://neon.com/pricing | oficial |
| Launch | US$ 0.106 por CU-hora; US$ 0.35 por GB-mes; sin mínimo mensual; hasta 16 CU; restauración puntual de hasta 7 días | https://neon.com/docs/introduction/plans y https://neon.com/pricing | oficial |
| Scale | US$ 0.222 por CU-hora según la documentación; el blog de precios da US$ 0.26 y no pude resolver cuál rige; hasta 30 días de restauración | https://neon.com/docs/introduction/plans y https://neon.com/blog/new-usage-based-pricing | oficial / extracto |
| `max_connections` | 104 a 0,25 CU; 209 a 0,5 CU; 419 a 1 CU; 839 a 2 CU; 1.678 a 4 CU; 3.357 a 8 CU; 4.000 de 9 a 56 CU. PgBouncer: `default_pool_size` 0,9 × `max_connections`, `max_client_conn` 10.000 | https://neon.com/docs/connect/connection-pooling | oficial |
| Escala a cero | A los 5 minutos de inactividad por defecto; la página no distingue por plan | https://neon.com/docs/manage/endpoints | oficial |
| Región | São Paulo es `aws-sa-east-1`; el proyecto no puede cambiar de región; las regiones de Azure están en desuso | https://neon.com/docs/introduction/regions y https://neon.com/faqs/change-project-region | extracto |

### AWS

| Dato | Valor | Fuente (consultada 2026-10-21) | Tipo |
|---|---|---|---|
| Fargate Linux/ARM, Virginia | US$ 0.0000089944 por vCPU-segundo (US$ 0.03238 por hora) y US$ 0.0000009889 por GB-segundo (US$ 0.00356 por hora); 20 GB efímeros incluidos. Salen de un ejemplo de la página porque la tabla no cargó | https://aws.amazon.com/fargate/pricing/ | extracto |
| Aurora Serverless | US$ 0.12 por ACU-hora (Standard) y US$ 0.156 (I/O-Optimized); almacenamiento US$ 0.10 por GB-mes; US$ 0.20 por millón de pedidos de I/O. Virginia, de los ejemplos de la página; capacidad mínima inconsistente (0 o 0,5 ACU) | https://aws.amazon.com/rds/aurora/pricing/ | extracto |
| RDS `db.t4g.medium` | 2 vCPU, 4 GiB, unos US$ 47 al mes de una sola zona en Virginia, sólo la instancia | https://www.bytebase.com/dbcost/rds/instance/db.t4g.medium/ | tercero |
| RDS: Multi-AZ, gp3, respaldos | No aparecieron. Ejemplo de AWS con volumen io1: US$ 856 en Multi-AZ contra US$ 428 en una zona | https://aws.amazon.com/rds/postgresql/pricing/ | extracto |
| Amplify Hosting | US$ 0.01 por minuto de build (estándar); US$ 0.15 por GB servido; US$ 0.30 por millón de pedidos SSR; US$ 0.20 por GB-hora de SSR; US$ 0.023 por GB-mes. Sin región indicada | https://aws.amazon.com/amplify/pricing/ | extracto |
| Amplify y Next.js | SSR administrado para Next.js 12 a 15; la 16 no figura; no apareció límite de tiempo ni cuotas | https://docs.aws.amazon.com/amplify/latest/userguide/ssr-amplify-support.html | extracto |

### Google Cloud

| Dato | Valor | Fuente (consultada 2026-10-21) | Tipo |
|---|---|---|---|
| Cloud Run, cobro por pedido, Iowa | US$ 0.000024 por vCPU-segundo; US$ 0.0000025 por GiB-segundo; US$ 0.40 por millón de pedidos; cupo gratuito de 180.000 vCPU-segundos, 360.000 GiB-segundos y 2 M de pedidos | https://cloud.google.com/run/pricing | extracto |
| Cloud Run en São Paulo | Figura como nivel 2 de precios; la tarifa no apareció | https://cloud.google.com/run/pricing y https://docs.cloud.google.com/run/docs/locations | extracto |
| Cloud Run: tiempo y concurrencia | Máximo 60 minutos por pedido (300 s por defecto); concurrencia 80 por defecto, hasta 1.000 | https://docs.cloud.google.com/run/quotas y https://docs.cloud.google.com/run/docs/configuring/concurrency | extracto |
| Cloud SQL Enterprise, Iowa | US$ 0.0413 por vCPU-hora y US$ 0.007 por GiB-hora; alta disponibilidad US$ 0.0826 y US$ 0.014; SSD US$ 0.17 por GB-mes. Página con unos 629 días de antigüedad en el índice | https://cloud.google.com/sql/pricing | extracto |

### Cuentas propias

Las cuentas de la sección «Opciones» las hice con los precios de las tablas de arriba y los
supuestos de «Carga esperada». Una cuenta se rehace cambiando el supuesto; por ejemplo, el
uso de Vercel es proporcional a los pedidos por mes y la memoria a las horas hábiles.
