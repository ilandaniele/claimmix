/**
 * scripts/load-test.mts
 *
 * Cuánto aguanta esto antes de que se note, y qué se rompe primero.
 *
 * El resto de la suite pregunta si el sistema hace lo correcto. Esto pregunta
 * otra cosa: si lo sigue haciendo cuando llegan treinta denuncias en dos
 * minutos. Es un escenario real y previsible — un granizo sobre una ciudad
 * mediana genera exactamente eso — y es el único modo de falla que no aparece
 * nunca mientras se programa, porque ahí siempre hay un solo usuario.
 *
 * Mide dos caminos, que se rompen por motivos distintos:
 *
 *   LECTURA — las consultas del tablero contra la base de verdad. Gratis, no
 *   escribe nada. Es lo que ve el analista mientras el resto arde, y lo que se
 *   degrada de a poco a medida que crece el volumen, sin que nadie lo note
 *   hasta que la pantalla tarda cinco segundos.
 *
 *   ESCRITURA — asegurados simultáneos entrando por el webhook del deploy de
 *   verdad. Cuesta plata: cada uno es una llamada real al modelo. Mide las dos
 *   latencias que importan y que no son la misma: cuánto tarda el webhook en
 *   contestarle a Meta (si se pasa, Meta reintenta y el asegurado recibe todo
 *   dos veces) y cuánto tarda el asegurado en recibir una respuesta.
 *
 * Nada le llega a una persona. El camino Bearer del webhook marca el caso como
 * simulado, así que el mensajero redacta la respuesta y la guarda en vez de
 * enviarla — igual que en el ensayo.
 *
 * Uso:
 *   pnpm load                        # sólo lectura: gratis, no escribe nada
 *   pnpm load --write                # + 10 asegurados simultáneos (gasta tokens)
 *   pnpm load --write --claimants 30 # una tormenta de granizo
 *   pnpm load --url https://…        # contra un preview
 */

import * as path from "node:path";
import * as fs from "node:fs";
import * as dotenv from "dotenv";

const envPath = path.resolve(process.cwd(), ".env.local");
dotenv.config({ path: fs.existsSync(envPath) ? envPath : undefined });

const TENANT_ID = process.env.GMAIL_TENANT_ID;
if (!process.env.DATABASE_URL || !TENANT_ID) {
  console.error("Faltan DATABASE_URL o GMAIL_TENANT_ID en .env.local");
  process.exit(1);
}

const args = process.argv.slice(2);

function flag(name: string): string | null {
  const i = args.indexOf(`--${name}`);
  if (i < 0) return null;
  const value = args[i + 1];
  return value && !value.startsWith("--") ? value : null;
}

const doWrite = args.includes("--write");
const claimants = Math.min(Math.max(Number(flag("claimants") ?? 10), 1), 100);
const BASE = (flag("url") || process.env.SMOKE_URL || "https://claimmix.vercel.app").replace(
  /\/+$/,
  ""
);

// Importado después de dotenv: el módulo de base lee DATABASE_URL al importarse.
const { db } = await import("@/lib/db");
const { cases, outboundMessages, claimAttachments } = await import("@/lib/db/schema");
const { and, count, eq, inArray, like, sql } = await import("drizzle-orm");
const { listCases } = await import("@/server/cases/list");
const { getCaseDetail } = await import("@/server/cases/get");

// ── Medir ────────────────────────────────────────────────────────────────────

interface Sample {
  ms: number;
  ok: boolean;
}

function percentile(sorted: number[], p: number): number {
  if (sorted.length === 0) return 0;
  const i = Math.min(sorted.length - 1, Math.ceil((p / 100) * sorted.length) - 1);
  return sorted[i]!;
}

function summarize(samples: Sample[]): { p50: number; p95: number; max: number; failed: number } {
  const ok = samples
    .filter((s) => s.ok)
    .map((s) => s.ms)
    .sort((a, b) => a - b);
  return {
    p50: percentile(ok, 50),
    p95: percentile(ok, 95),
    max: ok.at(-1) ?? 0,
    failed: samples.filter((s) => !s.ok).length,
  };
}

function ms(n: number): string {
  return n >= 1000 ? `${(n / 1000).toFixed(1)}s` : `${Math.round(n)}ms`;
}

