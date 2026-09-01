/**
 * scripts/knock-on-the-door.mts
 *
 * Tocar el timbre de verdad, por los dos transportes, sin escribirle a nadie.
 *
 * El ensayo de conversaciones entra por los canales simulados y eso es
 * deliberado: así nunca le manda un mensaje a una persona, y así la cuenta de
 * WhatsApp Business no se arriesga por escribirle a números inventados. Lo que
 * queda afuera de esa decisión es el primer metro de la cadena — lo que pasa
 * entre "el mensaje aparece en la casilla / llega al webhook" y "el worker lo
 * levanta". Ese tramo se probaba de una sola manera: alguien mandando un mail y
 * un WhatsApp a mano.
 *
 * Esto lo cubre sin sacar nada del edificio:
 *
 *   · **Mail.** El deploy DEPOSITA un mensaje en la casilla con
 *     `users.messages.insert` — no lo manda, no hay SMTP, no hay destinatario —
 *     y a partir de ahí el poller, el watch, el parseo del MIME y el prefiltro
 *     corren igual que con un mail real. El remitente es `@example.com`, así que
 *     la respuesta del agente se compone, se guarda y no sale.
 *
 *   · **WhatsApp.** Se arma el payload que manda Meta, se firma con el
 *     `WHATSAPP_APP_SECRET` de verdad y se lo manda al webhook del deploy. Entra
 *     por el camino firmado —el real, no el simulado— y ejercita la validación
 *     de firma, el parseo, la resolución de tenant y el worker. El número es del
 *     bloque reservado, y el mensajero se niega a mandarle nada a ese bloque
 *     venga por donde venga.
 *
 * Lo que NO prueba, dicho de frente: que Google y Meta nos entreguen. Acá el
 * mensaje ya está en el buzón y el webhook lo llamamos nosotros. Todo lo que
 * está de ahí para adentro es nuestro código, y es lo que esto ejercita; el
 * tramo de afuera lo prueba una persona mandando un mensaje, una vez por cada
 * vez que cambia la configuración.
 *
 * Uso:
 *   pnpm knock                 # los dos transportes
 *   pnpm knock --mail          # sólo el mail
 *   pnpm knock --whatsapp      # sólo WhatsApp
 *   pnpm knock --keep          # deja los casos para mirarlos
 */

import * as path from "node:path";
import * as fs from "node:fs";
import { createHmac } from "node:crypto";
import * as dotenv from "dotenv";

const envPath = path.resolve(process.cwd(), ".env.local");
dotenv.config({ path: fs.existsSync(envPath) ? envPath : undefined });

const args = process.argv.slice(2);
const KEEP = args.includes("--keep");
const ONLY_MAIL = args.includes("--mail");
const ONLY_WA = args.includes("--whatsapp");
const RUN = String(Date.now()).slice(-6);

function flag(name: string): string | null {
  const i = args.indexOf(`--${name}`);
  const value = args[i + 1];
  return i !== -1 && value && !value.startsWith("--") ? value : null;
}

const BASE = (flag("url") || process.env.SMOKE_URL || "https://claimmix.vercel.app").replace(/\/+$/, "");
const SECRET = process.env.CRON_SECRET;
const APP_SECRET = process.env.WHATSAPP_APP_SECRET;
const TENANT = process.env.GMAIL_TENANT_ID;

if (!process.env.DATABASE_URL || !TENANT) {
  console.error("Faltan DATABASE_URL o GMAIL_TENANT_ID en .env.local");
  process.exit(1);
}
if (!SECRET) {
  console.error("Falta CRON_SECRET: no puedo pedirle nada al deploy.");
  process.exit(1);
}

const failures: string[] = [];

