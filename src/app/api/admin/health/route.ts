/**
 * GET /api/admin/health
 *
 * Health check endpoint — public, no auth required.
 * Proxy.ts includes /api/admin/health in PUBLIC_PREFIXES.
 *
 * Returns:
 *   200  { status: "ok", db: "connected", ai: "mock"|"openai", version, region }
 *   200  { status: "degraded", db: "error", ... }  (200 so LB doesn't cycle)
 *
 * AC16 (security): env checks return booleans only — never exposes key values.
 * Used by UptimeRobot every 5 minutes to prevent Supabase free-tier pause.
 */

import { NextResponse } from "next/server";
import { createServerClient } from "@/lib/supabase/server";
// package.json is a static asset — importing version avoids a runtime read.
import packageJson from "../../../../../package.json";

export async function GET() {
  // ── AI mode ──────────────────────────────────────────────────────────────────
  const aiMode: "mock" | "openai" =
    process.env.MOCK_AI === "true" || !process.env.OPENAI_API_KEY
      ? "mock"
      : "openai";

  // ── DB ping ───────────────────────────────────────────────────────────────────
  let dbStatus: "connected" | "error" = "connected";
  let dbError: string | undefined;

  try {
    const supabase = await createServerClient();
    const { error } = await supabase.from("tenants").select("id").limit(1);
    if (error) {
      // Known codes: schema not yet applied (pre-migration)
      const knownCodes = ["PGRST116", "42P01"];
      if (!knownCodes.includes(error.code ?? "")) {
        dbStatus = "error";
        dbError = error.code ?? "UNKNOWN";
      }
    }
  } catch (e) {
    dbStatus = "error";
    dbError = e instanceof Error ? e.message.slice(0, 50) : "UNKNOWN";
  }

  // ── Response ──────────────────────────────────────────────────────────────────
  const status = dbStatus === "connected" ? "ok" : "degraded";

  // env: boolean presence checks — NEVER expose actual key values (AC16)
  const env = {
    supabase_url: !!process.env.NEXT_PUBLIC_SUPABASE_URL,
    supabase_anon_key: !!process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY,
    openai_api_key: !!process.env.OPENAI_API_KEY,
    sentry_dsn: !!process.env.NEXT_PUBLIC_SENTRY_DSN,
  };

  return NextResponse.json(
    {
      status,
      db: dbStatus,
      ai: aiMode,
      version: packageJson.version,
      region: process.env.VERCEL_REGION ?? "local",
      timestamp: new Date().toISOString(),
      env,
      ...(dbError ? { db_error: dbError } : {}),
    },
    { status: 200 }
  );
}