/**
 * Corre `total` operaciones con a lo sumo `concurrency` en vuelo, cronometrando
 * cada una.
 *
 * Cronometrar cada operación y no el lote entero es el punto: el total dice
 * cuántas por segundo, y eso no es lo que siente el analista. Lo que siente es
 * su propia consulta haciendo cola detrás de las de todos los demás, y eso
 * sólo aparece en la cola de la distribución.
 */
async function measure(
  total: number,
  concurrency: number,
  op: () => Promise<void>
): Promise<Sample[]> {
  const samples: Sample[] = [];
  let next = 0;

  async function worker(): Promise<void> {
    for (;;) {
      if (next++ >= total) return;
      const started = performance.now();
      try {
        await op();
        samples.push({ ms: performance.now() - started, ok: true });
      } catch {
        samples.push({ ms: performance.now() - started, ok: false });
      }
    }
  }

  await Promise.all(Array.from({ length: Math.min(concurrency, total) }, worker));
  return samples;
}

// ── Fase 1: lectura ──────────────────────────────────────────────────────────

const QUERY_BUDGET_MS = 2_000;
let readFailed = false;

const QUERY = { page: 1, per_page: 25, sort: "created_at", order: "desc" } as const;

async function loadRead(): Promise<void> {
  console.log("─".repeat(68));
  console.log("LECTURA — las consultas del tablero. Gratis, no escribe nada.\n");

  const [volume] = await db
    .select({ n: count() })
    .from(cases)
    .where(eq(cases.tenant_id, TENANT_ID!));
  console.log(`Casos en la base: ${volume?.n ?? 0}\n`);

  // Neon suspende la compute cuando nadie la usa, y la primera consulta después
  // paga el arranque. Sin este calentamiento el primer número mide eso y no la
  // carga, que es justo lo contrario de lo que se quiere saber.
  await listCases({ tenantId: TENANT_ID! }, { ...QUERY } as never);

  const sample = await db
    .select({ id: cases.id })
    .from(cases)
    .where(eq(cases.tenant_id, TENANT_ID!))
    .limit(1);
  const someCase = sample[0]?.id ?? null;

  const escenarios: { name: string; run: () => Promise<void> }[] = [
    {
      name: "listado (página 1, 25)",
      run: async () => {
        await listCases({ tenantId: TENANT_ID! }, { ...QUERY } as never);
      },
    },
    {
      name: "búsqueda por texto",
      run: async () => {
        await listCases({ tenantId: TENANT_ID! }, { ...QUERY, q: "gonzalez" } as never);
      },
    },
  ];

  if (someCase) {
    escenarios.push({
      name: "detalle de un caso",
      run: async () => {
        await getCaseDetail(TENANT_ID!, someCase);
      },
    });
  }

  console.log("                          analistas simultáneos (p95)");
  console.log("consulta                       1        5       20");
  console.log("─".repeat(68));

  for (const escenario of escenarios) {
    const cells: string[] = [];
    for (const concurrency of [1, 5, 20]) {
      const samples = await measure(concurrency * 3, concurrency, escenario.run);
      const s = summarize(samples);
      if (s.failed > 0) {
        readFailed = true;
        cells.push(`${s.failed} ✗`.padStart(9));
      } else {
        if (s.p95 > QUERY_BUDGET_MS) readFailed = true;
        cells.push(ms(s.p95).padStart(9));
      }
    }
    console.log(escenario.name.padEnd(24) + cells.join(""));
  }

  console.log("\np95: de cada 20 consultas, 19 tardan menos que esto.");
  console.log(`Presupuesto: ${ms(QUERY_BUDGET_MS)}. Más que eso el tablero se siente lento.`);

  await explainPlans();
}

/**
 * Preguntarle a Postgres cómo piensa resolver las dos consultas del tablero.
 *
 * Una latencia medida con pocos casos no dice nada sobre el futuro: una
 * consulta que recorre la tabla entera es rapidísima con doscientas filas y
 * está condenada con doscientas mil. El plan lo dice hoy, con las filas que
 * haya.
 */
