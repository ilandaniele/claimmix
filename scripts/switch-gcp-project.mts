/**
 * scripts/switch-gcp-project.mts
 *
 * Move the extraction to a different Google Cloud project, in one command.
 *
 * The credentials for Vertex live in three places that have to agree:
 * `.env.local` for the rehearsal, Vercel for production, and GitHub secrets
 * for the post-deploy check. Changing them by hand is three chances to typo a
 * key and one chance to forget a place entirely — and the failure is quiet,
 * because a deployment that cannot reach the model does not crash. It falls
 * back, and today it would fall back to answering claimants with mock output.
 *
 * So this checks first and writes second. Before touching anything it makes a
 * real call to Vertex with the new key: if the model does not answer, nothing
 * is changed and the old setup keeps working.
 *
 * Usage:
 *   pnpm switch-gcp --project claimmix-veltra --key ./nueva-sa.json
 *   pnpm switch-gcp --project … --key … --dry-run    # sólo verifica
 *
 * The key file is read and never printed. Delete it once this has run — the
 * value lives in Vercel and GitHub from then on, and a service-account key
 * sitting in a Downloads folder is the next leak.
 */

import * as path from "node:path";
import * as fs from "node:fs";
import { execFileSync } from "node:child_process";
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

const project = flag("project");
const keyPath = flag("key");
const dryRun = args.includes("--dry-run");
const location = flag("location") || process.env.GOOGLE_CLOUD_LOCATION || "us-central1";

if (!project || !keyPath) {
  console.log(
    [
      "Mueve la extracción a otro proyecto de Google Cloud.",
      "",
      "  pnpm switch-gcp --project <id> --key <ruta-al-json>",
      "  pnpm switch-gcp --project <id> --key <ruta> --dry-run",
      "",
      "Verifica que las credenciales nuevas funcionen ANTES de cambiar nada.",
    ].join("\n")
  );
  process.exit(0);
}

// ── 1. ¿El archivo es lo que dice ser? ───────────────────────────────────────

if (!fs.existsSync(keyPath)) {
  console.error(`No existe ${keyPath}`);
  process.exit(1);
}

const raw = fs.readFileSync(keyPath, "utf8");
let key: { type?: string; project_id?: string; client_email?: string };
try {
  key = JSON.parse(raw);
} catch {
  console.error("Ese archivo no es JSON. ¿Bajaste la clave de la service account?");
  process.exit(1);
}

if (key.type !== "service_account") {
  console.error(`El JSON no es de una service account (type: ${key.type ?? "ausente"}).`);
  process.exit(1);
}

if (key.project_id !== project) {
  // Vale la pena frenar: una clave del proyecto viejo con el nombre del nuevo
  // deja todo apuntando a un lugar y autenticando contra otro.
  console.error(
    `La clave es del proyecto "${key.project_id}" y pediste "${project}". No coinciden.`
  );
  process.exit(1);
}

console.log(`Proyecto:        ${project}`);
console.log(`Service account: ${key.client_email}`);
console.log(`Región:          ${location}\n`);

// ── 2. ¿Funcionan? ───────────────────────────────────────────────────────────

console.log("Probando las credenciales contra Vertex…");

process.env.GEMINI_TRANSPORT = "vertex";
process.env.GOOGLE_CLOUD_PROJECT = project;
process.env.GOOGLE_CLOUD_LOCATION = location;
process.env.GOOGLE_SERVICE_ACCOUNT_JSON = raw;
delete process.env.GOOGLE_APPLICATION_CREDENTIALS;

try {
  const { callGemini } = await import("@/server/ai/gemini-extractor");
  const { text } = await callGemini('Respondé exactamente {"ok": true}.', "ping");
  if (!text) throw new Error("respondió vacío");
  console.log("  ✓ el modelo responde\n");
} catch (err) {
  console.error(`  ✗ ${err instanceof Error ? err.message : "no respondió"}\n`);
  console.error("No se cambió nada. Revisá que el proyecto tenga la API de Vertex AI");
  console.error("habilitada y que la service account tenga el rol Vertex AI User.");
  process.exit(1);
}

