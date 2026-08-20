/**
 * scripts/rehearse-conversations.ts
 *
 * Drive whole claims through the real agent, end to end, without messaging a
 * single person.
 *
 * Every check so far has been a human typing into WhatsApp and reading what
 * came back. That found real bugs — the photo nobody wrote down, the question
 * asked three times — but it costs a person an afternoon per round, only ever
 * covers the path that person happens to walk, and every message goes out over
 * a WhatsApp Business account that can be flagged for talking to made-up
 * numbers.
 *
 * This runs the same code on the same database with the same model, on the
 * `whatsapp_sim` channel: the messenger composes the reply exactly as it would
 * and then records it instead of sending it. Nothing reaches a phone.
 *
 * It is a rehearsal, not a unit test. It spends real tokens and writes real
 * rows, and it is the only thing here that can catch a regression in the
 * behaviour that emerges from extraction, gap analysis, the orchestrator and
 * the writer all running together — which is where every bug this week lived.
 *
 * Usage:
 *   pnpm rehearse                  # every scenario
 *   pnpm rehearse choque-completo  # one, by id
 *   pnpm rehearse --keep           # leave the cases in the database to inspect
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

// Imported after dotenv: the db module reads DATABASE_URL at import time.
const { createWhatsAppIntakeAndRunAgent } = await import("@/server/agents/intake-agent");
const { db } = await import("@/lib/db");
const { cases, claimAttachments, missingDocs, outboundMessages, extractedFields } =
  await import("@/lib/db/schema");
const { and, eq, asc } = await import("drizzle-orm");

// ── What a rehearsal looks like ──────────────────────────────────────────────

/**
 * One thing the claimant says, and what should be true once the agent has
 * finished thinking about it.
 *
 * Everything in `expect` is optional. A turn with no expectations still runs —
 * useful for setting a conversation up — and the transcript is printed either
 * way, because a reply that is technically correct and reads badly is a
 * failure this file cannot see but a person reading the output can.
 */
interface Turn {
  say: string;
  /**
   * Attach a file.
   *
   * The bytes are a real, tiny JPEG, so the storage path is genuinely
   * exercised: downloaded (skipped — we already have them), validated,
   * uploaded to R2, and written to claim_attachments. That whole chain broke
   * silently once and nobody noticed for weeks.
   *
   * What it cannot rehearse is recognition. Deciding that a photo shows a
   * crumpled bumper means looking at a photo of a crumpled bumper, and a
   * placeholder is not one. Drop a real `tests/fixtures/<name>.jpg` in and it
   * will be used; otherwise the request stays open, which is the correct
   * behaviour for an image nobody can identify.
   */
  photo?: string | boolean;
  expect?: {
    /** The reply must mention each of these, case-insensitively. */
    mentions?: string[];
    /** The reply must not mention any of these. */
    avoids?: string[];
    /** How many attachment rows the case should hold by now. */
    attachments?: number;
    /** Exactly how many messages this turn should produce. 0 means silence. */
    replies?: number;
    status?: string;
  };
}

interface Scenario {
  id: string;
  what: string;
  turns: Turn[];
  /** Checked once, after the last turn. */
  finally?: {
    status?: string;
    docsReceived?: string[];
    docsDeclined?: string[];
    /** Field keys that must have survived to the end with a value. */
    knows?: string[];
  };
}