function check(label: string, ok: boolean, detail?: string): void {
  console.log(`   ${ok ? "✓" : "✗"} ${label}${detail ? ` — ${detail}` : ""}`);
  if (!ok) failures.push(label);
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

const { db } = await import("@/lib/db");
const { cases, claimMessages, outboundMessages, extractedFields } = await import("@/lib/db/schema");
const { and, desc, eq, like, sql } = await import("drizzle-orm");

/**
 * Espera a que el caso aparezca y termine de procesarse.
 *
 * La extracción tarda segundos y corre en otra invocación, así que preguntar una
 * vez y dar por ausente lo que todavía no llegó sería inventar una falla.
 */
async function waitForCase(
  find: () => Promise<{ id: string; status: string } | null>,
  seconds = 150
): Promise<{ id: string; status: string } | null> {
  /*
   * ── Por qué 150 y no 90 ────────────────────────────────────────────────────
   *
   * Eran 90, y el 1º de septiembre esto se puso rojo sin que hubiera nada roto.
   * El caso de WhatsApp apareció a los 104 segundos del webhook —arranque en
   * frío del worker, justo después de un deploy— así que el guión leyó un caso
   * todavía en `procesando`, contó 0 campos extraídos, no encontró respuesta, y
   * reportó tres fallas. El mismo recorrido por mail había tardado 24 segundos.
   *
   * Media hora de alguien buscando un bug que no existía, que es exactamente
   * contra lo que advierte el comentario de `replyFor` acá abajo. La corrida
   * siguiente, sin tocar una línea de producto, tardó 39 segundos y dio 18
   * campos.
   *
   * 150 deja lugar para un arranque en frío sin volver interminable el fallo de
   * verdad: cuando algo esté realmente roto, el rojo tarda dos minutos y medio
   * en llegar en vez de minuto y medio. Barato, comparado con un rojo mentiroso.
   *
   * ── Y por qué ahora `seconds` son segundos ────────────────────────────────
   *
   * Antes era `for (let i = 0; i < seconds; i++)` con un `sleep(1000)` adentro,
   * o sea que cada vuelta costaba un segundo MÁS lo que tardara la consulta. Con
   * la base a ~150 ms, esos «90 segundos» eran 104 de reloj — y ese desfasaje es
   * parte de por qué la ventana era impredecible justo cuando importaba.
   *
   * Con una fecha límite, el número dice lo que mide.
   */
  const limite = Date.now() + seconds * 1000;

  for (;;) {
    const row = await find();
    if (row && row.status !== "procesando" && row.status !== "recibido") return row;
    // Se acabó el tiempo: se devuelve lo último que se leyó, aunque siga
    // procesando. Quien llama distingue «no apareció» de «apareció a medias».
    if (Date.now() >= limite) return row;
    await sleep(1000);
  }
}

/**
 * Lo que el agente compuso para ese caso, haya salido o no.
 *
 * Con espera, porque el estado del caso y la respuesta se escriben por
 * separado y no siempre en ese orden. La primera versión preguntaba una sola
 * vez apenas cambiaba el estado y reportaba «sin registro» por medio segundo
 * de diferencia: una falla inventada por el reloj, que es la peor clase de
 * rojo — manda a buscar un bug que no existe.
 */
async function replyFor(caseId: string, seconds = 20) {
  for (let i = 0; i < seconds; i++) {
    const rows = await db
      .select({ status: outboundMessages.status, template: outboundMessages.template })
      .from(outboundMessages)
      .where(eq(outboundMessages.case_id, caseId))
      .orderBy(desc(outboundMessages.created_at))
      .limit(1);
    if (rows.length > 0) return rows;
    await sleep(1000);
  }
  return [];
}

async function fieldsFor(caseId: string) {
  return db
    .select({ n: sql<number>`count(*)::int` })
    .from(extractedFields)
    .where(eq(extractedFields.case_id, caseId));
}

const created: string[] = [];

// ── El timbre por mail ───────────────────────────────────────────────────────
async function knockByMail(): Promise<void> {
  console.log("\n▸ MAIL — un mensaje aparece en la casilla de verdad\n");

  const res = await fetch(`${BASE}/api/health/knock`, {
    method: "POST",
    headers: { Authorization: `Bearer ${SECRET}`, "Content-Type": "application/json" },
    body: JSON.stringify({ action: "insert", run: RUN }),
  });
  const body = (await res.json().catch(() => ({}))) as {
    ok?: boolean;
    message_id?: string;
    mailbox?: string;
    error?: { message?: string };
  };

  if (!res.ok || !body.ok) {
    check("el deploy pudo dejar el mensaje en la casilla", false, body.error?.message ?? `HTTP ${res.status}`);
    return;
  }
  check("el mensaje quedó en la casilla", true, body.mailbox);

  /*
   * El identificador con el que vamos a reconocer nuestro propio caso.
   *
   * Gmail le pone un id al mensaje que acabamos de depositar, la ruta nos lo
   * devuelve, y el poller escribe EXACTAMENTE ese id en `cases.email_message_id`
   * cuando lo levanta. Hay un índice único `(tenant_id, email_message_id)`
   * detrás, así que apunta a un caso y a uno solo.
   *
   * Antes esto se buscaba por `policy_number = "POL-8812-C"`, o sea por un
   * campo que decide el modelo. Cuando la extracción no dejaba ese número en la
   * columna del caso —cosa que pasa, y a propósito: el código no escribe ahí lo
   * que sólo encontró el parser de respaldo— el timbre no encontraba nada y
   * reportaba "no se creó el caso" sobre un caso que sí existía. Falló así el
   * 26 de agosto a las 22:39 y pasó diez minutos después con el mismo código.
   *
   * Y había un falso verde escondido en la misma consulta: con `order by
   * created_at desc limit 1`, un caso viejo de otra corrida con esa misma
   * póliza habría dado el chequeo por bueno sin que la corrida de hoy hubiera
   * creado nada.
   */
  if (!body.message_id) {
    check("el deploy devolvió el id del mensaje", false, "sin message_id");
    return;
  }
  const messageId = body.message_id;

  // El watch avisa a Google, no a nosotros: se dispara el poller igual que a las
  // tres de la mañana, que es el mismo camino que recorre un mail real.
  const poll = await fetch(`${BASE}/api/cron/gmail-poll`, {
    headers: { Authorization: `Bearer ${SECRET}` },
  });
  check("el poller lo levantó", poll.ok, `HTTP ${poll.status}`);

  /*
   * Se pregunta dos cosas distintas y se informan por separado.
   *
   * Antes había un solo `check("se creó el caso")` que se ponía rojo por tres
   * motivos que no se parecen en nada: que el caso no exista, que exista y no
   * lo encontremos, y que exista y todavía esté procesándose. El rojo decía
   * siempre lo mismo, y mandó a buscar un bug de ingesta que no existía.
   */
  const existe = async () => {
    const [row] = await db
      .select({ id: cases.id, status: cases.status })
      .from(cases)
      .where(and(eq(cases.tenant_id, TENANT!), eq(cases.email_message_id, messageId)))
      .limit(1);
    return row ?? null;
  };

  const found = await waitForCase(existe);

  if (!found) {
    // Una última pregunta sin condición de estado, para poder distinguir "no
    // entró" de "entró y todavía no terminó". Son dos problemas distintos y
    // sólo uno de los dos es de la ingesta.
    const crudo = await existe();
    check("se creó el caso", Boolean(crudo), crudo?.id ?? `sin caso para ${messageId}`);
    if (crudo) {
      check("terminó de procesarse", false, `quedó en ${crudo.status}`);
    }
    return;
  }

  check("se creó el caso", true, found.id);
  created.push(found.id);

  const [fields] = await fieldsFor(found.id);
  check("extrajo los datos", (fields?.n ?? 0) > 0, `${fields?.n} campo(s)`);
  check("no lo tomó por spam", found.status !== "no_relevante", found.status);

  const [reply] = await replyFor(found.id);
  check("el agente contestó", Boolean(reply), reply?.template);
  check(
    "y la respuesta NO salió del edificio",
    reply?.status === "skipped_simulated",
    reply?.status ?? "sin registro"
  );

  if (!KEEP && body.message_id) {
    await fetch(`${BASE}/api/health/knock`, {
      method: "POST",
      headers: { Authorization: `Bearer ${SECRET}`, "Content-Type": "application/json" },
      body: JSON.stringify({ action: "trash", message_id: body.message_id }),
    });
  }
}

// ── El timbre por WhatsApp ───────────────────────────────────────────────────
async function knockByWhatsApp(): Promise<void> {
  console.log("\n▸ WHATSAPP — el payload de Meta, firmado como lo firma Meta\n");

  if (!APP_SECRET) {
    console.log("   (sin WHATSAPP_APP_SECRET: no puedo firmar como Meta, se saltea)");
    return;
  }

  // Del bloque reservado. El mensajero se niega a escribirle a este bloque
  // venga por donde venga, así que nadie recibe nada.
  const from = `5490000${RUN}`;

  const payload = {
    object: "whatsapp_business_account",
    entry: [
      {
        id: "timbre",
        changes: [
          {
            field: "messages",
            value: {
              messaging_product: "whatsapp",
              contacts: [{ profile: { name: "Asegurado de prueba" }, wa_id: from }],
              messages: [
                {
                  from,
                  id: `wamid.timbre.${RUN}`,
                  timestamp: "0",
                  type: "text",
                  text: {
                    body:
                      "Hola, choqué ayer a la tarde en Alem al 2300, Bahía Blanca. " +
                      "Soy Carla Ferreyra, DNI 31.444.777, póliza POL-8812-C. No hubo heridos.",
                  },
                },
              ],
            },
          },
        ],
      },
    ],
  };

  const raw = JSON.stringify(payload);
  const signature = `sha256=${createHmac("sha256", APP_SECRET).update(raw).digest("hex")}`;

  const res = await fetch(`${BASE}/api/webhooks/whatsapp`, {
    method: "POST",
    headers: { "Content-Type": "application/json", "x-hub-signature-256": signature },
    body: raw,
  });
  check("el webhook aceptó la firma", res.ok, `HTTP ${res.status}`);

  // Y que rechace una falsa, que es la mitad que importa de una firma.
  const forged = await fetch(`${BASE}/api/webhooks/whatsapp`, {
    method: "POST",
    headers: { "Content-Type": "application/json", "x-hub-signature-256": "sha256=00" },
    body: raw,
  });
  check("y rechaza una firma falsa", forged.status === 401, `HTTP ${forged.status}`);

  if (!res.ok) return;

  const found = await waitForCase(async () => {
    const [row] = await db
      .select({ id: cases.id, status: cases.status })
      .from(cases)
      .where(and(eq(cases.tenant_id, TENANT!), like(cases.email_thread_id, `%${from}%`)))
      .orderBy(desc(cases.created_at))
      .limit(1);
    return row ?? null;
  });

  check("se creó el caso", Boolean(found), found?.id);
  if (!found) return;
  created.push(found.id);

  const [fields] = await fieldsFor(found.id);
  check("extrajo los datos", (fields?.n ?? 0) > 0, `${fields?.n} campo(s)`);

  const [reply] = await replyFor(found.id);
  check("el agente contestó", Boolean(reply), reply?.template);
  check(
    "y no le escribió a un número inventado",
    reply?.status === "skipped_simulated",
    reply?.status ?? "sin registro"
  );
}

// ── Correr ───────────────────────────────────────────────────────────────────
console.log("═".repeat(70));
console.log(`TOCAR EL TIMBRE — por los transportes de verdad, contra ${BASE}`);
console.log("═".repeat(70));

try {
  if (!ONLY_WA) await knockByMail();
  if (!ONLY_MAIL) await knockByWhatsApp();
} catch (e) {
  const detail = e instanceof Error ? e.message : String(e);
  console.log(`   ✗ se cortó: ${detail}`);
  failures.push(`se cortó: ${detail}`);
} finally {
  if (KEEP) {
    console.log(`\n(--keep) quedan ${created.length} caso(s) en la base.`);
  } else if (created.length > 0) {
    for (const id of created) await db.delete(cases).where(eq(cases.id, id));
    console.log(`\n${created.length} caso(s) de prueba borrados.`);
  }

  /*
   * Y los que dejaron las corridas que fallaron.
   *
   * El timbre borra lo que encuentra, y cuando no encontraba su caso —el bug
   * de buscar por `policy_number`— tampoco lo borraba: cada corrida en rojo
   * dejaba un siniestro inventado en producción. Al 27 de agosto de 2026 había
   * cinco, desde el 25.
   *
   * No es sólo prolijidad. Esos casos entran a los conteos por canal y por
   * estado, así que un número que alguien mira para decidir algo incluye mails
   * que nos mandamos nosotros.
   *
   * El filtro es el remitente, `timbre.<algo>@example.com`. `example.com` está
   * reservado por la IANA: no le pertenece a nadie y nunca va a pertenecerle,
   * así que esto no puede alcanzar el caso de una persona.
   */
  if (!KEEP) {
    const viejos = await db
      .selectDistinct({ id: cases.id })
      .from(cases)
      .innerJoin(claimMessages, eq(claimMessages.case_id, cases.id))
      .where(
        and(
          eq(cases.tenant_id, TENANT!),
          like(claimMessages.from_addr, "%timbre.%@example.com%")
        )
      );
    if (viejos.length > 0) {
      for (const { id } of viejos) await db.delete(cases).where(eq(cases.id, id));
      console.log(`${viejos.length} caso(s) de corridas anteriores, barridos.`);
    }
  }

  console.log("\n" + "─".repeat(70));
  if (failures.length === 0) {
    console.log("✓ Entra por los dos transportes, y no sale nada hacia afuera.");
  } else {
    console.log(`✗ ${failures.length} problema(s):\n`);
    for (const f of failures) console.log(`  · ${f}`);
  }

  process.exitCode = failures.length === 0 ? 0 : 1;
}
