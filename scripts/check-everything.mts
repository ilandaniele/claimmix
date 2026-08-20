/**
 * scripts/check-everything.mts
 *
 * One command to run after a deploy.
 *
 * Testing this product had become a person typing into WhatsApp and Gmail for
 * an afternoon, walking one path per afternoon, over a Business account that
 * can be flagged for messaging invented numbers. It found real bugs and it
 * does not scale, is not repeatable, and covers whatever that person happened
 * to think of.
 *
 * Three layers, in the order that fails fastest and cheapest:
 *
 *   1. verify   — types, lint, unit and integration tests. Seconds. Free.
 *                 Catches anything that is wrong on its own terms.
 *
 *   2. rehearse — whole claims driven through the real agent on the simulated
 *                 channels, both WhatsApp and email. Minutes, and real tokens.
 *                 Catches what only goes wrong when extraction, gap analysis,
 *                 the orchestrator and the writer run together — which is
 *                 where every bug of the last week lived.
 *
 *   3. smoke    — asks the deployment that is actually running what it can
 *                 reach. Seconds. Catches the class the first two cannot see
 *                 by construction: code that is correct and an environment
 *                 that is missing something. R2 worked locally for hours while
 *                 production dropped every attachment.
 *
 * Stops at the first layer that fails, because the later ones cost money and
 * a red unit test makes their result meaningless anyway.
 *
 * Usage:
 *   pnpm check              # all three
 *   pnpm check --fast       # skip the rehearsal (free, no tokens)
 *   pnpm check --deep       # smoke also uploads a file and calls the model
 *   pnpm check --local      # skip smoke, for when nothing is deployed yet
 */

import { spawn } from "node:child_process";

const args = process.argv.slice(2);
const fast = args.includes("--fast");
const local = args.includes("--local");
const deep = args.includes("--deep");

interface Layer {
  name: string;
  what: string;
  command: string;
  args: string[];
  skip?: boolean;
  why?: string;
}

const LAYERS: Layer[] = [
  {
    name: "verify",
    what: "tipos, lint y 1900+ tests",
    command: "pnpm",
    args: ["run", "verify"],
  },
  {
    name: "rehearse",
    what: "conversaciones enteras por WhatsApp y mail, sin mandarle nada a nadie",
    command: "pnpm",
    args: ["run", "rehearse"],
    skip: fast,
    why: "--fast",
  },
  {
    name: "smoke",
    what: "qué alcanza a ver el deploy que está corriendo",
    command: "pnpm",
    args: deep ? ["run", "smoke", "--", "--deep"] : ["run", "smoke"],
    skip: local,
    why: "--local",
  },
];

function run(layer: Layer): Promise<number> {
  return new Promise((resolve) => {
    const child = spawn(layer.command, layer.args, {
      stdio: "inherit",
      shell: process.platform === "win32",
    });
    child.on("close", (code) => resolve(code ?? 1));
  });
}

const started = Date.now();

for (const layer of LAYERS) {
  if (layer.skip) {
    console.log(`\n${"═".repeat(70)}\n⤳ ${layer.name} — omitido (${layer.why})\n`);
    continue;
  }

  console.log(`\n${"═".repeat(70)}\n▶ ${layer.name} — ${layer.what}\n`);

  const code = await run(layer);
  if (code !== 0) {
    console.log(`\n${"═".repeat(70)}`);
    console.log(`✗ Falló en "${layer.name}". Las capas siguientes no corrieron:`);
    console.log(`  lo que viene cuesta plata y con esto en rojo su resultado no dice nada.`);
    process.exit(code);
  }
}

const minutes = ((Date.now() - started) / 60_000).toFixed(1);
console.log(`\n${"═".repeat(70)}`);
console.log(`✓ Todo en orden. ${minutes} min.`);
if (fast) console.log("  (sin ensayo de conversaciones: corré `pnpm check` completo antes de un release)");
if (local) console.log("  (sin chequeo de producción: corrélo después del deploy)");
