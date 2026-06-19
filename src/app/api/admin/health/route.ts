/**
 * GET /api/admin/health
 *
 * Health check endpoint — public, no auth required.
 * Proxy.ts includes /api/admin/health in PUBLIC_PREFIXES.
 *
 * Returns:
 *   200  { status: "ok", db: "connected", ai: "mock"|"gemini"|"openai", version, region }
 *   200  { status: "degraded", db: "error", ... }  (200 so LB doesn't cycle)
 *
 * AC16 (security): env checks return booleans only — never exposes key values.
 * Pinged by an external uptime monitor every 5 minutes.
 */

import { NextResponse } from "next/server";
import { db, tables } from "@/lib/db";
// package.json is a static asset — importing version avoids a runtime read.
import packageJson from "../../../../../package.json";

export async function GET() {
  // ── AI mode ──────────────────────────────────────────────────────────────────
  const preferredProvider = process.env.AI_PROVIDER?.trim().toLowerCase();
  const geminiConfigured = Boolean(process.env.GEMINI_API_KEY?.trim());
  const openaiConfigured = Boolean(process.env.OPENAI_API_KEY?.trim());
  let aiMode: "mock" | "gemini" | "openai" = "mock";
  if (process.env.MOCK_AI !== "true" && process.env.AI_MOCK !== "true") {
    if (preferredProvider === "openai" && openaiConfigured) aiMode = "openai";
    else if (preferredProvider === "gemini" && geminiConfigured) aiMode = "gemini";
    else if (geminiConfigured) aiMode = "gemini";
    else if (openaiConfigured) aiMode = "openai";
  }

  // ── DB ping ───────────────────────────────────────────────────────────────────
  let dbStatus: "connected" | "error" = "connected";
  let dbError: string | undefined;

  try {
    await db.select({ id: tables.tenants.id }).from(tables.tenants).limit(1);
  } catch (e) {
    // Known code: schema not yet applied (pre-migration) — still "connected".
    const code = (e as { code?: string })?.code;
    if (code !== "42P01") {
      dbStatus = "error";
      dbError =
        code ?? (e instanceof Error ? e.message.slice(0, 50) : "UNKNOWN");
    }
  }

  // ── Response ──────────────────────────────────────────────────────────────────
  const status = dbStatus === "connected" ? "ok" : "degraded";

  // env: boolean presence checks — NEVER expose actual key values (AC16)
  const env = {
    database_url: !!process.env.DATABASE_URL,
    gemini_api_key: !!process.env.GEMINI_API_KEY,
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
