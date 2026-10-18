/**
 * Reads Gmail + cron env vars from an env file and pushes them to Vercel production.
 * Run once: node scripts/sync-vercel-env.mjs [--project <nombre>] [--archivo <ruta>] [--solo <VAR>[,<VAR>]]
 *   --project  proyecto de Vercel (default claimmix, el vinculado en .vercel)
 *   --archivo  archivo de donde leer (default .env.local)
 *   --solo     sólo esas variables de la lista, separadas por coma (QA: GMAIL_CLIENT_ID,GMAIL_CLIENT_SECRET)
 * claimmix-prd nunca lee .env.local: es el de dev, con las credenciales de dev.
 * Requires: vercel CLI logged in (npx vercel whoami should work)
 */
import { readFileSync, mkdtempSync, rmSync } from "fs";
import { execSync } from "child_process";
import { tmpdir } from "os";
import { resolve, dirname, join } from "path";
import { fileURLToPath } from "url";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");

const args = process.argv.slice(2);
const flag = (nombre, porDefecto) => {
  const i = args.indexOf(`--${nombre}`);
  const valor = args[i + 1];
  return i >= 0 && valor && !valor.startsWith("--") ? valor : porDefecto;
};
const PROYECTO = flag("project", "claimmix");
const ENV_PATH = resolve(ROOT, flag("archivo", ".env.local"));

if (!/^[a-z0-9-]+$/.test(PROYECTO)) {
  console.error(`❌ --project ${PROYECTO}: el nombre no es válido.`);
  process.exit(1);
}
if (PROYECTO === "claimmix-prd" && ENV_PATH === resolve(ROOT, ".env.local")) {
  console.error("❌ claimmix-prd no se carga desde .env.local: pasá --archivo con el archivo de prd.");
  process.exit(1);
}

const VARS_TO_SYNC = [
  "GMAIL_CLIENT_ID",
  "GMAIL_CLIENT_SECRET",
  "GMAIL_REFRESH_TOKEN",
  "GMAIL_USER_EMAIL",
  "GMAIL_FROM_ADDRESS",
  "GMAIL_TENANT_ID",
  "CRON_SECRET",
];

// `--solo` sin nombres no puede caer en las siete: subiría la casilla de dev.
const A_SUBIR = args.some((a) => a === "--solo" || a.startsWith("--solo="))
  ? [...new Set(flag("solo", "").split(",").map((v) => v.trim()).filter(Boolean))]
  : VARS_TO_SYNC;
if (A_SUBIR.length === 0 || A_SUBIR.some((v) => !VARS_TO_SYNC.includes(v))) {
  console.error(`❌ --solo: nombrá una o más de ${VARS_TO_SYNC.join(", ")}, separadas por coma.`);
  process.exit(1);
}

// El proyecto vinculado en .vercel es claimmix. Para otro se vincula una carpeta
// temporal, así no se toca el vínculo del repositorio.
let CWD = ROOT;
if (PROYECTO !== "claimmix") {
  CWD = mkdtempSync(join(tmpdir(), "vercel-env-"));
  process.on("exit", () => rmSync(CWD, { recursive: true, force: true }));
  execSync(`vercel link --yes --project ${PROYECTO}`, { stdio: "inherit", cwd: CWD });
}

const raw = readFileSync(ENV_PATH, "utf8");
const parsed = {};
for (const line of raw.split("\n")) {
  const trimmed = line.trim();
  if (!trimmed || trimmed.startsWith("#")) continue;
  const eq = trimmed.indexOf("=");
  if (eq === -1) continue;
  const key = trimmed.slice(0, eq).trim();
  const value = trimmed.slice(eq + 1).trim().replace(/^["']|["']$/g, "");
  parsed[key] = value;
}

let synced = 0;
let skipped = 0;

for (const varName of A_SUBIR) {
  const value = parsed[varName];
  if (!value || value.startsWith("<")) {
    console.log(`⏭  ${varName} — not set in ${flag("archivo", ".env.local")}, skipping`);
    skipped++;
    continue;
  }
  try {
    execSync(
      `vercel env add ${varName} production`,
      {
        input: value + "\n",
        stdio: ["pipe", "inherit", "inherit"],
        cwd: CWD,
      }
    );
    console.log(`✅ ${varName} — set`);
    synced++;
  } catch {
    // Vercel returns non-zero if the var already exists — try rm + add
    try {
      execSync(`vercel env rm ${varName} production --yes`, {
        stdio: "inherit",
        cwd: CWD,
      });
      execSync(
        `vercel env add ${varName} production`,
        {
          input: value + "\n",
          stdio: ["pipe", "inherit", "inherit"],
          cwd: CWD,
        }
      );
      console.log(`✅ ${varName} — overwritten`);
      synced++;
    } catch (e2) {
      console.error(`❌ ${varName} — failed: ${e2.message}`);
    }
  }
}

console.log(`\nDone: ${synced} set, ${skipped} skipped.`);
console.log(`Run \`vercel env ls production\` in ${PROYECTO} to verify.`);
