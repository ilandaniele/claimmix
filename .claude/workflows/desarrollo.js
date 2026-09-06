// Un cambio en ClaimMix de punta a punta, repartido entre agentes.
//
//   Workflow({ name: "desarrollo", args: "la tarea en una frase" })
//   Workflow({ name: "desarrollo", args: { tarea, modo: "plan" } })   // se detiene después de diseñar
//   Workflow({ name: "desarrollo", args: { tarea, rondas: 3, rama } })
//
// Quién hace qué: un explorador ubica el terreno y lectores en paralelo lo
// mapean; tres diseñadores proponen desde lentes distintos, dos jueces puntúan
// y uno sintetiza; UN solo implementador toca código; cinco revisores buscan
// problemas y cada hallazgo lo intentan refutar tres adversarios antes de que
// alguien lo corrija; un comprobador corre `pnpm check --local` y LEE el
// transcripto del ensayo; el último abre el PR. Nadie mergea.

export const meta = {
  name: 'desarrollo',
  description: 'Entender, diseñar, implementar, revisar con adversarios, comprobar y abrir el PR de un cambio en ClaimMix',
  whenToUse: 'Una tarea concreta de desarrollo en este repo: bug, feature o refactor. args: la tarea en una frase, o { tarea, modo: "plan" | "completo", rondas, rama }.',
  phases: [
    { title: 'Entender', detail: 'un explorador ubica el terreno; lectores en paralelo lo mapean' },
    { title: 'Diseñar', detail: 'tres enfoques, dos jueces, una síntesis' },
    { title: 'Implementar', detail: 'un solo implementador, en rama, con tests' },
    { title: 'Revisar', detail: 'cinco lentes; cada hallazgo lo intentan refutar tres' },
    { title: 'Comprobar', detail: 'pnpm check --local, y alguien lee el transcripto' },
    { title: 'Entregar', detail: 'commit, push y PR; no mergea' },
  ],
}

const entrada = typeof args === 'string' ? { tarea: args } : (args ?? {})
const tarea = entrada.tarea
if (!tarea) throw new Error('Falta la tarea: args: "…" o args: { tarea: "…" }')
const modo = entrada.modo ?? 'completo'
const RONDAS = entrada.rondas ?? 2
const rama = entrada.rama ?? 'wf/' + tarea.toLowerCase().normalize('NFD').replace(/[\u0300-\u036f]/g, '')
  .replace(/[^a-z0-9]+/g, '-').slice(0, 40).replace(/^-|-$/g, '')

const REGLAS = `

Reglas de la casa (no negociables):
- ClaimMix: Next.js 16 App Router con RSC, Drizzle sobre Neon serverless, Gemini por Vertex. Este Next NO es el que conocés: antes de tocar algo de Next leé la guía en node_modules/next/dist/docs/ y respetá los avisos de deprecación.
- Registro: cortante. DRY, KISS, cambios quirúrgicos. Comentarios sólo cuando cuentan un porqué que el código no dice, en castellano rioplatense como el resto del repo. Una consulta por endpoint; nada de idas y vueltas extra a la base.
- i18n: es-AR y en-US se tocan juntos (src/lib/i18n).
- main está protegida: se trabaja en rama y se abre PR. Nunca push a main, nunca mergear.
- Nunca sembrar datos ni escribir tests contra la base de producción por fuera de las herramientas del repo (pnpm check / pnpm rehearse, que limpian lo suyo). No tocar secretos ni tokens, no rotar nada, no cambiar planes ni configuración de servicios. No imprimir secretos.
- Leé docs/PROJECT_STATUS.md y docs/TESTING.md antes de decidir: ahí están las decisiones ya tomadas y sus porqués.
- Tu texto final es un dato que consume un script, no un mensaje para una persona.`

