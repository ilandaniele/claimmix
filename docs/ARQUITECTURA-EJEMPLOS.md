# Cómo se ve el refactor — cuatro ejemplos

> El «qué» y el «por qué» están en [ARQUITECTURA.md](./ARQUITECTURA.md). Esto es
> el «cómo se ve», con código real de este repo. Nada de acá es inventado: el
> lado *antes* sale del código que corre hoy en producción.

---

## La forma, en diez líneas

```
src/core/       decisiones puras. Cero imports de db, red, env o reloj.
                Se prueban con datos planos. Sin un solo mock.

src/data/       la ÚNICA puerta a la base. El único lugar con SQL.
                Sin contexto de tenant, no devuelve nada.

src/features/   una carpeta por funcionalidad: su ruta, su pantalla,
                sus tests. Llama a core y a data.

src/adapters/   Gmail, WhatsApp, Vertex, Neon. Lo que falla solo.
                Cinco bordes, no cincuenta.

src/workflows/  la cañería, en pasos durables.
```

Regla que ordena todo: **`core` no sabe que existe internet. `data` no sabe qué
es un siniestro. `features` sabe las dos cosas y no sabe SQL.**

---

## Ejemplo 1 — La tenencia deja de ser memoria

### Antes · `src/app/api/cases/route.ts`

```ts
/**
 * AC9:  Tenant-isolated by explicit tenant_id filter (RLS is gone).
 */
// ── 4. Fetch data (explicit tenant_id filter — RLS is gone) ──────────
const result = await listCases(userRow.tenant_id, parsed.data);
```

El comentario dice la verdad y es lo preocupante: **el filtro es la única
defensa, y hay que acordarse 198 veces.** Si alguien escribe la ruta 199 sin él,
compila, pasa los tests, pasa el pen test — y muestra siniestros de otra
aseguradora.

### Después

```ts
// La sesión produce un contexto. Sin contexto, no hay datos.
const ctx = await requireTenant();              // falla si no hay sesión
const cases = await data(ctx).cases.list(parsed.data);
```

Y adentro de la capa de datos, el único lugar del sistema con SQL sobre `cases`:

```ts
// src/data/cases.ts
export function cases(ctx: TenantContext) {
  return {
    list: (q: Query) =>
      ctx.tx((db) =>
        // No hay eq(tenant_id) — y no es un olvido.
        // ctx.tx abre transacción con SET LOCAL claimmix.tenant_id,
        // y con FORCE RLS la base filtra sola.
        db.select().from(casesTable).where(businessFilter(q))
      ),
  };
}
```

**La diferencia que importa:** hoy escribir mal es posible y silencioso. Después,
`data()` no se puede llamar sin `ctx` —no compila— y aunque pudieras, **Postgres
devuelve cero filas en vez de las de otro**. Dos cierres independientes: uno en
tu máquina, otro en la base.

---

## Ejemplo 2 — Una decisión de negocio sale de la infraestructura

Este es el mejor ejemplo porque salió mal hace dos días.

### Antes · `src/server/confirmations/orchestrate.ts:1311`

```ts
async function factsLearnedSinceWeLastSpoke(
  caseId: string,
  tenantId: string
): Promise<boolean> {
  const spoke = firstRow(
    await db
      .select({ created_at: outboundMessages.created_at })
      .from(outboundMessages)
      .where(and(
        eq(outboundMessages.case_id, caseId),
        eq(outboundMessages.tenant_id, tenantId),
        inArray(outboundMessages.status, ["sent", "skipped_simulated"])
      ))
      .orderBy(desc(outboundMessages.created_at))
      .limit(1)
  );
  // ...y sigue, mezclando la pregunta con cómo se consultan las tablas
}
```

La pregunta es de negocio: *¿aprendimos algo nuevo desde la última vez que le
escribimos?* Pero sólo se puede responder con la base prendida. Para probarla,
hay que simular Drizzle.

**Y esta función exacta salió mal:** acusaba recibo ante un simple «ok», porque
la extracción relee toda la conversación y «aparecieron campos nuevos» daba
verdadero siempre. Lo agarró el ensayo con el agente real, **no un test** —
porque no había test posible sin montar media aplicación.

### Después · la decisión, sola

```ts
// src/core/case/acknowledge.ts — cero imports de infraestructura
export function learnedSomethingNew(
  lastSpokeAt: Date | null,
  fields: ReadonlyArray<{ name: string; confirmedAt: Date }>
): boolean {
  if (lastSpokeAt === null) return fields.length > 0;
  return fields.some((f) => f.confirmedAt > lastSpokeAt);
}
```

El test del bug que se nos escapó, sin un solo mock:

```ts
it("un 'ok' no cuenta como dato nuevo", () => {
  expect(learnedSomethingNew(ayer, [
    { name: "patente", confirmedAt: anteayer },   // ya lo sabíamos
  ])).toBe(false);
});
```

Y la infraestructura queda de tres renglones, en `features/`:

```ts
const isNew = learnedSomethingNew(
  await data(ctx).messages.lastOutboundAt(caseId),
  await data(ctx).fields.confirmed(caseId)
);
```

**La diferencia que importa:** el error de hace dos días habría sido un test de
cuatro líneas, escrito antes de desplegar, en vez de un ensayo contra el agente
real después.

---

## Ejemplo 3 — La cañería deja de perder casos

