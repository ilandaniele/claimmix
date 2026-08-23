/**
 * scripts/rehearse-onboarding.mts
 *
 * Dar de alta un cliente entero, comprobar que quedó bien, y borrarlo.
 *
 * El alta de un segundo asegurador estaba escrita —create-tenant.mjs, las
 * columnas comerciales, la resolución de clave por tenant— y nunca se había
 * ejercitado de punta a punta. "Está el código" y "funciona el alta" no son la
 * misma afirmación, y la diferencia entre las dos se descubre siempre en el
 * peor momento posible: con el primer cliente real mirando la pantalla.
 *
 * Esto lo hace sobre un tenant descartable, contra la base de verdad, y después
 * lo borra. Lo que verifica es lo que le importa a un cliente nuevo:
 *
 *   1. que el alta escriba los términos que dice el plan;
 *   2. que sus denuncias sean SUYAS — que el otro tenant no las vea por
 *      ninguna de las vías por las que se leen casos;
 *   3. que la facturación cuente las de él y las cobre con su plan;
 *   4. que una factura de un mes cerrado no se mueva cuando los casos cambian;
 *   5. que su presupuesto de IA sea propio y no herede el consumo del otro;
 *   6. que al borrarlo no quede nada suyo, y que el tenant de producción siga
 *      exactamente igual que antes.
 *
 * No llama al modelo: todo esto es tenencia y plata, no extracción. Sale gratis
 * y por eso se puede correr antes de cada cliente en vez de una vez en la vida.
 *
 * Uso:
 *   pnpm onboard            # ensaya y limpia
 *   pnpm onboard --keep     # deja el tenant creado para mirarlo por dentro
 */

import * as path from "node:path";
import * as fs from "node:fs";
import { spawnSync } from "node:child_process";
import * as dotenv from "dotenv";

const envPath = path.resolve(process.cwd(), ".env.local");
dotenv.config({ path: fs.existsSync(envPath) ? envPath : undefined });

const KEEP = process.argv.includes("--keep");
const RUN = String(Date.now()).slice(-6);
const NAME = `Ensayo de alta ${RUN}`;
const PLAN = "operativo";

/** Los términos del catálogo para `operativo`. Si el alta no los escribe, falla. */
const EXPECTED = { fee: 390, included: 750, overage: 0.45, status: "active" };

const PROD_TENANT = process.env.GMAIL_TENANT_ID;
if (!process.env.DATABASE_URL || !PROD_TENANT) {
  console.error("Faltan DATABASE_URL o GMAIL_TENANT_ID en .env.local");
  process.exit(1);
}

const failures: string[] = [];

/** Lo que esta corrida NO pudo ensayar. Se dice en voz alta al final. */
const skipped: string[] = [];

function check(label: string, ok: boolean, detail?: string): void {
  console.log(`   ${ok ? "✓" : "✗"} ${label}${detail ? ` — ${detail}` : ""}`);
  if (!ok) failures.push(`${label}${detail ? ` (${detail})` : ""}`);
}

function phase(title: string): void {
  console.log(`\n▸ ${title}\n`);
}

// Importados después de dotenv: el módulo db lee DATABASE_URL al importarse.
const { db } = await import("@/lib/db");
const { cases, tenants, billingInvoices, tenantAiSettings } = await import("@/lib/db/schema");
const { and, eq, sql } = await import("drizzle-orm");
const { listCases, listCasesForExport } = await import("@/server/cases/list");
const { getCaseDetail } = await import("@/server/cases/get");
const { getStatement } = await import("@/server/billing/statement");
const { resolveBillingPeriod } = await import("@/lib/billing/period");

console.log("═".repeat(70));
console.log("ALTA DE UN SEGUNDO CLIENTE — de punta a punta, sobre un tenant descartable");
console.log("═".repeat(70));

// ── 1. El alta, con el script de verdad ─────────────────────────────────────
//
// Se invoca create-tenant.mjs en vez de insertar el tenant acá. Un ensayo que
// escribe su propio INSERT prueba que Postgres funciona, no que el alta
// funciona: la próxima vez que alguien toque el script, esto seguiría verde.
phase("El alta corre el script real, no una copia");