const TERRENO = {
  type: 'object',
  properties: {
    zonas: { type: 'array', items: { type: 'object', properties: {
      nombre: { type: 'string' }, archivos: { type: 'array', items: { type: 'string' } }, pregunta: { type: 'string' },
    }, required: ['nombre', 'archivos', 'pregunta'] } },
    invariantes: { type: 'array', items: { type: 'string' } },
    tests_existentes: { type: 'array', items: { type: 'string' } },
  },
  required: ['zonas', 'invariantes', 'tests_existentes'],
}
const MAPA = {
  type: 'object',
  properties: {
    zona: { type: 'string' }, como_funciona: { type: 'string' }, donde_se_enchufa: { type: 'string' },
    que_se_rompe: { type: 'array', items: { type: 'string' } }, tests: { type: 'array', items: { type: 'string' } },
  },
  required: ['zona', 'como_funciona', 'donde_se_enchufa', 'que_se_rompe', 'tests'],
}
const DISENO = {
  type: 'object',
  properties: {
    clave: { type: 'string' }, resumen: { type: 'string' },
    archivos: { type: 'array', items: { type: 'string' } }, pasos: { type: 'array', items: { type: 'string' } },
    tests: { type: 'array', items: { type: 'string' } }, riesgos: { type: 'array', items: { type: 'string' } },
  },
  required: ['clave', 'resumen', 'archivos', 'pasos', 'tests', 'riesgos'],
}
const VEREDICTO = {
  type: 'object',
  properties: {
    puntajes: { type: 'array', items: { type: 'object', properties: {
      clave: { type: 'string' }, puntaje: { type: 'number' }, por_que: { type: 'string' },
    }, required: ['clave', 'puntaje', 'por_que'] } },
    mejor: { type: 'string' },
    injertos: { type: 'array', items: { type: 'string' } },
  },
  required: ['puntajes', 'mejor', 'injertos'],
}
const PLAN = {
  type: 'object',
  properties: {
    resumen: { type: 'string' }, archivos: { type: 'array', items: { type: 'string' } },
    pasos: { type: 'array', items: { type: 'string' } }, tests: { type: 'array', items: { type: 'string' } },
    riesgos: { type: 'array', items: { type: 'string' } }, no_hacer: { type: 'array', items: { type: 'string' } },
  },
  required: ['resumen', 'archivos', 'pasos', 'tests', 'riesgos', 'no_hacer'],
}
const IMPL = {
  type: 'object',
  properties: {
    archivos_tocados: { type: 'array', items: { type: 'string' } }, tests_agregados: { type: 'array', items: { type: 'string' } },
    como_se_probo: { type: 'string' }, dudas: { type: 'array', items: { type: 'string' } },
  },
  required: ['archivos_tocados', 'tests_agregados', 'como_se_probo', 'dudas'],
}
const HALLAZGOS = {
  type: 'object',
  properties: { hallazgos: { type: 'array', items: { type: 'object', properties: {
    titulo: { type: 'string' }, archivo: { type: 'string' }, linea: { type: 'number' },
    por_que: { type: 'string' }, gravedad: { type: 'string', enum: ['alta', 'media', 'baja'] },
  }, required: ['titulo', 'archivo', 'por_que', 'gravedad'] } } },
  required: ['hallazgos'],
}
const REFUTACION = {
  type: 'object',
  properties: { refutado: { type: 'boolean' }, por_que: { type: 'string' } },
  required: ['refutado', 'por_que'],
}
const COMPROBACION = {
  type: 'object',
  properties: {
    capas: { type: 'array', items: { type: 'object', properties: {
      nombre: { type: 'string' }, ok: { type: 'boolean' }, detalle: { type: 'string' },
    }, required: ['nombre', 'ok', 'detalle'] } },
    transcripto_suena_bien: { type: 'boolean' },
    observaciones: { type: 'array', items: { type: 'string' } },
  },
  required: ['capas', 'transcripto_suena_bien', 'observaciones'],
}
const ENTREGA = {
  type: 'object',
  properties: { commit: { type: 'string' }, pr_url: { type: 'string' }, resumen: { type: 'string' } },
  required: ['commit', 'pr_url', 'resumen'],
}

// ── Entender ────────────────────────────────────────────────────────────
phase('Entender')
const terreno = await agent(
  `Tarea: ${tarea}

Ubicá el terreno sin cambiar nada. Qué archivos, módulos, tests y docs importan para esta tarea, y qué invariantes del repo la rozan (docs/PROJECT_STATUS.md, docs/TESTING.md, AGENTS.md, tests/arquitectura si existe). Dividí el terreno en 2 a 4 zonas que se puedan leer por separado, cada una con la pregunta que un lector tiene que contestar.${REGLAS}`,
  { label: 'explorar', schema: TERRENO },
)
if (!terreno) throw new Error('El explorador no devolvió terreno')
log(`Terreno: ${terreno.zonas.map((z) => z.nombre).join(' · ')}`)