async function explainPlans(): Promise<void> {
  console.log("\nCómo las resuelve Postgres:\n");

  const plans = [
    {
      name: "listado",
      // La pantalla que abre todo el mundo, todo el tiempo. Si esta empieza a
      // recorrer la tabla entera es una regresión, no una decisión: quiere
      // decir que alguien tocó el orden o el filtro y dejó el índice afuera.
      mustUseIndex: true,
      text: `select id from cases where tenant_id = '${TENANT_ID}' order by created_at desc limit 25`,
    },
    {
      name: "búsqueda",
      mustUseIndex: false,
      text:
        `select id from cases where tenant_id = '${TENANT_ID}' ` +
        `and (policyholder_name ilike '%gonzalez%' or policy_number ilike '%gonzalez%') ` +
        `order by created_at desc limit 25`,
    },
  ];

  for (const plan of plans) {
    try {
      // db.execute devuelve { rows: [...] }, no un arreglo.
      const result = await db.execute(sql.raw(`explain ${plan.text}`));
      const rows = (result as unknown as { rows: Record<string, string>[] }).rows ?? [];
      const explained = rows.map((r) => Object.values(r)[0]).join(" ");
      const seq = /Seq Scan/i.test(explained);
      const idx = explained.match(/Index (?:Only )?Scan(?: Backward)? using (\w+)/i);
      if (seq && plan.mustUseIndex) readFailed = true;
      console.log(
        `  ${plan.name.padEnd(10)} ${
          seq ? "recorre la tabla entera (Seq Scan)" : idx ? `usa ${idx[1]}` : "plan mixto"
        }${seq && plan.mustUseIndex ? "   ← regresión" : ""}`
      );
    } catch (err) {
      console.log(
        `  ${plan.name.padEnd(10)} no se pudo explicar: ${err instanceof Error ? err.name : "error"}`
      );
    }
  }
}

// ── Fase 2: escritura ────────────────────────────────────────────────────────

const RUN = Date.now().toString().slice(-6);

/**
 * Identidades inventadas, dentro del bloque 5490000 que el ensayo ya barre.
 *
 * Si esta corrida se muere a la mitad, el próximo `pnpm check` limpia lo que
 * quedó. Un número de esos no lo puede tener ningún asegurado real, así que la
 * limpieza no puede alcanzar un caso de verdad.
 */
function phoneFor(i: number): string {
  return `5490000${RUN}${String(i).padStart(2, "0")}`;
}

/**
 * Lo que dice cada asegurado. Variado a propósito: el mismo texto treinta veces
 * mide el caché del modelo, no la carga.
 */
const MENSAJES = [
  "Hola, choqué esta mañana en Av. Rivadavia y San Pedrito, mi póliza es la 998877",
  "Buenas, el granizo de anoche me destrozó el techo del auto. Póliza 445566, Marcelo Paz",
  "Se me metieron a robar el estéreo del auto, estaba estacionado en la puerta de casa",
  "Tuve un accidente ayer a la tarde, el otro auto se cruzó de carril. No hubo heridos",
  "Hola quería denunciar un siniestro, me chocaron de atrás en un semáforo",
  "Buenos días, se prendió fuego el motor del auto en la ruta 8, pude bajarme a tiempo",
];

interface Claimant {
  phone: string;
  caseId: string | null;
  ackMs: number;
  ackStatus: number | string;
  repliedMs: number | null;
}

