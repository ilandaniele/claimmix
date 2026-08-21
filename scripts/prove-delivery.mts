/**
 * scripts/prove-delivery.mts
 *
 * Ask the deployment to send one real message, and report what happened.
 *
 * The rest of the suite proves the agent decides well and writes well. It does
 * not prove a message leaves the building, and those are different questions
 * with different ways of failing: a WhatsApp token that lapsed, a Business
 * account Meta restricted, a Gmail refresh token revoked by a password change.
 * Every one is silent from our side — the webhook keeps accepting messages,
 * the agent keeps deciding what to say, and nothing reaches anybody.
 *
 * The send happens in production, not here, and that is not a convenience.
 * GMAIL_TOKEN_ENCRYPTION_KEY is marked Sensitive in Vercel, which makes it
 * write-only: nobody can read it back, including the person who set it. That
 * is the correct setting for a key that decrypts mailbox credentials, so the
 * test goes to where the credentials already are. It also tests the right
 * thing — a laptop that can send tells you nothing about the deployment.
 *
 * This is the only script here that sends anything real, so it never runs by
 * accident: it does nothing at all unless you name a destination.
 *
 *   pnpm prove --whatsapp 59899413456
 *   pnpm prove --email vos@gmail.com
 *   pnpm prove --whatsapp 598… --email vos@…
 *
 * WhatsApp only accepts free-form text to a number that wrote to the business
 * in the last 24 hours. Outside that window Meta rejects it.
 */

import * as path from "node:path";
import * as fs from "node:fs";
import * as dotenv from "dotenv";

const envPath = path.resolve(process.cwd(), ".env.local");
dotenv.config({ path: fs.existsSync(envPath) ? envPath : undefined });

const args = process.argv.slice(2);

function flag(name: string): string | null {
  const i = args.indexOf(`--${name}`);
  if (i < 0) return null;
  const value = args[i + 1];
  return value && !value.startsWith("--") ? value : null;
}

const toWhatsApp = flag("whatsapp");
const toEmail = flag("email");
const BASE = (
  flag("url") || process.env.SMOKE_URL || "https://claimmix.vercel.app"
).replace(/\/+$/, "");

if (!toWhatsApp && !toEmail) {
  console.log(
    [
      "Este comando manda mensajes DE VERDAD, así que no hace nada por las dudas.",
      "",
      "  pnpm prove --whatsapp 59899413456",
      "  pnpm prove --email vos@gmail.com",
      "",
      "El envío lo hace el deploy, no tu máquina: ahí están las credenciales.",
      "WhatsApp sólo acepta texto libre hacia un número que le escribió al negocio",
      "en las últimas 24 horas. Fuera de esa ventana, Meta lo rechaza.",
    ].join("\n")
  );
  process.exit(0);
}

const SECRET = process.env.CRON_SECRET;
if (!SECRET) {
  console.error("Falta CRON_SECRET en .env.local — es la llave del endpoint.");
  process.exit(1);
}

let failures = 0;

async function send(channel: "whatsapp" | "email", to: string): Promise<void> {
  const label = channel === "whatsapp" ? "WhatsApp" : "Mail";
  console.log(`\n${label} → ${to}`);

  let res: Response;
  try {
    res = await fetch(`${BASE}/api/health/delivery`, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${SECRET}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({ channel, to }),
    });
  } catch (err) {
    console.log(`  ✗ no se pudo llegar al deploy: ${err instanceof Error ? err.message : "error"}`);
    failures++;
    return;
  }

  if (res.status === 401) {
    console.log("  ✗ CRON_SECRET local no coincide con el de producción");
    failures++;
    return;
  }

  const body = (await res.json().catch(() => ({}))) as {
    ok?: boolean;
    detail?: string;
  };

  if (res.status === 429) {
    console.log(`  ! ${body.detail ?? "demasiado seguido"}`);
    return;
  }

  if (body.ok) {
    console.log(`  ✓ ${body.detail}`);
    return;
  }

  console.log(`  ✗ ${body.detail ?? `respondió ${res.status}`}`);

  // Meta answers "(#100) Invalid parameter" to several unrelated mistakes and
  // says nothing about which. Listing them beats guessing — the first real
  // send failed with it because the number was the business's own.
  if (channel === "whatsapp" && /#100|Invalid parameter/i.test(body.detail ?? "")) {
    console.log("    Meta dice lo mismo para varias cosas distintas. Revisá:");
    console.log("    · ¿es el número DE LA PERSONA, no el del bot?");
    console.log("    · ¿te escribió en las últimas 24 h? Fuera de esa ventana");
    console.log("      sólo se puede mandar una plantilla aprobada.");
    console.log("    · ¿está completo, con código de país? (por ejemplo 59899413456)");
    console.log("    El '+' adelante no molesta: Meta lo acepta igual.");
  }

  if (channel === "email") {
    console.log("    Lo más común: el token se revocó al cambiar la contraseña.");
    console.log("    Reconectá la casilla en Configuración.");
  }

  failures++;
}

if (toWhatsApp) await send("whatsapp", toWhatsApp);
if (toEmail) await send("email", toEmail);

console.log(`\n${"─".repeat(60)}`);
if (failures === 0) {
  console.log("✓ La salida funciona. Fijate que hayan llegado de verdad.");
} else {
  console.log(`✗ ${failures} camino(s) de salida rotos.`);
}

// exitCode rather than exit(): calling process.exit() while sockets are still
// closing crashes Node on Windows with a libuv assertion, which looks exactly
// like a failure and is only the process leaving.
process.exitCode = failures === 0 ? 0 : 1;