// Barrera a propósito: diseñar necesita TODOS los mapas juntos.
const mapas = (await parallel(terreno.zonas.map((z) => () => agent(
  `Tarea global: ${tarea}

Leé a fondo la zona «${z.nombre}»: ${z.archivos.join(', ')}. Pregunta a contestar: ${z.pregunta}
Invariantes conocidas: ${terreno.invariantes.join(' | ') || 'ninguna'}.
No cambies nada. Devolvé cómo funciona hoy, dónde se enchufa el cambio, qué se rompe si se toca mal y qué tests lo cubren.${REGLAS}`,
  { label: `leer:${z.nombre}`, phase: 'Entender', schema: MAPA },
)))).filter(Boolean)

// ── Diseñar ─────────────────────────────────────────────────────────────
phase('Diseñar')
const contexto = `Tarea: ${tarea}
Mapas del terreno: ${JSON.stringify(mapas)}
Tests existentes: ${terreno.tests_existentes.join(', ') || 'ninguno'}`

const ENFOQUES = [
  { clave: 'minimo', lente: 'el cambio más chico que resuelve la tarea de verdad, sin deuda escondida' },
  { clave: 'sano', lente: 'el que deja el código más sano: menos estado, menos casos borde, tests que prueban el comportamiento y no la implementación' },
  { clave: 'datos', lente: 'el que cuida la base y el rendimiento: una consulta por endpoint, nada de ida y vuelta extra, nada de bundle de más, RSC donde corresponde' },
]
const propuestas = (await parallel(ENFOQUES.map((e) => () => agent(
  `${contexto}

Proponé un diseño desde este lente: ${e.lente}. Podés leer el repo; no cambies nada. clave = "${e.clave}". Archivos a tocar, pasos concretos, tests a agregar, riesgos.${REGLAS}`,
  { label: `diseño:${e.clave}`, phase: 'Diseñar', schema: DISENO },
)))).filter(Boolean)
if (propuestas.length === 0) throw new Error('Ningún diseñador devolvió una propuesta')

const veredictos = (await parallel([0, 1].map((i) => () => agent(
  `${contexto}

Propuestas: ${JSON.stringify(propuestas)}

Sos el juez ${i + 1} de 2. Puntuá cada propuesta de 0 a 10 por: resuelve la tarea, riesgo de regresión, tamaño del cambio, respeto a las reglas de la casa, calidad de los tests. Elegí la mejor y anotá qué ideas de las otras vale la pena injertarle. Juzgá con el código a la vista, no de memoria.${REGLAS}`,
  { label: `juez:${i + 1}`, phase: 'Diseñar', schema: VEREDICTO, effort: 'high' },
)))).filter(Boolean)

const plan = await agent(
  `${contexto}

Propuestas: ${JSON.stringify(propuestas)}
Veredictos de los jueces: ${JSON.stringify(veredictos)}

Sintetizá UN plan: partí de la propuesta mejor puntuada e injertale lo que los jueces rescataron de las otras. Pasos concretos y en orden, tests a agregar (nombre y qué afirman), riesgos, y una lista explícita de lo que NO se hace en este cambio.${REGLAS}`,
  { label: 'síntesis', phase: 'Diseñar', schema: PLAN },
)
if (!plan) throw new Error('No hubo síntesis del plan')
log(`Plan: ${plan.resumen}`)

if (modo === 'plan') return { tarea, terreno, mapas, propuestas, veredictos, plan }

// ── Implementar ─────────────────────────────────────────────────────────
phase('Implementar')
const impl = await agent(
  `Tarea: ${tarea}
Plan acordado: ${JSON.stringify(plan)}
Mapas del terreno: ${JSON.stringify(mapas)}

Sos el ÚNICO que toca código. Creá la rama "${rama}" desde main actualizada (git fetch, git checkout -b) y seguí el plan paso a paso. Escribí los tests del plan; cuando la tarea es un bug tienen que fallar antes del arreglo y pasar después. Corré los tests que tocaste, "pnpm tsc --noEmit" y eslint sobre los archivos tocados hasta que todo quede limpio. No hagas commit todavía. Si algo del plan no cierra con lo que ves en el código, resolvelo con el criterio de las reglas y anotalo en dudas.${REGLAS}`,
  { label: 'implementar', schema: IMPL },
)
if (!impl) throw new Error('El implementador no devolvió nada')
log(`Tocados: ${impl.archivos_tocados.join(', ')}`)