const SCENARIOS: Scenario[] = [
  {
    id: "choque-completo",
    what: "Un choque que llega entero, en varios mensajes, y termina listo",
    turns: [
      {
        say: "Hola, choqué ayer en Bahía Blanca, Av. Alem al 2300. Soy Martín Sosa, póliza POL-4471-A, DNI 30.145.882. No hubo heridos.",
        expect: { replies: 1, mentions: ["parte", "licencia"], avoids: ["cubierto", "aprobado"] },
      },
      { say: "Ahí van las fotos", photo: "danos", expect: { attachments: 1 } },
      { say: "Y esta es la licencia", photo: "licencia", expect: { attachments: 2 } },
      {
        say: "No completamos ningún parte amistoso, el otro conductor no quiso",
        expect: { replies: 1 },
      },
    ],
    finally: {
      // Not listo_para_core: the placeholder images are unrecognisable, so
      // those two document requests correctly stay open. With real photos in
      // tests/fixtures the claim closes.
      docsDeclined: ["parte_amistoso"],
      knows: ["policy_number", "full_name"],
    },
  },

  {
    id: "incendio-grave",
    what: "Un incendio con heridos: se deriva y no se le pide nada más",
    turns: [
      {
        say: "Se prendió fuego el auto en la ruta 3, mi señora está internada con quemaduras. Soy Laura Giménez, póliza POL-9982-C.",
        expect: {
          replies: 1,
          mentions: ["especialista"],
          // The failure this branch exists for: telling someone whose partner
          // is in hospital that we need their DNI and the time of the fire.
          avoids: ["DNI", "necesitamos que nos mandes", "fotos"],
          status: "requiere_especialista",
        },
      },
    ],
    finally: { status: "requiere_especialista" },
  },

  {
    id: "no-es-reclamo",
    what: "Alguien que pregunta por una cotización no abre una denuncia",
    turns: [
      {
        say: "Hola, quería saber cuánto sale asegurar un Gol Trend 2018 en Bahía Blanca.",
        expect: { replies: 0 },
      },
    ],
    finally: { status: "no_relevante" },
  },

  {
    id: "goteo",
    what: "Los datos llegan de a uno; no se vuelve a pedir lo ya contestado",
    turns: [
      { say: "Buenas, tuve un accidente con el auto", expect: { replies: 1 } },
      { say: "Fue un choque, ayer a la tarde", expect: { replies: 1 } },
      { say: "Soy Roberto Paz, DNI 25.888.101", expect: { replies: 1, avoids: ["nombre"] } },
      { say: "La póliza es POL-3311-B", expect: { replies: 1 } },
    ],
  },

  {
    id: "silencio",
    what: "Un mensaje que no aporta nada no merece que se repita el pedido",
    turns: [
      {
        say: "Hola, choqué contra un poste en Alem al 500. Soy Ana Ruiz, DNI 33.221.114.",
        expect: { replies: 1 },
      },
      // The three-messages-in-ninety-seconds bug: each round was individually
      // correct, and nobody was reading.
      { say: "ok", expect: { replies: 0 } },
      { say: "gracias", expect: { replies: 0 } },
    ],
  },

  {
    id: "pregunta",
    what: "Una persona que pregunta algo tiene que recibir una respuesta",
    turns: [
      {
        say: "Choqué el sábado en Villa Mitre, soy Diego Sosa, póliza POL-7745-D, DNI 28.400.900. No hubo heridos.",
        expect: { replies: 1 },
      },
      {
        say: "¿Cuánto suele tardar esto? Necesito el auto para trabajar.",
        // Not a promise — we cannot know — but not silence either. Ignoring a
        // direct question and asking for the next document is the single most
        // robotic thing the agent does.
        expect: { replies: 1, avoids: ["días hábiles", "48 horas", "una semana"] },
      },
    ],
  },
];

// ── Running one ──────────────────────────────────────────────────────────────

interface Failure {
  scenario: string;
  turn: number;
  why: string;
}

const failures: Failure[] = [];
const RUN = Date.now().toString().slice(-8);

/**
 * The bytes to attach.
 *
 * A named fixture if one exists — drop a real photo of a damaged car in as
 * `tests/fixtures/danos.jpg` and the recognition step gets something it can
 * actually recognise. Otherwise a 1×1 placeholder, which exercises storage and
 * is correctly identified as nothing.
 */
function imageFor(photo: string | boolean): Buffer {
  const named =
    typeof photo === "string" ? path.resolve("tests/fixtures", `${photo}.jpg`) : null;
  if (named && fs.existsSync(named)) return fs.readFileSync(named);
  return fs.readFileSync(path.resolve("tests/fixtures/placeholder.jpg"));
}

function note(scenario: string, turn: number, why: string) {
  failures.push({ scenario, turn, why });
  console.log(`      ✗ ${why}`);
}

async function repliesSince(caseId: string, seen: number): Promise<string[]> {
  const rows = await db
    .select({ body: outboundMessages.rendered_body })
    .from(outboundMessages)
    .where(and(eq(outboundMessages.case_id, caseId), eq(outboundMessages.tenant_id, TENANT_ID!)))
    .orderBy(asc(outboundMessages.created_at));
  return rows.slice(seen).map((r) => r.body);
}