async function loadWrite(): Promise<boolean> {
  const secret = process.env.WHATSAPP_WEBHOOK_SECRET;
  if (!secret) {
    console.error("\nFalta WHATSAPP_WEBHOOK_SECRET en .env.local: no puedo entrar por el webhook.");
    return false;
  }

  console.log("\n" + "─".repeat(68));
  console.log(`ESCRITURA — ${claimants} asegurados a la vez contra ${BASE}`);
  console.log("Cada uno es una llamada real al modelo. Nada le llega a una persona.\n");

  const started = performance.now();
  const people: Claimant[] = [];

  /**
   * Todos al mismo tiempo, sin escalonar.
   *
   * Escalonar la salida es lo que convierte una prueba de carga en una prueba
   * que siempre pasa. La tormenta no llega escalonada.
   */
  await Promise.all(
    Array.from({ length: claimants }, async (_, i) => {
      const phone = phoneFor(i);
      const t0 = performance.now();
      const person: Claimant = {
        phone,
        caseId: null,
        ackMs: 0,
        ackStatus: 0,
        repliedMs: null,
      };
      try {
        const res = await fetch(`${BASE}/api/webhooks/whatsapp`, {
          method: "POST",
          headers: { Authorization: `Bearer ${secret}`, "Content-Type": "application/json" },
          body: JSON.stringify({
            from: phone,
            body: MENSAJES[i % MENSAJES.length],
            provider_message_id: `carga.${RUN}.${i}`,
          }),
        });
        person.ackMs = performance.now() - t0;
        person.ackStatus = res.status;
        const body = (await res.json().catch(() => ({}))) as { case_id?: string };
        person.caseId = body.case_id ?? null;
      } catch (err) {
        person.ackMs = performance.now() - t0;
        person.ackStatus = err instanceof Error ? err.name : "error de red";
      }
      people.push(person);
    })
  );

  const ack = summarize(people.map((p) => ({ ms: p.ackMs, ok: p.ackStatus === 202 })));

  console.log("Acuse del webhook (lo que espera Meta):");
  console.log(
    `  p50 ${ms(ack.p50)}   p95 ${ms(ack.p95)}   máx ${ms(ack.max)}   fallaron ${ack.failed}`
  );
  if (ack.failed > 0) {
    const codes = new Map<string | number, number>();
    for (const p of people) {
      if (p.ackStatus !== 202) codes.set(p.ackStatus, (codes.get(p.ackStatus) ?? 0) + 1);
    }
    for (const [code, n] of codes) console.log(`    ${n} × ${code}`);
  }

  // ── Esperar las respuestas ─────────────────────────────────────────────────

  const withCase = people.filter((p) => p.caseId);
  const ids = withCase.map((p) => p.caseId!);
  if (ids.length === 0) {
    console.log("\nNingún caso llegó a crearse. No hay nada que esperar.");
    return false;
  }

  console.log(`\nEsperando que el agente conteste a ${ids.length}…`);

  const DEADLINE_MS = 300_000;
  const pending = new Map(withCase.map((p) => [p.caseId!, p]));

  /**
   * El tablero, mientras la tormenta pasa.
   *
   * Es la pregunta que ninguna de las dos fases mide por separado: el analista
   * no trabaja en un sistema en reposo, trabaja en éste, con cien extracciones
   * corriendo por detrás. Si su pantalla se cuelga justo cuando entran cien
   * denuncias, se cuelga exactamente el día que la necesita.
   */
  const duringStorm: Sample[] = [];

  while (pending.size > 0 && performance.now() - started < DEADLINE_MS) {
    await new Promise((r) => setTimeout(r, 3_000));

    const t0 = performance.now();
    try {
      await listCases({ tenantId: TENANT_ID! }, { ...QUERY } as never);
      duringStorm.push({ ms: performance.now() - t0, ok: true });
    } catch {
      duringStorm.push({ ms: performance.now() - t0, ok: false });
    }

    const replied = await db
      .select({ caseId: outboundMessages.case_id })
      .from(outboundMessages)
      .where(
        and(eq(outboundMessages.tenant_id, TENANT_ID!), inArray(outboundMessages.case_id, ids))
      );

    const now = performance.now() - started;
    for (const row of replied) {
      const person = row.caseId ? pending.get(row.caseId) : undefined;
      if (person) {
        person.repliedMs = now;
        pending.delete(row.caseId!);
      }
    }
    process.stdout.write(`\r  ${ids.length - pending.size}/${ids.length} contestados…    `);
  }
  console.log("");

  const reply = summarize(
    withCase.map((p) => ({ ms: p.repliedMs ?? DEADLINE_MS, ok: p.repliedMs !== null }))
  );

  console.log("\nHasta que el asegurado recibe una respuesta:");
  console.log(
    `  p50 ${ms(reply.p50)}   p95 ${ms(reply.p95)}   máx ${ms(reply.max)}   sin respuesta ${reply.failed}`
  );

  const board = summarize(duringStorm);
  console.log("\nEl tablero del analista, durante todo esto:");
  console.log(
    `  p50 ${ms(board.p50)}   p95 ${ms(board.p95)}   máx ${ms(board.max)}   fallaron ${board.failed}`
  );

  const estados = await db
    .select({ status: cases.status, n: count() })
    .from(cases)
    .where(inArray(cases.id, ids))
    .groupBy(cases.status);

  console.log("\nEstado final de los casos:");
  for (const row of estados) console.log(`  ${row.n} × ${row.status}`);

  const elapsed = (performance.now() - started) / 1000;
  console.log(
    `\n${claimants} denuncias atendidas en ${elapsed.toFixed(0)}s ` +
      `· ${((claimants / elapsed) * 60).toFixed(0)} por minuto.`
  );

  return ack.failed === 0 && reply.failed === 0;
}