// ── Revisar ─────────────────────────────────────────────────────────────
const LENTES = [
  { clave: 'correccion', lente: 'bugs de lógica, casos borde, estado que se olvida o sobrevive de más, condiciones de carrera, errores tragados' },
  { clave: 'seguridad', lente: 'aislamiento entre inquilinos y RLS, autenticación y autorización, inyección, secretos o datos personales en logs, superficie nueva sin proteger' },
  { clave: 'regresion', lente: 'qué comportamiento existente cambia sin querer, qué test faltó, qué camino nadie probó (los dos canales: WhatsApp y mail; los dos idiomas)' },
  { clave: 'registro', lente: 'las reglas de la casa: cambio quirúrgico, DRY/KISS, comentarios sólo con porqué, i18n en los dos idiomas, una consulta por endpoint, nada de db.$count' },
  { clave: 'next', lente: 'uso correcto de Next.js 16 según node_modules/next/dist/docs: RSC vs cliente, server actions, caché, after(), rutas; deprecaciones' },
]
const clave = (h) => `${h.archivo}::${h.titulo.toLowerCase().replace(/[^a-z0-9áéíóúñ]+/g, ' ').trim()}`

// Quien revisa mira el ÁRBOL DE TRABAJO, no `main...HEAD`.
//
// El commit es el último paso del proceso, así que hasta ahí `git diff
// main...HEAD` está vacío: quien mire ahí revisa la nada y devuelve una lista
// limpia que no significa nada. Un archivo nuevo tampoco sale en `git diff` a
// secas, y sin decirlo el revisor lo reporta como si fuera el defecto.
const DONDE_MIRAR = 'Los cambios están SIN commitear en el árbol de trabajo, a propósito: el commit lo hace el último paso del proceso. Así que "git diff main...HEAD" está VACÍO y no te sirve, y «no está commiteado» o «archivo sin trackear» no es un hallazgo. Mirá "git status --short" y "git diff", y leé entero cada archivo que ahí figure como nuevo.'
const vistos = new Set()
const confirmados = []

for (let ronda = 1; ronda <= RONDAS; ronda++) {
  phase('Revisar')
  // Barrera a propósito: hay que deduplicar entre lentes antes de pagar tres refutadores por hallazgo.
  const encontrados = (await parallel(LENTES.map((l) => () => agent(
    `Tarea: ${tarea}
Plan: ${plan.resumen}
Rama: ${rama}. ${DONDE_MIRAR}

Ronda ${ronda} de revisión.${ronda > 1 ? ' Ya hubo una ronda antes y lo que encontró se corrigió: el árbol cambió, miralo de nuevo. Los de antes no hace falta repetirlos.' : ''}

Revisá SOLO desde este lente: ${l.lente}. No cambies nada. Cada hallazgo con archivo, línea, por qué es un problema de verdad (no una preferencia) y gravedad. Si no hay nada, devolvé la lista vacía: un hallazgo inventado cuesta tres verificaciones.${REGLAS}`,
    { label: `revisar:${l.clave}:ronda${ronda}`, phase: 'Revisar', schema: HALLAZGOS },
  )))).filter(Boolean).flatMap((r) => r.hallazgos)

  const nuevos = encontrados.filter((h) => !vistos.has(clave(h)))
  nuevos.forEach((h) => vistos.add(clave(h)))
  log(`Ronda ${ronda}: ${encontrados.length} hallazgo(s), ${nuevos.length} nuevo(s)`)
  if (nuevos.length === 0) break

  const juzgados = await parallel(nuevos.map((h) => () =>
    parallel([0, 1, 2].map((i) => () => agent(
      `Rama: ${rama}. ${DONDE_MIRAR}

Hallazgo de una revisión: ${JSON.stringify(h)}

Sos el refutador ${i + 1} de 3. Tu trabajo es DEMOSTRAR que el hallazgo está mal, no aplica, o no tiene impacto real, leyendo el código. Si no lo podés refutar con evidencia concreta, refutado=false. Ante la duda, refutado=true.${REGLAS}`,
      { label: `refutar:${h.titulo.slice(0, 30)}`, phase: 'Revisar', schema: REFUTACION, effort: 'high' },
    ))).then((votos) => ({ h, sobrevive: votos.filter(Boolean).filter((v) => !v.refutado).length >= 2 })),
  ))
  const sobrevivientes = juzgados.filter(Boolean).filter((j) => j.sobrevive).map((j) => j.h)
  confirmados.push(...sobrevivientes)
  log(`Ronda ${ronda}: ${sobrevivientes.length} confirmado(s) tras la refutación`)
  if (sobrevivientes.length === 0) break

  await agent(
    `Tarea: ${tarea}
Rama: ${rama}. Hallazgos confirmados por revisión y refutación: ${JSON.stringify(sobrevivientes)}

Sos el único que toca código. Corregí cada uno con el cambio más chico que lo resuelve de verdad, agregá o ajustá el test que lo hubiera atrapado, y dejá tests, "pnpm tsc --noEmit" y eslint limpios. No hagas commit.${REGLAS}`,
    { label: `corregir:ronda${ronda}`, phase: 'Revisar', schema: IMPL },
  )
}

