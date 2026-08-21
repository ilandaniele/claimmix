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
 * simulated channels. On WhatsApp the messenger composes the reply exactly as
 * it would and records it instead of sending it; on email the dispatcher does
 * the same for any `@example.com` address. Nothing reaches a phone or an inbox.
 *
 * Both channels matter and they are genuinely different code: email threads by
 * subject and header, runs a prefilter that decides a message is a newsletter,
 * strips the quoted copy of our own mail out of a reply, and renders HTML
 * templates. None of that exists on WhatsApp, and all of it has broken.
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
const { ingestInboundEmail } = await import("@/server/email/inbound-email");
const { runIntakeAgent } = await import("@/server/agents/intake-agent");
const { db } = await import("@/lib/db");
const {
  cases,
  claimAttachments,
  customers,
  insuredAssets,
  missingDocs,
  outboundMessages,
  extractedFields,
  policies,
} = await import("@/lib/db/schema");
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
    /**
     * Document keys the arriving file should have closed.
     *
     * Only checked when a real photograph is on disk. With the placeholder the
     * recogniser correctly identifies nothing, so asserting a match would be
     * asserting a bug.
     */
    recognises?: string[];
    /**
     * Document keys that must NOT have been closed.
     *
     * The direction of caution that matters: a file wrongly marked as received
     * vanishes from the analyst's list and nobody finds out until the claim
     * stalls. Checked whatever fixture is present — an unrecognisable image
     * must close nothing either.
     */
    recognisesNothing?: boolean;
    /** Exactly how many messages this turn should produce. 0 means silence. */
    replies?: number;
    status?: string;
  };
}