async function runScenario(scenario: Scenario): Promise<string | null> {
  console.log(`\n▸ ${scenario.id} — ${scenario.what}`);

  // A fresh number per run, so nothing joins a conversation from an earlier one.
  const phone = `5490000${RUN}${SCENARIOS.indexOf(scenario)}`;
  let caseId: string | null = null;
  let seen = 0;

  for (const [i, turn] of scenario.turns.entries()) {
    console.log(`\n   [${i + 1}] 👤 ${turn.say}${turn.photo ? "  📎" : ""}`);

    const result = await createWhatsAppIntakeAndRunAgent({
      tenantId: TENANT_ID!,
      from: phone,
      body: turn.say,
      providerMessageId: `rehearsal.${RUN}.${scenario.id}.${i}`,
      simulated: true,
      media: turn.photo
        ? [
            {
              id: `rehearsal-${RUN}-${i}`,
              mimeType: "image/jpeg",
              filename: `${typeof turn.photo === "string" ? turn.photo : "foto"}-${i}.jpg`,
              data: imageFor(turn.photo),
            },
          ]
        : undefined,
    });
    caseId = result.caseId;

    const said = await repliesSince(caseId, seen);
    seen += said.length;

    if (said.length === 0) console.log("       🤖 (silencio)");
    for (const s of said) console.log(`       🤖 ${s.replace(/\n/g, "\n          ")}`);

    const want = turn.expect;
    if (!want) continue;

    if (want.replies !== undefined && said.length !== want.replies) {
      note(scenario.id, i + 1, `esperaba ${want.replies} respuesta(s), hubo ${said.length}`);
    }

    const all = said.join("\n").toLowerCase();
    for (const phrase of want.mentions ?? []) {
      if (!all.includes(phrase.toLowerCase())) {
        note(scenario.id, i + 1, `no menciona "${phrase}"`);
      }
    }
    for (const phrase of want.avoids ?? []) {
      if (all.includes(phrase.toLowerCase())) {
        note(scenario.id, i + 1, `no debería decir "${phrase}"`);
      }
    }
    if (want.attachments !== undefined) {
      const rows = await db
        .select({ id: claimAttachments.id })
        .from(claimAttachments)
        .where(eq(claimAttachments.case_id, caseId));
      if (rows.length !== want.attachments) {
        note(scenario.id, i + 1, `${rows.length} adjunto(s) guardado(s), esperaba ${want.attachments}`);
      }
    }
    if (want.status) {
      const row = await db
        .select({ status: cases.status })
        .from(cases)
        .where(eq(cases.id, caseId));
      if (row[0]?.status !== want.status) {
        note(scenario.id, i + 1, `estado ${row[0]?.status}, esperaba ${want.status}`);
      }
    }
  }

  if (caseId && scenario.finally) {
    const want = scenario.finally;
    const [row] = await db.select({ status: cases.status }).from(cases).where(eq(cases.id, caseId));
    if (want.status && row?.status !== want.status) {
      note(scenario.id, 0, `estado final ${row?.status}, esperaba ${want.status}`);
    }

    const docs = await db
      .select({
        key: missingDocs.doc_key,
        satisfied: missingDocs.satisfied_at,
        declined: missingDocs.declined_at,
      })
      .from(missingDocs)
      .where(eq(missingDocs.case_id, caseId));

    for (const key of want.docsReceived ?? []) {
      if (!docs.find((d) => d.key === key && d.satisfied)) {
        note(scenario.id, 0, `${key} debería figurar como recibido`);
      }
    }
    for (const key of want.docsDeclined ?? []) {
      if (!docs.find((d) => d.key === key && d.declined)) {
        note(scenario.id, 0, `${key} debería figurar como rechazado`);
      }
    }

    if (want.knows?.length) {
      const known = await db
        .select({ key: extractedFields.field_key })
        .from(extractedFields)
        .where(eq(extractedFields.case_id, caseId));
      const keys = new Set(known.map((k) => k.key));
      for (const key of want.knows) {
        if (!keys.has(key)) note(scenario.id, 0, `perdió el dato ${key}`);
      }
    }

    console.log(
      `\n   estado final: ${row?.status} · docs: ${
        docs
          .map((d) => `${d.key}${d.satisfied ? "✓" : d.declined ? "✗" : "·"}`)
          .join(" ") || "ninguno"
      }`
    );
  }

  return caseId;
}

// ── Main ─────────────────────────────────────────────────────────────────────

const args = process.argv.slice(2);
const keep = args.includes("--keep");
const only = args.filter((a) => !a.startsWith("--"));
const chosen = only.length > 0 ? SCENARIOS.filter((s) => only.includes(s.id)) : SCENARIOS;

if (chosen.length === 0) {
  console.error(`No hay escenario con ese nombre. Hay: ${SCENARIOS.map((s) => s.id).join(", ")}`);
  process.exit(1);
}

console.log(
  `Ensayando ${chosen.length} conversación(es) sobre el canal simulado.\n` +
    `Nada sale a un teléfono. Se gastan tokens de verdad.\n`
);

const created: string[] = [];
for (const scenario of chosen) {
  try {
    const id = await runScenario(scenario);
    if (id) created.push(id);
  } catch (err) {
    note(scenario.id, 0, `se cayó: ${err instanceof Error ? err.message : String(err)}`);
  }
}

console.log("\n" + "─".repeat(70));
if (failures.length === 0) {
  console.log(`✓ ${chosen.length} conversación(es), sin diferencias con lo esperado.`);
} else {
  console.log(`✗ ${failures.length} diferencia(s):\n`);
  for (const f of failures) {
    console.log(`  ${f.scenario}${f.turn ? ` turno ${f.turn}` : " (final)"}: ${f.why}`);
  }
}

if (keep) {
  console.log(`\nCasos dejados en la base:\n${created.map((c) => "  " + c).join("\n")}`);
} else if (created.length > 0) {
  // Rehearsal cases would otherwise sit in the analyst's board looking like
  // real claims from people who do not exist.
  for (const id of created) {
    await db.delete(cases).where(eq(cases.id, id));
  }
  console.log(`\n${created.length} caso(s) de ensayo borrados. Usá --keep para conservarlos.`);
}

process.exit(failures.length === 0 ? 0 : 1);