### Antes · `src/app/api/admin/batch-simulate/route.ts`

```ts
if (!fitsAnotherCase(Date.now() - startedAt, processed, BATCH_BUDGET_MS)) break;
// ...
if (input.chain >= MAX_CHAIN) {
  console.log({ msg: "batch_simulate.chain_exhausted" });   // ← se rinde
}
// ...y si no, se llama a sí misma por HTTP para seguir
await fetch(`${getWorkerBaseUrl()}/api/...`, { headers: internalAuthHeaders() });
```

Traducido: *«adiviná si entra otro caso antes de que me maten a los 60 segundos;
si no entra, llamate a vos mismo por HTTP; si ya te llamaste seis veces,
rendite y anotá `chain_exhausted`»*. Más un cron `reap-stuck` que después pasa a
juntar lo que quedó tirado.

### Después · `src/workflows/process-claim.ts`

```ts
export const processClaim = workflow("case.received", async (step, { caseId }) => {
  const extracted = await step.run("extraer",   () => extract(caseId));
  const gaps      = await step.run("faltantes", () => analyzeGaps(extracted));

  if (gaps.length > 0) {
    await step.run("preguntar", () => ask(caseId, gaps));
    await step.waitFor("respuesta", { timeout: "7d" });   // esperar una semana
  }

  await step.run("cerrar", () => close(caseId));
});
```

Cada `step.run` se persiste. Si el proceso muere en el paso 3, **retoma en el
paso 3** — no desde cero, y no se pierde. `waitFor` con siete días de espera es
imposible hoy y trivial acá.

Se van, todos juntos: `MAX_CHAIN`, `BATCH_BUDGET_MS`, `fitsAnotherCase`, la
auto-invocación por HTTP, los leases hechos a mano, `chain_exhausted` y el cron
`reap-stuck`.

**La diferencia que importa:** «los batches grandes pierden casos» deja de ser un
bug a parchar y pasa a ser un estado imposible.

---

## Ejemplo 4 — Los tests dejan de probar los mocks

### Antes · `tests/unit/extractor-ac6-happy-path.test.ts`

```ts
vi.mock("@/lib/db", ...);
vi.mock("@/lib/db/helpers", ...);
vi.mock("@/server/email/dispatch", ...);
vi.mock("@/lib/audit/log", ...);
vi.mock("@/server/cases/gap-analyzer", ...);
vi.mock("@/server/ai/budget", ...);
vi.mock("@/server/matching/customer-matcher", ...);
// ...y 19 más. Veintiséis en total, en un archivo.
```

Con veintiséis simulaciones, lo que el test verifica es **que los mocks se
llaman en orden** — no que la decisión sea correcta. Si el diseño está mal, el
test lo bendice.

### Después

| Capa | Cómo se prueba | Mocks |
|---|---|---|
| `core/` | datos planos, entrada y salida | **0** |
| `data/` | contra una rama de Neon de verdad | 0 |
| `adapters/` | contrato: ¿Gmail contesta lo que creemos? | pocos |
| `workflows/` | punta a punta, con el motor en modo prueba | 0 |

**Meta declarada: bajar de 349 mocks a menos de 100 en todo el repo.** Es la
medida de avance de la Fase 2 — mejor que «líneas movidas», porque no se puede
falsear.

---

## Las fases

| | Qué | Cuánto | Termina cuando |
|---|---|---|---|
| **0-A** | Probar `FORCE RLS` + rol no-dueño contra una rama de Neon | 2-3 d | una consulta sin contexto devuelve cero filas |
| **0-B** | Un flujo real migrado a pasos durables | 3-4 d | sobrevive el timeout que hoy pierde casos |
| **1** | `src/data/` — la puerta única | 1 sem | ninguna ruta ni página tiene SQL |
| **2** | `src/core/` — sacar las decisiones | 1½ sem | menos de 100 mocks |
| **3** | `src/features/` — rebanadas | 1 sem | cada funcionalidad en su carpeta |
| **4** | La cañería a workflows | 2-3 sem | se borran `MAX_CHAIN` y `reap-stuck` |
| **5** | Errores tipados + WIF | 1-2 sem | no queda clave de servicio en disco |
| **6** | Pruebas: unitarias, punta a punta, carga con k6 | 2 sem | el portón de CI corre carga |
| **7** | `security-review` + tenencia cruzada real | 1 sem | dos tenants, filtro sacado a propósito, la base lo rechaza |

Cada fase termina con producción andando y `pnpm check` en verde. **Las dos Fase
0 van primero y pueden refutar el plan** — que es para lo que están.

---

## Qué cambia para vos, en el día a día

**Agregar una pantalla que lista algo:** hoy escribís la consulta y te acordás
del filtro de tenant. Después pedís `data(ctx)` y el filtro no es asunto tuyo.

**Cambiar cómo decide el agente:** hoy abrís `orchestrate.ts` (1.424 líneas) y
buscás. Después abrís un archivo en `core/` de treinta líneas, lo cambiás, y el
test corre en milisegundos sin red.

**Cuando algo falla en producción:** hoy mirás logs y adivinás en qué eslabón se
cortó. Después el motor te muestra el flujo detenido, en qué paso, con qué
error, y lo reintentás desde ahí.

**Cuando entra un cliente nuevo:** hoy confiás en que las 198 consultas están
bien escritas. Después la base no le da a nadie lo que no es suyo, aunque el
código se equivoque.