const alta = spawnSync(
  process.execPath,
  [
    "scripts/create-tenant.mjs",
    "--name", NAME,
    "--plan", PLAN,
    "--contact", `alta.${RUN}@example.com`,
    "--apply",
  ],
  { encoding: "utf8" }
);

if (alta.status !== 0) {
  console.error(alta.stdout ?? "");
  console.error(alta.stderr ?? "");
  console.error("\n✖ create-tenant.mjs falló. El alta no se puede ensayar si no da de alta.");
  process.exit(1);
}

const [created] = await db
  .select({
    id: tenants.id,
    name: tenants.name,
    plan: tenants.plan,
    billing_status: tenants.billing_status,
    monthly_fee_usd: tenants.monthly_fee_usd,
    included_claims: tenants.included_claims,
    overage_price_usd: tenants.overage_price_usd,
    contact_email: tenants.contact_email,
  })
  .from(tenants)
  .where(eq(tenants.name, NAME))
  .limit(1);

if (!created) {
  console.error("✖ El script dijo que sí y el tenant no está en la base.");
  process.exit(1);
}

const TENANT = created.id;

check("el tenant existe", true, TENANT);
check("plan", created.plan === PLAN, `${created.plan}`);
check("abono mensual", Number(created.monthly_fee_usd) === EXPECTED.fee, `US$ ${created.monthly_fee_usd}`);
check("denuncias incluidas", Number(created.included_claims) === EXPECTED.included, `${created.included_claims}`);
check(
  "precio del excedente",
  Number(created.overage_price_usd) === EXPECTED.overage,
  `US$ ${created.overage_price_usd}`
);
check(
  "estado de facturación",
  created.billing_status === EXPECTED.status,
  `${created.billing_status}`
);
check("contacto de facturación", created.contact_email === `alta.${RUN}@example.com`);