interface Scenario {
  id: string;
  what: string;
  /** Which door the claim comes in through. Defaults to WhatsApp. */
  channel?: "whatsapp" | "email";
  /**
   * A policy to put on file before the conversation starts, and take off
   * afterwards.
   *
   * The tools are only interesting against a book of business, and this tenant
   * has none loaded yet. Seeded and deleted per scenario so a rehearsal never
   * leaves an invented customer sitting in the real Clientes screen.
   */
  policy?: { numero: string; dni: string; nombre: string; vencida?: boolean };
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
      {
        say: "Ahí van las fotos",
        photo: "danos",
        expect: { attachments: 1, recognises: ["fotos_danos"] },
      },
      {
        // The discriminating case: two paper documents outstanding, and it has
        // to pick the right one rather than the only remaining one.
        say: "Y esta es la licencia",
        photo: "licencia",
        expect: { attachments: 2, recognises: ["licencia_conducir"] },
      },
      {
        say: "No completamos ningún parte amistoso, el otro conductor no quiso",
        expect: { replies: 1 },
      },
    ],
    finally: {
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
    id: "busca-la-poliza",
    what: "Da el DNI y no el número de póliza: el agente lo busca en vez de pedirlo",
    policy: { numero: "POL-8812-R", dni: "27.654.321", nombre: "Cecilia Ferrari" },
    turns: [
      {
        // The whole point of giving it lookups. Asking for a policy number
        // that is sitting in our own database under the DNI they just gave is
        // what a form does.
        say: "Hola, choqué esta mañana en Rivadavia y Chiclana. Soy Cecilia Ferrari, DNI 27.654.321. No hubo heridos.",
        expect: { avoids: ["número de póliza", "numero de poliza"] },
      },
    ],
    finally: { knows: ["full_name"] },
  },

  {
    id: "poliza-vencida",
    what: "Una póliza vencida es para una persona, no para seguir pidiendo papeles",
    policy: {
      numero: "POL-5500-V",
      dni: "24.111.222",
      nombre: "Jorge Peralta",
      vencida: true,
    },
    turns: [
      {
        say: "Buenas, tuve un choque ayer en Villa Mitre. Soy Jorge Peralta, DNI 24.111.222, póliza POL-5500-V.",
        expect: {
          replies: 1,
          // Pedirle fotos de los daños a alguien cuya cobertura venció en 2020
          // le hace perder la tarde a él y a nosotros.
          avoids: ["fotos de los daños", "licencia"],
          status: "requiere_especialista",
        },
      },
    ],
    finally: { status: "requiere_especialista" },
  },

  {
    id: "foto-que-no-es-nada",
    what: "Una imagen que no es ningún documento pedido no cierra ningún pedido",
    turns: [
      {
        say: "Choqué en Alem y Sarmiento. Soy Nadia Ferro, DNI 31.909.100, póliza POL-2201-K.",
        expect: { replies: 1 },
      },
      {
        // Someone forwards a screenshot by accident. The direction of caution
        // that matters most: a request marked satisfied by the wrong file
        // disappears from the analyst's list and nobody finds out until the
        // claim stalls. Asking twice is a nuisance; this is a hole.
        say: "Perdón, mandé cualquier cosa",
        photo: "irrelevante",
        expect: { attachments: 1, recognisesNothing: true },
      },
    ],
  },

  // ── Email ─────────────────────────────────────────────────────────────────
  //
  // Genuinely different code from here down: threading by subject, a prefilter
  // that decides a message is a newsletter before anyone reads it, stripping
  // the quoted copy of our own mail out of a reply, and HTML templates instead
  // of the composer. All of it has broken at least once.

  {
    id: "mail-completo",
    channel: "email",
    what: "Una denuncia por mail, en varias respuestas, hasta quedar lista",
    turns: [
      {
        say: [
          "Buenas tardes,",
          "",
          "Les escribo porque ayer choqué en Bahía Blanca, en Av. Alem al 2300.",
          "Soy Martín Sosa, DNI 30.145.882, póliza POL-4471-A. No hubo heridos.",
          "",
          "Saludos,",
          "Martín",
        ].join("\n"),
        expect: { replies: 1 },
      },
      {
        // The reply quotes our own message back, which is how a mail client
        // works and how the extractor once ended up reading our template as
        // though the claimant had written it.
        say: [
          "No completamos ningún parte amistoso, el otro conductor no quiso.",
          "",
          "El mié, 20 ago 2026 a las 21:30, ClaimMix <siniestros@example.com> escribió:",
          "> Necesitamos que nos envíes:",
          "> - Parte amistoso de accidente",
          "> - Fotos de los daños",
        ].join("\n"),
        expect: { replies: 1 },
      },
    ],
    finally: {
      docsDeclined: ["parte_amistoso"],
      knows: ["policy_number", "full_name"],
    },
  },

  {
    id: "mail-no-es-reclamo",
    channel: "email",
    what: "Un newsletter no abre una denuncia ni recibe respuesta",
    turns: [
      {
        // The prefilter should turn this away before a single token is spent
        // on it. Nineteen of these piled up in one day of real inbox testing.
        say: [
          "NEWSLETTER SEPTIEMBRE — Novedades del sector asegurador",
          "",
          "Si no querés recibir más estos correos, hacé clic acá para desuscribirte.",
        ].join("\n"),
        expect: { replies: 0 },
      },
    ],
  },

  {
    id: "mail-grave",
    channel: "email",
    what: "Por mail, un incendio con heridos también se deriva y no pide nada",
    turns: [
      {
        say: [
          "Se incendió el auto en la ruta 3 y mi señora está internada con quemaduras.",
          "Soy Laura Giménez, póliza POL-9982-C.",
        ].join("\n"),
        expect: { replies: 1, status: "requiere_especialista" },
      },
    ],
    finally: { status: "requiere_especialista" },
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
/** Fixture names a scenario asked for and did not find, reported at the end. */
const unrehearsed = new Set<string>();
const RUN = Date.now().toString().slice(-8);

/**
 * The bytes to attach.
 *
 * A named fixture if one exists — drop a real photo of a damaged car in as
 * `tests/fixtures/danos.jpg` and the recognition step gets something it can
 * actually recognise. Otherwise a 1×1 placeholder, which exercises storage and
 * is correctly identified as nothing.
 */
/** Is there a real photograph for this fixture name? */
function haveRealPhoto(photo: string | boolean): boolean {
  return typeof photo === "string" && fs.existsSync(fixturePath(photo));
}

function fixturePath(name: string): string {
  return path.resolve("tests/fixtures", `${name}.jpg`);
}

/**
 * The bytes to attach.
 *
 * A real photograph when one is on disk, otherwise a 1×1 placeholder. The
 * placeholder still exercises everything up to recognition — download,
 * validation, upload, the row in claim_attachments — and is correctly
 * identified as nothing, because it is nothing.
 *
 * Real photographs are not in the repository and never will be. Deciding that
 * an image shows a crumpled bumper needs an image of a crumpled bumper, and
 * the licence that makes the discrimination test meaningful is somebody's
 * actual licence: name, address, date of birth, signature. That does not go
 * into a git history, where it would live forever and travel with every clone.
 * See docs/TESTING.md for which files to drop in.
 */
function imageFor(photo: string | boolean): Buffer {
  if (haveRealPhoto(photo)) return fs.readFileSync(fixturePath(photo as string));
  return fs.readFileSync(path.resolve("tests/fixtures/placeholder.jpg"));
}

function note(scenario: string, turn: number, why: string) {
  failures.push({ scenario, turn, why });
  console.log(`      ✗ ${why}`);
}

/**
 * Put one policy on file for the length of a rehearsal.
 *
 * Returns what to delete afterwards. The lookups are only worth exercising
 * against a real row — this tenant's book is empty — and an invented customer
 * left behind would show up in the Clientes screen as a person who does not
 * exist.
 */
async function seedPolicy(
  policy: NonNullable<Scenario["policy"]>
): Promise<{ customerId: string }> {
  const [customer] = await db
    .insert(customers)
    .values({
      tenant_id: TENANT_ID!,
      full_name: policy.nombre,
      dni: policy.dni.replace(/\D/g, ""),
    })
    .returning({ id: customers.id });

  // From here on, anything that throws has to take the customer with it. The
  // first version of this did not, a CHECK constraint rejected the vehicle,
  // and two people who do not exist were left sitting in the Clientes screen.
  try {
    await seedPolicyFor(customer.id, policy);
  } catch (err) {
    await db.delete(customers).where(eq(customers.id, customer.id));
    throw err;
  }

  return { customerId: customer.id };
}

async function seedPolicyFor(
  customerId: string,
  policy: NonNullable<Scenario["policy"]>
): Promise<void> {
  const [row] = await db
    .insert(policies)
    .values({
      tenant_id: TENANT_ID!,
      customer_id: customerId,
      policy_number: policy.numero,
      policy_type: "auto",
      status: "active",
      end_date: policy.vencida ? "2020-03-01" : "2099-01-01",
    })
    .returning({ id: policies.id });

  await db.insert(insuredAssets).values({
    tenant_id: TENANT_ID!,
    policy_id: row.id,
    // The CHECK constraint spells these in English.
    asset_type: "vehicle",
    make: "Fiat",
    model: "Uno",
    year: 2015,
    plate: "AB123CD",
  });
}

/**
 * Hand one message to the WhatsApp intake, exactly as the webhook does.
 */
async function deliverWhatsApp(
  scenario: Scenario,
  turn: Turn,
  i: number,
  phone: string
): Promise<string> {
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
  return result.caseId;
}

/**
 * Hand one message to the email intake, exactly as the Gmail poller does.
 *
 * Returns the case, or null when the prefilter turned the message away.
 *
 * Replies carry the case number in the subject, which is how a real reply
 * threads: our outbound subject puts it there and the claimant's mail client
 * quotes it back. Header threading is the other route and cannot be rehearsed
 * — a simulated send has no Message-ID, because no message was sent.
 */
async function deliverEmail(
  scenario: Scenario,
  turn: Turn,
  i: number,
  address: string,
  caseId: string | null
): Promise<string | null> {
  const subject = caseId
    ? `Re: Denuncia de siniestro — caso #${caseId}`
    : "Denuncia de siniestro";

  const result = await ingestInboundEmail({
    tenantId: TENANT_ID!,
    channel: "email_sim",
    fromAddr: address,
    toAddr: "siniestros@example.com",
    subject,
    bodyText: turn.say,
    messageId: `rehearsal.${RUN}.${scenario.id}.${i}@example.com`,
    threadId: `thread.${RUN}.${scenario.id}`,
  });

  if (result.outcome === "skipped") return null;

  await runIntakeAgent({
    caseId: result.caseId,
    tenantId: TENANT_ID!,
    userId: null,
    source: "worker",
  });

  return result.caseId;
}

/**
 * The message as a person would read it.
 *
 * Email goes out as HTML, and a rehearsal transcript full of inline styles is
 * a transcript nobody reads — which defeats half the point, since a person
 * skimming the output is how you notice a reply that passes every assertion
 * and still sounds wrong.
 */
function readable(body: string): string {
  if (!/<[a-z!]/i.test(body)) return body;
  return body
    .replace(/<head[\s\S]*?<\/head>/gi, "")
    .replace(/<(script|style)[\s\S]*?<\/\1>/gi, "")
    .replace(/<\/(p|div|h1|h2|h3|li|tr)>/gi, "\n")
    .replace(/<br\s*\/?>/gi, "\n")
    .replace(/<li[^>]*>/gi, "• ")
    .replace(/<[^>]+>/g, "")
    .replace(/&nbsp;/g, " ")
    .replace(/&amp;/g, "&")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .split("\n")
    .map((line) => line.trim())
    .filter((line, i, all) => line.length > 0 || (i > 0 && all[i - 1].length > 0))
    .join("\n")
    .trim();
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

  // A fresh identity per run, so nothing joins a conversation from an earlier
  // one. The address is @example.com on purpose: that is exactly what the
  // dispatcher checks before deciding never to actually send.
  const index = SCENARIOS.indexOf(scenario);
  const phone = `5490000${RUN}${index}`;
  const address = `ensayo.${RUN}.${index}@example.com`;
  const byEmail = scenario.channel === "email";
  let caseId: string | null = null;
  let seen = 0;

  const seeded = scenario.policy ? await seedPolicy(scenario.policy) : null;
  try {

    for (const [i, turn] of scenario.turns.entries()) {
      console.log(`\n   [${i + 1}] 👤 ${turn.say}${turn.photo ? "  📎" : ""}`);

      const delivered = byEmail
        ? await deliverEmail(scenario, turn, i, address, caseId)
        : await deliverWhatsApp(scenario, turn, i, phone);

      if (delivered === null) {
        // The prefilter turned it away. That is an outcome, not a failure —
        // one scenario exists precisely to check that it does.
        console.log("       ⊘ (el filtro de entrada lo descartó)");
        if (turn.expect?.replies !== undefined && turn.expect.replies !== 0) {
          note(scenario.id, i + 1, "el filtro de entrada lo descartó y no debía");
        }
        continue;
      }
      const active: string = delivered;
      caseId = active;

      const said = await repliesSince(active, seen);
      seen += said.length;

      if (said.length === 0) console.log("       🤖 (silencio)");
      for (const reply of said) {
        console.log(`       🤖 ${readable(reply).replace(/\n/g, "\n          ")}`);
      }

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
          .where(eq(claimAttachments.case_id, active));
        if (rows.length !== want.attachments) {
          note(scenario.id, i + 1, `${rows.length} adjunto(s) guardado(s), esperaba ${want.attachments}`);
        }
      }
      if (want.status) {
        const row = await db
          .select({ status: cases.status })
          .from(cases)
          .where(eq(cases.id, active));
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
  } finally {
    // Cascades to the policy and the insured vehicle.
    if (seeded) await db.delete(customers).where(eq(customers.id, seeded.customerId));
  }
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

if (unrehearsed.size > 0) {
  // Said out loud rather than left implicit. A suite that reports "todo verde"
  // while quietly skipping a whole capability is worse than one that fails.
  console.log(
    "\n⋯ Reconocimiento de documentos NO ensayado: faltan " +
      [...unrehearsed].map((n) => `tests/fixtures/${n}.jpg`).join(", ")
  );
}

if (keep) {
  console.log(`\nCasos dejados en la base:\n${created.map((c) => "  " + c).join("\n")}`);
} else if (created.length > 0) {
  // Rehearsal cases would otherwise sit in the analyst's board looking like
  // real claims from people who do not exist.
  //
  // The files go too. Deleting the case cascades through the database and
  // stops at the bucket, so a fortnight of rehearsals had quietly left a pile
  // of orphaned placeholder images in R2 with nothing pointing at them.
  const { deleteAttachment } = await import("@/server/storage/claim-attachments-bucket");

  for (const id of created) {
    const files = await db
      .select({ path: claimAttachments.storage_path })
      .from(claimAttachments)
      .where(eq(claimAttachments.case_id, id));

    for (const file of files) {
      if (file.path) await deleteAttachment(file.path);
    }

    await db.delete(cases).where(eq(cases.id, id));
  }
  console.log(`\n${created.length} caso(s) de ensayo borrados. Usá --keep para conservarlos.`);
}

process.exit(failures.length === 0 ? 0 : 1);
