/**
 * scripts/switch-mailbox.mts
 *
 * Make one mailbox the intake mailbox, and retire the others — without a
 * moment where nothing can send.
 *
 * The order is the whole design. Deleting the old mailboxes first and then
 * discovering the new one cannot send leaves the product mute: claims keep
 * arriving and nothing answers them, and the way you find out is a claimant
 * complaining. So the old ones are only ever *disabled* first, a real message
 * is sent to prove the new one works, and the deletion happens after that —
 * or the old ones come straight back on.
 *
 * The proof has to come from production, not from here: the refresh tokens are
 * encrypted with a key marked Sensitive in Vercel, which nobody can read back.
 * Production has it, so production does the sending.
 *
 * Usage:
 *   pnpm mailbox                                  # sólo mira y no toca nada
 *   pnpm mailbox --keep veltra.claimmix@gmail.com --test vos@tudominio.com
 *   pnpm mailbox --keep … --test … --delete       # además borra las viejas
 *
 * Without --delete the old mailboxes are left disabled, which is reversible
 * from the app. Run it again with --delete once you are satisfied.
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

const keep = flag("keep")?.toLowerCase() ?? null;
const testTo = flag("test");
const doDelete = args.includes("--delete");
const BASE = (flag("url") || process.env.SMOKE_URL || "https://claimmix.vercel.app").replace(
  /\/+$/,
  ""
);

const TENANT_ID = process.env.GMAIL_TENANT_ID;
const SECRET = process.env.CRON_SECRET;
if (!process.env.DATABASE_URL || !TENANT_ID) {
  console.error("Faltan DATABASE_URL o GMAIL_TENANT_ID en .env.local");
  process.exit(1);
}

const { db } = await import("@/lib/db");
const { gmailAccounts } = await import("@/lib/db/schema");
const { and, eq, ne } = await import("drizzle-orm");

async function list() {
  return db
    .select({
      email: gmailAccounts.email,
      enabled: gmailAccounts.enabled,
      lastError: gmailAccounts.last_error,
    })
    .from(gmailAccounts)
    .where(eq(gmailAccounts.tenant_id, TENANT_ID!))
    .orderBy(gmailAccounts.created_at);
}

function show(rows: Awaited<ReturnType<typeof list>>) {
  for (const r of rows) {
    const state = r.enabled ? "activa " : "apagada";
    console.log(`  ${state}  ${r.email}${r.lastError ? `  · error: ${r.lastError}` : ""}`);
  }
}

console.log("Casillas conectadas:");
const before = await list();
show(before);

if (!keep) {
  console.log(
    [
      "",
      "Sin --keep no toco nada.",
      "",
      "  pnpm mailbox --keep casilla@dominio.com --test vos@tudominio.com",
      "",
      "Apaga las demás, manda un mensaje real desde la que queda para probar que",
      "puede enviar, y si falla las vuelve a prender. Agregá --delete para",
      "borrarlas de verdad una vez que estés conforme.",
    ].join("\n")
  );
  process.exit(0);
}

const target = before.find((r) => r.email.toLowerCase() === keep);
if (!target) {
  console.error(
    `\n"${keep}" no está conectada. Conectala primero en /configuracion → Gmail.`
  );
  process.exit(1);
}

const others = before.filter((r) => r.email.toLowerCase() !== keep && r.enabled);
if (others.length === 0 && target.enabled) {
  console.log(`\n${keep} ya es la única activa.`);
}

// ── Apagar las demás, sin borrarlas ──────────────────────────────────────────

if (others.length > 0) {
  console.log(`\nApagando ${others.length} casilla(s)…`);
  await db
    .update(gmailAccounts)
    .set({ enabled: false })
    .where(and(eq(gmailAccounts.tenant_id, TENANT_ID), ne(gmailAccounts.email, target.email)));
}

if (!target.enabled) {
  await db
    .update(gmailAccounts)
    .set({ enabled: true })
    .where(eq(gmailAccounts.email, target.email));
  console.log(`Encendiendo ${target.email}…`);
}

/** Put the old mailboxes back exactly as they were. */
async function rollback(): Promise<void> {
  for (const row of before) {
    await db
      .update(gmailAccounts)
      .set({ enabled: row.enabled })
      .where(eq(gmailAccounts.email, row.email));
  }
  console.log("Volví todo como estaba.");
}

// ── Probar que la que queda puede enviar ─────────────────────────────────────

if (!testTo) {
  console.log(
    "\nSin --test no puedo comprobar que envíe. Las viejas quedan apagadas,\n" +
      "que es reversible. Corré `pnpm prove --email vos@tudominio.com` para verificar."
  );
  process.exitCode = 0;
} else if (!SECRET) {
  console.error("\nFalta CRON_SECRET: no puedo pedirle a producción que envíe.");
  await rollback();
  process.exitCode = 1;
} else {
  console.log(`\nPidiéndole a producción que mande un mensaje a ${testTo}…`);

  let ok = false;
  let detail = "";
  try {
    const res = await fetch(`${BASE}/api/health/delivery`, {
      method: "POST",
      headers: { Authorization: `Bearer ${SECRET}`, "Content-Type": "application/json" },
      body: JSON.stringify({ channel: "email", to: testTo }),
    });
    const body = (await res.json()) as { ok?: boolean; detail?: string };
    ok = body.ok === true;
    detail = body.detail ?? `respondió ${res.status}`;
  } catch (err) {
    detail = err instanceof Error ? err.message : "no se pudo llegar al deploy";
  }

  if (!ok) {
    console.error(`  ✗ ${detail}`);
    console.error("\nLa casilla nueva no pudo enviar, así que no la dejo sola.");
    await rollback();
    process.exitCode = 1;
  } else {
    console.log(`  ✓ ${detail}`);

    if (doDelete) {
      const gone = before.filter((r) => r.email.toLowerCase() !== keep);
      for (const row of gone) {
        await db.delete(gmailAccounts).where(eq(gmailAccounts.email, row.email));
        console.log(`  borrada ${row.email}`);
      }
    }

    console.log("\nQuedó así:");
    show(await list());

    if (!doDelete) {
      console.log(
        "\nLas viejas quedan apagadas, no borradas. Corré esto de nuevo con" +
          "\n--delete cuando quieras sacarlas del todo."
      );
    }
    console.log(
      "\nAcordate de actualizar GMAIL_USER_EMAIL y GMAIL_FROM_ADDRESS si" +
        "\nnombran una casilla que ya no existe."
    );
  }
}
