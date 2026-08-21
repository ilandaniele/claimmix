/**
 * scripts/smoke-production.mts
 *
 * Ask the deployment that is actually running whether it is healthy.
 *
 * Everything else in the test suite runs on a laptop against the same database
 * — which proves the code is right and proves nothing about the thing serving
 * real claimants. Those are different questions, and the second one has its
 * own way of going wrong: R2 worked in every local run for hours while
 * production silently dropped every attachment, because the credentials had
 * never been added to Vercel. Nothing failed loudly.
 *
 * So this talks to production over the network, exactly as a claimant's
 * webhook does, and asks what it can reach.
 *
 * Usage:
 *   pnpm smoke                 # configuration and connectivity, free
 *   pnpm smoke --deep          # also uploads a file and calls the model
 *   pnpm smoke --url https://…  # a preview deployment instead of production
 */

import * as path from "node:path";
import * as fs from "node:fs";
import * as dotenv from "dotenv";

const envPath = path.resolve(process.cwd(), ".env.local");
dotenv.config({ path: fs.existsSync(envPath) ? envPath : undefined });

const args = process.argv.slice(2);
const deep = args.includes("--deep");

function flag(name: string): string | null {
  const i = args.indexOf(`--${name}`);
  if (i < 0) return null;
  const value = args[i + 1];
  return value && !value.startsWith("--") ? value : null;
}

const BASE = (
  flag("url") || process.env.SMOKE_URL || "https://claimmix.vercel.app"
).replace(/\/+$/, "");

/**
 * The commit this run is checking, when it knows.
 *
 * Vercel promotes the alias a moment after the deployment reports success, so
 * a check that fires immediately can interrogate the *previous* build and
 * report it green — the most dangerous possible answer, because the broken
 * deploy is the one being asked about. Given a SHA, this waits until the
 * running deployment says it is that one.
 */
const EXPECT_COMMIT = flag("expect-commit")?.slice(0, 7) ?? null;
const WAIT_FOR_ALIAS_MS = 3 * 60 * 1000;

const SECRET = process.env.CRON_SECRET;
if (!SECRET) {
  console.error("Falta CRON_SECRET en .env.local — es la llave del endpoint de salud.");
  process.exit(1);
}

interface Check {
  name: string;
  status: "ok" | "degraded" | "down";
  detail: string;
}

const MARK: Record<Check["status"], string> = {
  ok: "✓",
  degraded: "!",
  down: "✗",
};

console.log(`Consultando ${BASE}${deep ? " (a fondo: gasta tokens y sube un archivo)" : ""}\n`);

/** A page that should be reachable by anyone, to tell "deployed" from "up". */
async function checkReachable(): Promise<boolean> {
  try {
    const res = await fetch(`${BASE}/login`, { redirect: "manual" });
    // Anything that is not a server error means Next is serving.
    if (res.status >= 500) {
      console.log(`  ✗ el sitio responde ${res.status}`);
      return false;
    }
    console.log(`  ✓ el sitio responde`);
    return true;
  } catch (err) {
    console.log(`  ✗ no se pudo llegar: ${err instanceof Error ? err.message : "error"}`);
    return false;
  }
}

/**
 * The health endpoint must not be readable without the secret.
 *
 * Checked every time rather than assumed: it lists which dependencies exist
 * and how they are wired, which is a map worth keeping private, and an auth
 * check that silently stops working is the kind of thing nobody notices.
 */
async function checkHealthIsProtected(): Promise<boolean> {
  try {
    const res = await fetch(`${BASE}/api/health`);
    if (res.status === 401) {
      console.log("  ✓ /api/health pide autenticación");
      return true;
    }
    console.log(`  ✗ /api/health respondió ${res.status} SIN autenticación`);
    return false;
  } catch {
    console.log("  ✗ no se pudo consultar /api/health");
    return false;
  }
}

/**
 * Wait until the alias is serving the deployment we were asked about.
 *
 * Returns false if it never arrives, which is itself a failure worth
 * reporting: the deploy said success and the traffic is still going somewhere
 * else.
 */
async function waitForCommit(expected: string): Promise<boolean> {
  const deadline = Date.now() + WAIT_FOR_ALIAS_MS;
  let last: string | null = null;

  while (Date.now() < deadline) {
    try {
      const res = await fetch(`${BASE}/api/health`, {
        headers: { Authorization: `Bearer ${SECRET}` },
      });
      const body = (await res.json()) as { commit?: string | null };
      last = body.commit ?? null;
      if (last === expected) {
        console.log(`  ✓ sirviendo el commit ${expected}`);
        return true;
      }
    } catch {
      // Still coming up. Keep waiting.
    }
    await new Promise((r) => setTimeout(r, 5_000));
  }

  console.log(
    `  ✗ tras 3 minutos sigue sirviendo ${last ?? "algo desconocido"}, esperaba ${expected}`
  );
  return false;
}

async function main() {
  let failures = 0;

  console.log("Alcance:");
  if (!(await checkReachable())) failures++;
  if (!(await checkHealthIsProtected())) failures++;
  if (EXPECT_COMMIT && !(await waitForCommit(EXPECT_COMMIT))) failures++;

  console.log("\nDependencias:");
  let body: {
    status: string;
    commit: string | null;
    environment: string;
    checks: Check[];
  };

  try {
    const res = await fetch(`${BASE}/api/health${deep ? "?deep=1" : ""}`, {
      headers: { Authorization: `Bearer ${SECRET}` },
    });

    if (res.status === 401) {
      console.log("  ✗ CRON_SECRET local no coincide con el de producción");
      process.exit(1);
    }

    body = await res.json();
  } catch (err) {
    console.log(`  ✗ ${err instanceof Error ? err.message : "no se pudo consultar"}`);
    process.exit(1);
  }

  for (const check of body.checks ?? []) {
    console.log(`  ${MARK[check.status]} ${check.name}: ${check.detail}`);
    if (check.status === "down") failures++;
  }

  const version = body.commit ? `commit ${body.commit}` : "commit desconocido";
  console.log(`\n${"─".repeat(60)}`);
  console.log(`${body.environment} · ${version}`);

  if (failures === 0) {
    const degraded = (body.checks ?? []).filter((c) => c.status === "degraded");
    if (degraded.length > 0) {
      console.log(`✓ nada roto. ${degraded.length} con advertencia (marcadas con !).`);
    } else {
      console.log("✓ todo en orden.");
    }
    if (!deep) console.log("  (corré con --deep para probar R2 y el modelo de verdad)");
  } else {
    console.log(`✗ ${failures} problema(s). No lo dejes así.`);
  }

  // exitCode rather than exit(): calling process.exit() while sockets are
  // still closing crashes Node on Windows with a libuv assertion, which looks
  // exactly like the run failing and is only the process leaving.
  process.exitCode = failures === 0 ? 0 : 1;
}

await main();
