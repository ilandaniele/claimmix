/**
 * GET /api/admin/health
 *
 * Health check endpoint — public, no auth required.
 * Proxy.ts includes /api/admin/health in PUBLIC_PREFIXES.
 *
 * Returns:
 *   200  { status: "ok", db: "connected", ai: "mock"|"gemini", version, region }
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
  // ── DB ping ───────────────────────────────────────────────────────────────────
  let dbStatus: "connected" | "error" = "connected";
  let dbError: string | undefined;

  try {
    // sin-inquilino: Sonda de infraestructura: cuenta que la tabla `tenants` responda.
    // No lee datos de nadie, y `tenants` no es de un inquilino sino de todos.
    await db.select({ id: tables.tenants.id }).from(tables.tenants).limit(1);
  } catch (e) {
    // Known code: schema not yet applied (pre-migration) — still "connected".
    const code = (e as { code?: string })?.code;
    if (code !== "42P01") {
      dbStatus = "error";
      dbError = code ?? "UNKNOWN";
    }
  }

  // ── Response ──────────────────────────────────────────────────────────────────
  const status = dbStatus === "connected" ? "ok" : "degraded";

  /*
   * Arriba o abajo, y nada más.
   *
   * Esto devolvía además el transporte del modelo, si había clave del proveedor, la
   * región y si Sentry estaba prendido. Ninguno de esos datos es un secreto por
   * separado; juntos son reconocimiento gratis para cualquiera. El más útil
   * para quien mira desde afuera es el de Sentry: "sentry_dsn: false" dice que
   * nadie se entera de los errores, o sea que se puede probar tranquilo.
   *
   * El monitor de uptime necesita saber si contestamos y si la base está — no
   * cómo está cableado el sistema. Eso vive en /api/health, que pide llave y
   * está protegido justamente por este motivo.
   */
  return NextResponse.json(
    {
      status,
      db: dbStatus,
      version: packageJson.version,
      timestamp: new Date().toISOString(),
      ...(dbError ? { db_error: dbError } : {}),
    },
    { status: 200 }
  );
}