/**
 * Borrar todo lo que esta corrida creó.
 *
 * Corre también con Ctrl-C: una prueba de carga interrumpida deja treinta casos
 * con nombres inventados en la bandeja del analista, que es exactamente el
 * problema que el barrido del ensayo existe para arreglar y que conviene no
 * crear en primer lugar.
 */
async function cleanup(): Promise<void> {
  const mine = await db
    .select({ id: cases.id })
    .from(cases)
    .where(and(eq(cases.tenant_id, TENANT_ID!), like(cases.email_thread_id, `5490000${RUN}%`)));

  if (mine.length === 0) return;

  const { deleteAttachment } = await import("@/server/storage/claim-attachments-bucket");
  for (const row of mine) {
    const files = await db
      .select({ path: claimAttachments.storage_path })
      .from(claimAttachments)
      .where(eq(claimAttachments.case_id, row.id));
    for (const file of files) if (file.path) await deleteAttachment(file.path);
    await db.delete(cases).where(eq(cases.id, row.id));
  }
  console.log(`\nBorrados ${mine.length} caso(s) de la prueba.`);
}

/**
 * No medir el mock.
 *
 * Contra el extractor simulado esto reporta latencias preciosas de un sistema
 * que no llamó a ningún modelo: el número más engañoso posible, porque dice
 * que aguanta diez veces más de lo que aguanta.
 */
async function refuseIfMocked(): Promise<void> {
  const { resolveExtractionEngine } = await import("@/server/ai/provider");
  if ((await resolveExtractionEngine(TENANT_ID!)) === "mock") {
    console.error(
      "El motor de extracción resolvió a 'mock'. Las latencias serían de un\n" +
        "sistema que no llama a ningún modelo — diez veces mejores que las reales."
    );
    process.exit(1);
  }

  /*
   * Y tampoco medir un sistema sin presupuesto.
   *
   * Cien denuncias contra un cupo agotado se contestan todas en cero segundos,
   * porque el worker ni llama al modelo. El número sale precioso y es mentira.
   *
   * Vale saber además que esta prueba GASTA de ese cupo: cien denuncias son
   * más o menos un millón y medio de tokens del mismo tenant que atiende a los
   * asegurados de verdad.
   */
  const { checkBudget } = await import("@/server/ai/budget");
  const budget = await checkBudget(TENANT_ID!);
  if (budget.exceeded) {
    console.error(`No hay presupuesto para medir nada: ${budget.reason}`);
    process.exit(1);
  }
}

// ── Main ─────────────────────────────────────────────────────────────────────

let interrupted = false;
process.on("SIGINT", () => {
  if (interrupted) process.exit(130);
  interrupted = true;
  console.log("\nInterrumpido. Limpiando…");
  void cleanup().finally(() => process.exit(130));
});

let ok = true;

try {
  await loadRead();
  if (readFailed) {
    console.log("\n✗ Alguna consulta se pasó del presupuesto.");
    ok = false;
  } else {
    console.log("\n✓ Lectura dentro del presupuesto.");
  }

  if (doWrite) {
    await refuseIfMocked();
    ok = (await loadWrite()) && ok;
  } else {
    console.log(
      "\nSin --write no se prueba el camino de entrada, que es donde está el\n" +
        "modelo y donde está el límite de verdad."
    );
  }
} finally {
  if (doWrite) await cleanup();
}

console.log("");
// exitCode, no exit(): llamar a process.exit() con sockets todavía cerrándose
// revienta Node en Windows con una aserción de libuv.
process.exitCode = ok ? 0 : 1;
