/**
 * Reads Gmail + cron env vars from .env.local and pushes them to Vercel production.
 * Run once: node scripts/sync-vercel-env.mjs
 * Requires: vercel CLI logged in (npx vercel whoami should work)
 */
import { readFileSync } from "fs";
import { execSync } from "child_process";
import { resolve, dirname } from "path";
import { fileURLToPath } from "url";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const ENV_PATH = resolve(ROOT, ".env.local");

const VARS_TO_SYNC = [
  "GMAIL_CLIENT_ID",
  "GMAIL_CLIENT_SECRET",
  "GMAIL_REFRESH_TOKEN",
  "GMAIL_USER_EMAIL",
  "GMAIL_FROM_ADDRESS",
  "GMAIL_TENANT_ID",
  "CRON_SECRET",
];

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

for (const varName of VARS_TO_SYNC) {
  const value = parsed[varName];
  if (!value || value.startsWith("<")) {
    console.log(`⏭  ${varName} — not set in .env.local, skipping`);
    skipped++;
    continue;
  }
  try {
    execSync(
      `vercel env add ${varName} production`,
      {
        input: value + "\n",
        stdio: ["pipe", "inherit", "inherit"],
        cwd: ROOT,
      }
    );
    console.log(`✅ ${varName} — set`);
    synced++;
  } catch {
    // Vercel returns non-zero if the var already exists — try rm + add
    try {
      execSync(`vercel env rm ${varName} production --yes`, {
        stdio: "inherit",
        cwd: ROOT,
      });
      execSync(
        `vercel env add ${varName} production`,
        {
          input: value + "\n",
          stdio: ["pipe", "inherit", "inherit"],
          cwd: ROOT,
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
console.log("Run `vercel env ls production` to verify.");