// Todo lo que sigue puede fallar; el tenant se borra igual.
try {
  // ── 2. La pared ───────────────────────────────────────────────────────────
  //
  // Cada dirección se prueba dos veces: primero que el dueño SÍ lo vea. Sin
  // eso, no encontrar un caso que no existe es un verde gratis.
  phase("Sus denuncias son suyas");

  const marker = `ALTA-${RUN}`;
  const query = { page: 1, per_page: 100, sort: "created_at", order: "desc" } as const;

  const [mine] = await db
    .insert(cases)
    .values({
      tenant_id: TENANT,
      policyholder_name: marker,
      policy_number: marker,
      channel: "whatsapp_sim",
      status: "recibido",
      is_claim: true,
    })
    .returning({ id: cases.id });

  check("el dueño ve su caso por id", Boolean(await getCaseDetail(TENANT, mine!.id)));
  const ownList = await listCases(TENANT, { ...query } as never);
  check("el dueño lo ve en su listado", JSON.stringify(ownList).includes(marker));

  check(
    "producción NO lo ve por id",
    (await getCaseDetail(PROD_TENANT, mine!.id)) === null
  );
  check(
    "producción NO lo ve en el listado",
    !JSON.stringify(await listCases(PROD_TENANT, { ...query } as never)).includes(marker)
  );
  check(
    "producción NO lo encuentra buscándolo",
    !JSON.stringify(await listCases(PROD_TENANT, { ...query, q: marker } as never)).includes(marker)
  );
  check(
    "producción NO lo exporta en el CSV",
    !JSON.stringify(await listCasesForExport(PROD_TENANT, {})).includes(marker)
  );

  // ── 3. La factura del mes en curso ────────────────────────────────────────
  phase("La facturación cuenta lo suyo y lo cobra con su plan");

  const thisMonth = resolveBillingPeriod(null)!;
  const live = await getStatement(TENANT, thisMonth);

  check("hay liquidación del mes en curso", Boolean(live));
  check("cuenta exactamente su denuncia", live?.volume.billable_claims === 1, `${live?.volume.billable_claims}`);
  check(
    "el abono es el de su plan",
    live?.invoice.total_usd === EXPECTED.fee,
    `US$ ${live?.invoice.total_usd}`
  );
  check("una denuncia no genera excedente", live?.invoice.overage_claims === 0);
  check("el mes en curso NO está congelado", live?.frozen === false);

  // ── 4. El mes cerrado no se mueve ─────────────────────────────────────────
  //
  // La prueba de verdad de la migración 0017, contra Postgres y no contra un
  // mock: se factura un mes terminado, se borra el caso que lo generó, y la
  // factura tiene que seguir diciendo lo mismo. Si volviera a contar, diría
  // cero — y ese cero sería una factura ya emitida cambiando sola.
  phase("Una factura emitida no cambia porque cambien los casos");

  const past = new Date();
  past.setUTCDate(1);
  past.setUTCMonth(past.getUTCMonth() - 1);
  const lastMonth = resolveBillingPeriod(
    `${past.getUTCFullYear()}-${String(past.getUTCMonth() + 1).padStart(2, "0")}`
  )!;

  const [old] = await db
    .insert(cases)
    .values({
      tenant_id: TENANT,
      policyholder_name: `${marker}-VIEJO`,
      channel: "whatsapp_sim",
      status: "listo_para_core",
      is_claim: true,
      created_at: new Date(Date.UTC(past.getUTCFullYear(), past.getUTCMonth(), 15)).toISOString(),
    })
    .returning({ id: cases.id });

  const closed = await getStatement(TENANT, lastMonth);
  check("el mes cerrado se congela al pedirlo", closed?.frozen === true);
  check("y cuenta la denuncia de ese mes", closed?.volume.billable_claims === 1, `${closed?.volume.billable_claims}`);

  await db.delete(cases).where(eq(cases.id, old!.id));

  const reread = await getStatement(TENANT, lastMonth);
  check(
    "borrado el caso, la factura dice lo mismo",
    reread?.volume.billable_claims === 1 && reread?.invoice.total_usd === closed?.invoice.total_usd,
    `${reread?.volume.billable_claims} denuncia(s), US$ ${reread?.invoice.total_usd}`
  );
  check("y sigue marcada como congelada", reread?.frozen === true);
  check("con la fecha de cierre original", reread?.frozen_at === closed?.frozen_at);

  // ── 5. El presupuesto es propio ───────────────────────────────────────────
  //
  // El cupo diario es por tenant. Si el cliente nuevo heredara el consumo de
  // producción, empezaría el día sin margen — que fue exactamente el problema
  // que tenía la demo pública antes de tener tenant propio.
  phase("Su presupuesto de IA no lo gasta otro");

  const { checkBudget } = await import("@/server/ai/budget");
  const budget = await checkBudget(TENANT);
  check("arranca con presupuesto", budget.exceeded === false, budget.reason ?? "sin consumo");

  // La resolución es usuario → tenant → entorno, y de eso depende el modelo
  // comercial entero: cada asegurador pega SU clave y paga SU consumo, con lo
  // que nuestro costo por cliente es cero. Nunca se había ejercitado con dos
  // tenants, que es la única configuración donde puede fallar.
  const { getTenantGeminiKey, setTenantGeminiKey } = await import("@/server/ai/provider");

  const inherited = await db
    .select({ enc: tenantAiSettings.gemini_api_key_encrypted })
    .from(tenantAiSettings)
    .where(eq(tenantAiSettings.tenant_id, TENANT));
  check("no hereda ninguna clave de nadie", inherited.length === 0);

  const envKey = process.env.GEMINI_API_KEY?.trim() || null;
  check(
    "sin clave propia, cae a la del entorno",
    (await getTenantGeminiKey(TENANT)) === envKey,
    envKey ? "hay clave de entorno" : "no hay clave de entorno configurada"
  );

  // Y con clave propia: la suya, y la de producción sin moverse.
  //
  // Guardar una clave la cifra con GMAIL_TOKEN_ENCRYPTION_KEY, que en Vercel
  // está marcada Sensitive —de sólo escritura, nadie la puede leer de vuelta—
  // así que desde una laptop no está. Se saltea y se dice: dar por probado lo
  // que no se probó es peor que no probarlo.
  if (!process.env.GMAIL_TOKEN_ENCRYPTION_KEY) {
    skipped.push(
      "la clave propia del cliente (falta GMAIL_TOKEN_ENCRYPTION_KEY, que en " +
        "Vercel es de sólo escritura)"
    );
    console.log("   ⋯ clave propia del cliente: NO ensayada, falta GMAIL_TOKEN_ENCRYPTION_KEY");
  } else {
    const prodKeyBefore = await getTenantGeminiKey(PROD_TENANT);
    const ownKey = `clave-de-ensayo-${RUN}`;
    await setTenantGeminiKey(TENANT, ownKey);

    check(
      "con clave propia cargada, usa la suya",
      (await getTenantGeminiKey(TENANT)) === ownKey
    );
    check(
      "y la de producción no se movió",
      (await getTenantGeminiKey(PROD_TENANT)) === prodKeyBefore
    );
  }
} catch (e) {
  // Sin esto, una excepción a mitad de camino saltea los chequeos que faltan,
  // el finally imprime el resumen con la lista de fallas vacía, y el ensayo
  // termina diciendo que el alta funciona. Es la falla que este archivo existe
  // para no cometer, cometida sobre sí mismo: pasó en la primera corrida con
  // clave de cifrado ausente.
  const detail = e instanceof Error ? e.message : String(e);
  console.log(`   ✗ se cortó: ${detail}`);
  failures.push(`el ensayo se cortó: ${detail}`);
} finally {
  // ── 6. La limpieza ────────────────────────────────────────────────────────
  phase("Se borra sin dejar nada, y sin tocar producción");

  const prodBefore = await db
    .select({ n: sql<number>`count(*)::int` })
    .from(cases)
    .where(eq(cases.tenant_id, PROD_TENANT));

  if (KEEP) {
    console.log(`   (--keep) el tenant ${TENANT} queda en la base. Borralo cuando termines.`);
  } else {
    // Sólo el tenant que creó este ensayo, identificado por id Y por nombre.
    // Un DELETE de tenants cascadea a casos: la guarda de más es barata.
    const [target] = await db
      .select({ id: tenants.id, name: tenants.name })
      .from(tenants)
      .where(and(eq(tenants.id, TENANT), eq(tenants.name, NAME)))
      .limit(1);

    if (!target) {
      console.error(`   ✗ no encuentro el tenant ${TENANT} con el nombre esperado: NO borro nada`);
      failures.push("la limpieza no pudo identificar su propio tenant");
    } else {
      await db.delete(tenants).where(eq(tenants.id, TENANT));

      const leftoverCases = await db
        .select({ n: sql<number>`count(*)::int` })
        .from(cases)
        .where(eq(cases.tenant_id, TENANT));
      const leftoverInvoices = await db
        .select({ n: sql<number>`count(*)::int` })
        .from(billingInvoices)
        .where(eq(billingInvoices.tenant_id, TENANT));

      check("no quedan casos suyos", (leftoverCases[0]?.n ?? -1) === 0);
      check("no quedan facturas suyas", (leftoverInvoices[0]?.n ?? -1) === 0);

      const leftoverKeys = await db
        .select({ enc: tenantAiSettings.gemini_api_key_encrypted })
        .from(tenantAiSettings)
        .where(eq(tenantAiSettings.tenant_id, TENANT));
      check("no queda su clave de IA guardada", leftoverKeys.length === 0);
    }
  }

  const prodAfter = await db
    .select({ n: sql<number>`count(*)::int` })
    .from(cases)
    .where(eq(cases.tenant_id, PROD_TENANT));

  check(
    "producción quedó con los mismos casos que antes",
    prodBefore[0]?.n === prodAfter[0]?.n,
    `${prodBefore[0]?.n} → ${prodAfter[0]?.n}`
  );

  console.log("\n" + "─".repeat(70));
  if (skipped.length > 0) {
    console.log("⋯ Sin ensayar en esta corrida:");
    for (const s of skipped) console.log(`  · ${s}`);
    console.log("");
  }

  if (failures.length === 0) {
    console.log(
      skipped.length === 0
        ? "✓ El alta de un cliente nuevo funciona de punta a punta."
        : "✓ Todo lo que se pudo ensayar, anda. Lo de arriba quedó sin probar."
    );
  } else {
    console.log(`✗ ${failures.length} problema(s) en el alta:\n`);
    for (const f of failures) console.log(`  · ${f}`);
  }

  // exitCode y no exit(): cerrar el proceso con sockets abiertos revienta Node
  // en Windows con una aserción de libuv, que se parece demasiado a un fallo.
  process.exitCode = failures.length === 0 ? 0 : 1;
}
