/**
 * GET /api/admin/health
 *
 * Health check endpoint.
 * AC2: Returns 200 { "status": "ok", "db": "connected" } when Supabase is reachable.
 *
 * This endpoint is:
 * - Public (no auth required) — proxy.ts includes it in PUBLIC_PREFIXES.
 * - Pinged by UptimeRobot every 5 minutes to prevent Supabase free-tier pause.
 *
 * Returns:
 *   200  { status: "ok", db: "connected", env: { supabase: true, ... } }
 *   200  { status: "degraded", db: "error", error: "<code>" } — if DB unreachable
 *        (returns 200 so the load balancer doesn't cycle the instance, but the
 *         status field lets monitoring detect degradation)
 */

import { NextResponse } from "next/server";
import { createServerClient } from "@/lib/supabase/server";

export async function GET() {
  // Check env vars presence (never expose values — boolean only).
  const envChecks = {
    supabase_url: !!process.env.NEXT_PUBLIC_SUPABASE_URL,
    supabase_anon_key: !!process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY,
    supabase_service_role: !!process.env.SUPABASE_SERVICE_ROLE_KEY,
    openai_key: !!process.env.OPENAI_API_KEY,
    mock_ai: process.env.MOCK_AI === "true",
    sentry_dsn: !!process.env.SENTRY_DSN,
  };

  // Ping Supabase DB to check connectivity.
  let dbStatus: "connected" | "error" = "connected";
  let dbError: string | undefined;

  try {
    const supabase = await createServerClient();
    // Use a lightweight query that Supabase handles at the auth layer.
    // This confirms the URL and anon key are valid without touching user data.
    const { error } = await supabase.from("tenants").select("id").limit(1);
    if (error) {
      // Relation "tenants" may not exist yet (before migrations run).
      // Accept PGRST116 (relation does not exist) as "connected but no schema".
      const knownCodes = ["PGRST116", "42P01"];
      if (!knownCodes.includes(error.code ?? "")) {
        dbStatus = "error";
        dbError = error.code ?? "UNKNOWN";
      }
    }
  } catch (e) {
    dbStatus = "error";
    dbError = e instanceof Error ? e.message.slice(0, 50) : "UNKNOWN";
    // Truncate message — never expose full error strings to the response.
  }

  const status = dbStatus === "connected" ? "ok" : "degraded";

  return NextResponse.json(
    {
      status,
      db: dbStatus,
      env: envChecks,
      timestamp: new Date().toISOString(),
      ...(dbError ? { db_error: dbError } : {}),
    },
    { status: 200 }
  );
}