if (dryRun) {
  console.log("--dry-run: las credenciales sirven y no se tocó nada.");
  // exitCode, no exit(): llamar a process.exit() con sockets todavía
  // cerrándose revienta Node en Windows con una aserción de libuv, que se lee
  // igual que un fallo y es sólo el proceso yéndose.
  process.exitCode = 0;
} else {

// ── 3. Escribir en los tres lugares ──────────────────────────────────────────

const values: Record<string, string> = {
  GOOGLE_CLOUD_PROJECT: project,
  GOOGLE_CLOUD_LOCATION: location,
  GEMINI_TRANSPORT: "vertex",
  GOOGLE_SERVICE_ACCOUNT_JSON: raw,
};

/** Rewrite .env.local in place, keeping everything else untouched. */
function updateEnvLocal(): void {
  const lines = fs.readFileSync(envPath, "utf8").split(/\r?\n/);
  const seen = new Set<string>();

  const out = lines.map((line) => {
    const name = line.split("=")[0];
    // El JSON entero no va en .env.local: localmente se usa el archivo.
    if (name === "GOOGLE_SERVICE_ACCOUNT_JSON") return line;
    if (values[name] !== undefined) {
      seen.add(name);
      return `${name}="${values[name]}"`;
    }
    if (name === "GOOGLE_APPLICATION_CREDENTIALS") {
      seen.add(name);
      return `${name}="${path.resolve(keyPath!)}"`;
    }
    return line;
  });

  for (const [name, value] of Object.entries(values)) {
    if (name === "GOOGLE_SERVICE_ACCOUNT_JSON") continue;
    if (!seen.has(name)) out.push(`${name}="${value}"`);
  }

  fs.writeFileSync(envPath, out.join("\n"));
  console.log("  ✓ .env.local");
}

/**
 * En Windows, `npx` es un .cmd y execFileSync no puede ejecutarlo.
 *
 * No falla de forma ruidosa: tira ENOENT, el catch de más abajo lo cuenta como
 * «cargalo a mano», y el script sigue como si nada. Pasó en la mudanza del 24
 * de agosto: las cuatro variables de GitHub se escribieron y las cuatro de
 * Vercel no, así que el entorno local y el de CI apuntaban al proyecto nuevo y
 * producción seguía en el viejo. Es la peor forma de quedar a mitad de camino,
 * porque cada mitad por separado se ve sana.
 *
 * `gh` es un .exe y anda sin esto, que es por qué la mitad de GitHub sí pasó.
 */
const NEEDS_SHELL = process.platform === "win32";

/** Write one secret without it passing through a shell argument. */
function writeSecret(target: "vercel" | "github", name: string, value: string): void {
  const tmp = path.resolve(`.secret-${name}.tmp`);
  fs.writeFileSync(tmp, value);
  try {
    const input = fs.readFileSync(tmp);
    if (target === "vercel") {
      // El valor va por stdin y nunca por un argumento: un argumento se ve en la
      // lista de procesos y queda en el historial de la terminal.
      execFileSync("npx", ["vercel", "env", "rm", name, "production", "--yes"], {
        stdio: "ignore",
        shell: NEEDS_SHELL,
      });
      execFileSync("npx", ["vercel", "env", "add", name, "production"], {
        input,
        shell: NEEDS_SHELL,
      });
    } else {
      execFileSync("gh", ["secret", "set", name], { input });
    }
  } finally {
    fs.rmSync(tmp, { force: true });
  }
}

/**
 * Lo que no se pudo escribir.
 *
 * Las tres copias tienen que coincidir; media mudanza deja el entorno local
 * apuntando a un proyecto y producción a otro, y las dos mitades se ven sanas
 * por separado. Si algo falta, esto termina distinto de cero para que se note.
 */
const failed: string[] = [];

console.log("Escribiendo:");
updateEnvLocal();

for (const [name, value] of Object.entries(values)) {
  try {
    writeSecret("vercel", name, value);
    console.log(`  ✓ Vercel · ${name}`);
  } catch {
    failed.push(`Vercel · ${name}`);
    console.log(`  ✗ Vercel · ${name} — cargalo a mano`);
  }
}

for (const [name, value] of Object.entries(values)) {
  try {
    writeSecret("github", name, value);
    console.log(`  ✓ GitHub · ${name}`);
  } catch {
    failed.push(`GitHub · ${name}`);
    console.log(`  ✗ GitHub · ${name} — cargalo a mano`);
  }
}

console.log(
  [
    "",
    "─".repeat(60),
    "Listo. Falta un deploy para que producción tome las variables:",
    "",
    "  git commit --allow-empty -m 'redeploy: proyecto GCP nuevo' && git push",
    "",
    "Después: pnpm smoke --deep  (hace una llamada real al modelo)",
    "",
    `Y borrá ${keyPath}. El valor ya vive en Vercel y en GitHub; una clave de`,
    "service account en la carpeta de Descargas es la próxima filtración.",
  ].join("\n")
);


  // Media mudanza es peor que ninguna: el entorno local y CI apuntando a un
  // proyecto y producción a otro, y cada mitad viéndose sana por separado. Por
  // eso esto termina distinto de cero — si no, el script dice «cargalo a mano»
  // en una línea y sale con éxito, que es como se pasa por alto.
  if (failed.length > 0) {
    console.error(`\n✖ Sin escribir: ${failed.join(", ")}`);
    console.error("  Las tres copias tienen que coincidir. Cargá las que faltan a mano.");
    process.exitCode = 1;
  }
}