// ── Comprobar ───────────────────────────────────────────────────────────
phase('Comprobar')
const PEDIDO_CHECK = `Rama: ${rama}. Corré "pnpm check --local" (tarda unos quince minutos: lanzalo en segundo plano y esperá a que termine; no lo cortes). Es la herramienta del repo y limpia lo suyo. Informá capa por capa. Si falla el ensayo en UN escenario, corré ese escenario solo con "pnpm rehearse <nombre>": una regresión aparece las dos veces, una variación casi nunca. Si el proceso muere con un código raro (por ejemplo 3221226505) es el runtime, no el código: reintentá una vez. Y LEÉ el transcripto del ensayo entero: media respuesta puede pasar todas las verificaciones y sonar mal, y eso sólo lo nota alguien que lee. transcripto_suena_bien=false si alguna respuesta del agente suena repetida, fría, incoherente con lo que el denunciante dijo, o pide algo que ya le dieron.${REGLAS}`
let comprobacion = await agent(PEDIDO_CHECK, { label: 'check', schema: COMPROBACION })
if (comprobacion && (comprobacion.capas.some((c) => !c.ok) || !comprobacion.transcripto_suena_bien)) {
  log('El check no quedó verde: una ronda de corrección y se vuelve a correr')
  await agent(
    `Tarea: ${tarea}
Rama: ${rama}. Resultado del check: ${JSON.stringify(comprobacion)}

Sos el único que toca código. Diagnosticá y corregí lo que falló (si es el transcripto, el problema está en cómo suena el agente: prompts, redactor u orquestador). Cambio mínimo, con su test cuando aplique. No hagas commit.${REGLAS}`,
    { label: 'corregir:check', phase: 'Comprobar', schema: IMPL },
  )
  comprobacion = await agent(PEDIDO_CHECK, { label: 'check:2', phase: 'Comprobar', schema: COMPROBACION })
}
const verde = !!comprobacion && comprobacion.capas.every((c) => c.ok) && comprobacion.transcripto_suena_bien

// ── Entregar ────────────────────────────────────────────────────────────
phase('Entregar')
const entrega = await agent(
  `Tarea: ${tarea}
Rama: ${rama}. Plan: ${plan.resumen}
Hallazgos confirmados y corregidos: ${JSON.stringify(confirmados)}
Comprobación: ${JSON.stringify(comprobacion)}

Hacé UN commit con todo lo de la rama (git add de los archivos tocados, nada de "git add -A" a ciegas): mensaje de una línea en castellano, presente, que diga qué cambia y por qué, como los del historial ("git log --oneline -15"), y el trailer de coautoría "Co-Authored-By: <modelo> <noreply@anthropic.com>", donde <modelo> es el nombre del modelo con el que estás corriendo VOS. No lo copies de un commit viejo ni de acá: el historial tiene que decir quién lo escribió. Pusheá la rama y abrí el PR con "gh pr create": título = la línea del commit; cuerpo con el porqué, qué se probó y qué NO se pudo probar${verde ? '' : ' (el check NO quedó verde: decilo arriba de todo)'}, y al final "🤖 Generated with [Claude Code](https://claude.com/claude-code)". NO mergees.${REGLAS}`,
  { label: 'pr', schema: ENTREGA },
)

return {
  tarea,
  rama,
  pr: entrega?.pr_url ?? null,
  commit: entrega?.commit ?? null,
  plan: plan.resumen,
  hallazgos_confirmados: confirmados,
  comprobacion,
  verde,
  pendiente: [
    ...(verde ? [] : ['el check no quedó verde: leé el PR antes de mergear']),
    'mergear el PR cuando el CI esté verde (gh pr merge --rebase --delete-branch) y mirar el post-deploy',
  ],
}
