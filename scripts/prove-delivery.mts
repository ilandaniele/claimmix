/**
 * scripts/prove-delivery.mts
 *
 * Actually send one message, and see whether it arrives.
 *
 * The rest of the suite proves the agent decides well and writes well. It does
 * not prove a message leaves the building, and those are different questions
 * with different ways of failing: a WhatsApp access token that lapsed, a
 * Business account that got restricted, a Gmail refresh token revoked by a
 * password change. Every one of those is silent from our side — the webhook
 * keeps accepting messages, the agent keeps deciding what to say, and nothing
 * reaches anybody.
 *
 * That was the last thing on the list still needing a person. Now it needs a
 * command.
 *
 * This is the only script here that sends anything real, so it never runs by
 * accident: it does nothing at all unless you name a destination.
 *
 *   pnpm prove --whatsapp +5492916426930
 *   pnpm prove --email vos@gmail.com
 *   pnpm prove --whatsapp +54… --email vos@…
 *
 * WhatsApp will only accept free-form text to a number that has written to the
 * business in the last 24 hours. Outside that window Meta rejects it, and the
 * rejection is reported as what it is — a closed window, not a broken token.
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

if (!toWhatsApp && !toEmail) {
  console.log(
    [
      "Este comando manda mensajes DE VERDAD, así que no hace nada por las dudas.",
      "",
      "  pnpm prove --whatsapp +5492916426930",
      "  pnpm prove --email vos@gmail.com",
      "",
      "WhatsApp sólo acepta texto libre hacia un número que le escribió al negocio",
      "en las últimas 24 horas. Fuera de esa ventana, Meta lo rechaza.",
    ].join("\n")
  );
  process.exit(0);
}

const TENANT_ID = process.env.GMAIL_TENANT_ID;
if (!process.env.DATABASE_URL || !TENANT_ID) {
  console.error("Faltan DATABASE_URL o GMAIL_TENANT_ID en .env.local");
  process.exit(1);
}

const stamp = new Date().toISOString().replace("T", " ").slice(0, 16);
let failures = 0;

// ── WhatsApp ─────────────────────────────────────────────────────────────────

if (toWhatsApp) {
  await proveWhatsApp(toWhatsApp);
}

/** Send one message through the Cloud API, exactly as the agent does. */
async function proveWhatsApp(to: string): Promise<void> {
  console.log(`\nWhatsApp → ${to}`);

  const { sendWhatsAppText } = await import("@/server/whatsapp/cloud-api");
  const res = await sendWhatsAppText(
    to,
    `Prueba de entrega de ClaimMix — ${stamp}. Este mensaje es automático, ` +
      `no hace falta que contestes.`
  );

  if (res.ok) {
    console.log("  ✓ Meta lo aceptó y lo puso en camino");
    return;
  }

  console.log(`  ✗ ${res.error}`);

  // Meta answers "(#100) Invalid parameter" to several unrelated mistakes and
  // says nothing about which. Listing them beats guessing.
  if (/#100|Invalid parameter/i.test(res.error ?? "")) {
    console.log("    Meta dice lo mismo para varias cosas distintas. Revisá:");
    console.log("    · ¿es el número DE LA PERSONA, no el del bot?");
    console.log("    · ¿te escribió en las últimas 24 h? Fuera de esa ventana");
    console.log("      sólo se puede mandar una plantilla aprobada.");
    console.log("    · ¿está completo, con código de país? (por ejemplo 59899413456)");
    console.log("    El '+' adelante no molesta: Meta lo acepta igual.");
  }
  failures++;
}

// ── Email ────────────────────────────────────────────────────────────────────

if (toEmail) {
  await proveEmail(toEmail);
}

/**
 * Send one message from the connected mailbox.
 *
 * A function rather than an inline block so the three ways to give up early
 * read as three different problems with three different fixes, instead of
 * nesting.
 */
async function proveEmail(to: string): Promise<void> {
  console.log(`
Mail → ${to}`);

  // Checked before the lookup, because the lookup swallows the reason.
  //
  // The refresh token is stored encrypted, and without the key
  // getGmailAccountForTenant fails exactly as it does when no mailbox is
  // connected — which sent me hunting for a disconnected account that had
  // been connected all along.
  if (!process.env.GMAIL_TOKEN_ENCRYPTION_KEY?.trim()) {
    console.log("  ✗ falta GMAIL_TOKEN_ENCRYPTION_KEY en .env.local");
    console.log("    Sin ella no se puede descifrar el token de la casilla.");
    console.log("    Está en Vercel marcada como Sensitive, así que");
    console.log("    `vercel env pull` la trae vacía: copiala del panel a mano.");
    failures++;
    return;
  }

  const { getGmailAccountForTenant } = await import("@/server/email/gmail/accounts");
  const account = await getGmailAccountForTenant(TENANT_ID!);

  if (!account) {
    console.log("  ✗ no hay ninguna casilla de Gmail conectada para este tenant");
    failures++;
    return;
  }

  const { GmailSender } = await import("@/server/email/gmail/gmail-sender");
  const result = await new GmailSender(account.refreshToken).send({
    to,
    from: account.email,
    subject: `Prueba de entrega de ClaimMix — ${stamp}`,
    textBody:
      "Este mensaje es automático y comprueba que la casilla de siniestros " +
      "puede enviar. No hace falta que lo contestes." +
      "\n\n" +
      "Si te llegó, el camino de salida por mail funciona de punta a punta.",
  });

  if ("providerMessageId" in result && result.providerMessageId) {
    console.log(`  ✓ enviado desde ${account.email}`);
    console.log(`    id: ${result.providerMessageId}`);
    return;
  }

  // The usual cause is a revoked refresh token, which happens quietly every
  // time the mailbox password changes.
  console.log(`  ✗ ${("errorCode" in result && result.errorCode) || "falló el envío"}`);
  console.log("    lo más común: el token se revocó al cambiar la contraseña.");
  console.log("    Reconectá la casilla en Configuración.");
  failures++;
}

console.log(`\n${"─".repeat(60)}`);
if (failures === 0) {
  console.log("✓ La salida funciona. Fijate que hayan llegado de verdad.");
} else {
  console.log(`✗ ${failures} camino(s) de salida rotos.`);
}

// exitCode rather than exit(): calling process.exit() while sockets are
// still closing crashes Node on Windows with a libuv assertion, which looks
// exactly like a failure and is only the process leaving.
process.exitCode = failures === 0 ? 0 : 1;
