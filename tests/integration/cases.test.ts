/**
 * Integration tests for cases API routes.
 *
 * Tests the cases REST API with a running Next.js server.
 * Covers: list, detail, patch, CSV export, pagination, filtering, FSM transitions.
 *
 * AC9:  GET /api/cases is RLS-isolated by tenant_id.
 * AC10: IDOR — wrong-tenant case ID returns 404 (not 403).
 * AC11: Filter by claim type returns only matching cases.
 * AC12: Pagination per_page caps at 100.
 * AC13: CSV export with formula-injection guard.
 * AC14: Case detail includes extracted_fields, missing_docs, audit_log.
 * AC15: PATCH case status writes audit_log; wrong-tenant PATCH returns 404.
 *
 * NOTE: These tests run against a live Next.js server.
 * Run with INTEGRATION_ENABLED=true and a seeded Neon instance.
 * They are excluded from the unit test run (vitest.config.ts).
 */

import { describe, it, expect, beforeEach } from "vitest";
import { clearAllRateLimits } from "@/lib/rate-limit/memory";

const BASE_URL = process.env.TEST_BASE_URL ?? "http://localhost:3000";
const TEST_EMAIL = process.env.INTEGRATION_TEST_EMAIL ?? "lucia@seguros-del-sur.com.ar";
const TEST_PASSWORD = process.env.INTEGRATION_TEST_PASSWORD ?? "Analyst123!";

// Skip all tests if no server is available.
const shouldSkip = !process.env.TEST_BASE_URL && !process.env.INTEGRATION_ENABLED;

// ── Helper: sign in and extract cookies ──────────────────────────────────────

/**
 * La sesión, una sola vez para todo el archivo.
 *
 * Antes cada test iniciaba sesión de nuevo, y desde que el endpoint tiene techo
 * —cinco intentos cada diez segundos— el sexto test se comía un 429 y a partir
 * de ahí fallaba todo. El techo no está de más: es la defensa contra adivinar
 * contraseñas, y hasta hoy no existía en la ruta HTTP.
 *
 * Reusar la cookie tampoco es un truco para esquivarlo: es lo que hace
 * cualquier cliente de verdad. Un navegador inicia sesión una vez y manda la
 * misma cookie durante toda la tarde.
 */
let cookieMemorizada: string | null = null;

async function signIn(email = TEST_EMAIL, password = TEST_PASSWORD): Promise<string> {
  if (email === TEST_EMAIL && cookieMemorizada) return cookieMemorizada;
  const res = await fetch(`${BASE_URL}/api/auth/sign-in/email`, {
    method: "POST",
    headers: { "Content-Type": "application/json",
        // Un navegador SIEMPRE manda Origin; `fetch` de Node no.
        // Better Auth exige la cabecera en todo pedido que cambia estado
        // —es su defensa contra CSRF— y sin ella responde
        // MISSING_OR_NULL_ORIGIN. Mandarla no debilita nada: es lo que hace
        // el navegador de un analista.
        Origin: BASE_URL },
    body: JSON.stringify({ email, password }),
  });
  // Extract Set-Cookie header for subsequent requests
  const setCookie = res.headers.get("set-cookie") ?? "";
  if (!setCookie) {
    throw new Error(
      `sign-in did not return a session cookie (${res.status}). ` +
        `Sembrá la base con \`pnpm sembrar\` y levantá el servidor.`
    );
  }
  if (email === TEST_EMAIL) cookieMemorizada = setCookie;
  return setCookie;
}

// ── GET /api/cases — list ─────────────────────────────────────────────────────

describe.skipIf(shouldSkip)("GET /api/cases", () => {
  beforeEach(() => clearAllRateLimits());

  it("AC2: returns 401 without session", async () => {
    const res = await fetch(`${BASE_URL}/api/cases`);
    expect(res.status).toBe(401);
    const body = await res.json();
    expect(body.error.code).toBe("MISSING_SESSION");
  });

  it("AC9: returns 200 with data and meta for authenticated user", async () => {
    const cookie = await signIn();
    const res = await fetch(`${BASE_URL}/api/cases`, {
      headers: { Cookie: cookie },
    });
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body).toHaveProperty("data");
    expect(body).toHaveProperty("meta");
    expect(body.meta).toHaveProperty("total");
    expect(body.meta).toHaveProperty("page");
    expect(body.meta).toHaveProperty("per_page");
    expect(body.meta).toHaveProperty("pages");
    expect(Array.isArray(body.data)).toBe(true);
  });

  it("AC9: response does NOT include cases from other tenants (RLS isolation)", async () => {
    // Rely on RLS: if the seed only has 1 tenant, all returned cases must have the same tenant_id.
    const cookie = await signIn();
    const res = await fetch(`${BASE_URL}/api/cases`, {
      headers: { Cookie: cookie },
    });
    expect(res.status).toBe(200);
    const body = await res.json();
    const tenantIds = body.data.map((c: { tenant_id: string }) => c.tenant_id);
    const uniqueTenants = new Set(tenantIds);
    // All cases must belong to the same (single) tenant
    expect(uniqueTenants.size).toBeLessThanOrEqual(1);
  });

  it("AC11: filter by claim type returns only matching cases", async () => {
    const cookie = await signIn();
    const res = await fetch(`${BASE_URL}/api/cases?type=choque`, {
      headers: { Cookie: cookie },
    });
    expect(res.status).toBe(200);
    const body = await res.json();
    for (const c of body.data) {
      expect(c.claim_type).toBe("choque");
    }
  });

  it("AC12: per_page=10000 is rejected as validation error (Zod max=100)", async () => {
    const cookie = await signIn();
    const res = await fetch(`${BASE_URL}/api/cases?per_page=10000`, {
      headers: { Cookie: cookie },
    });
    // Zod rejects per_page > 100 with 400 VALIDATION_FAILED
    expect(res.status).toBe(400);
    const body = await res.json();
    expect(body.error.code).toBe("VALIDATION_FAILED");
  });

  it("AC12: per_page=100 is accepted (boundary value)", async () => {
    const cookie = await signIn();
    const res = await fetch(`${BASE_URL}/api/cases?per_page=100`, {
      headers: { Cookie: cookie },
    });
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.meta.per_page).toBe(100);
    expect(body.data.length).toBeLessThanOrEqual(100);
  });

  it("rejects invalid sort column (SQL injection prevention)", async () => {
    const cookie = await signIn();
    const res = await fetch(
      `${BASE_URL}/api/cases?sort=id%3B%20DROP%20TABLE%20cases`,
      { headers: { Cookie: cookie } }
    );
    expect(res.status).toBe(400);
    const body = await res.json();
    expect(body.error.code).toBe("VALIDATION_FAILED");
  });

  it("accepts sort=confidence_min&order=asc", async () => {
    const cookie = await signIn();
    const res = await fetch(
      `${BASE_URL}/api/cases?sort=confidence_min&order=asc`,
      { headers: { Cookie: cookie } }
    );
    expect(res.status).toBe(200);
  });

  it("filters by status=listo", async () => {
    const cookie = await signIn();
    const res = await fetch(`${BASE_URL}/api/cases?status=listo`, {
      headers: { Cookie: cookie },
    });
    expect(res.status).toBe(200);
    const body = await res.json();
    for (const c of body.data) {
      expect(c.status).toBe("listo");
    }
  });
});

// ── GET /api/cases/:id — detail ───────────────────────────────────────────────

describe.skipIf(shouldSkip)("GET /api/cases/:id", () => {
  beforeEach(() => clearAllRateLimits());

  it("AC2: returns 401 without session", async () => {
    const res = await fetch(`${BASE_URL}/api/cases/00000000-0000-0000-0000-000000000001`);
    expect(res.status).toBe(401);
  });

  it("AC10: returns 404 for non-existent case (not 403)", async () => {
    const cookie = await signIn();
    const res = await fetch(
      `${BASE_URL}/api/cases/00000000-dead-beef-0000-000000000001`,
      { headers: { Cookie: cookie } }
    );
    expect(res.status).toBe(404);
    const body = await res.json();
    expect(body.error.code).toBe("NOT_FOUND");
  });

  it("returns 404 (not 403) for valid UUID belonging to another tenant (IDOR)", async () => {
    // If the case UUID exists in the DB but belongs to another tenant,
    // RLS makes it invisible — the result is 404, same as non-existent.
    const cookie = await signIn();
    // Use a UUID that is unlikely to exist in the test tenant
    const res = await fetch(
      `${BASE_URL}/api/cases/aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa`,
      { headers: { Cookie: cookie } }
    );
    // Must be 404, never 403
    expect(res.status).toBe(404);
    const body = await res.json();
    expect(body.error.code).toBe("NOT_FOUND");
  });

  it("AC14: returns case with extracted_fields, missing_docs, audit_log for valid case", async () => {
    // First, get a valid case ID from the list endpoint.
    const cookie = await signIn();
    const listRes = await fetch(`${BASE_URL}/api/cases?per_page=1`, {
      headers: { Cookie: cookie },
    });
    const listBody = await listRes.json();

    if (listBody.data.length === 0) {
      // No cases in the DB — skip this assertion.
      return;
    }

    const caseId = listBody.data[0].id;
    const res = await fetch(`${BASE_URL}/api/cases/${caseId}`, {
      headers: { Cookie: cookie },
    });
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body).toHaveProperty("case");
    expect(body).toHaveProperty("extracted_fields");
    expect(body).toHaveProperty("missing_docs");
    expect(body).toHaveProperty("audit_log");
    expect(Array.isArray(body.extracted_fields)).toBe(true);
    expect(Array.isArray(body.missing_docs)).toBe(true);
    expect(Array.isArray(body.audit_log)).toBe(true);
    // Audit log limited to 20 entries
    expect(body.audit_log.length).toBeLessThanOrEqual(20);
  });

  it("returns 404 for malformed (non-UUID) case ID", async () => {
    const cookie = await signIn();
    const res = await fetch(`${BASE_URL}/api/cases/not-a-uuid`, {
      headers: { Cookie: cookie },
    });
    expect(res.status).toBe(404);
  });
});

// ── PATCH /api/cases/:id — update ────────────────────────────────────────────

describe.skipIf(shouldSkip)("PATCH /api/cases/:id", () => {
  beforeEach(() => clearAllRateLimits());

  it("AC2: returns 401 without session", async () => {
    const res = await fetch(
      `${BASE_URL}/api/cases/00000000-0000-0000-0000-000000000001`,
      {
        method: "PATCH",
        headers: { "Content-Type": "application/json",
        // Un navegador SIEMPRE manda Origin; `fetch` de Node no.
        // Better Auth exige la cabecera en todo pedido que cambia estado
        // —es su defensa contra CSRF— y sin ella responde
        // MISSING_OR_NULL_ORIGIN. Mandarla no debilita nada: es lo que hace
        // el navegador de un analista.
        Origin: BASE_URL },
        body: JSON.stringify({ status: "cerrado" }),
      }
    );
    expect(res.status).toBe(401);
  });

  it("AC15: returns 404 for non-existent case (IDOR prevention)", async () => {
    const cookie = await signIn();
    const res = await fetch(
      `${BASE_URL}/api/cases/00000000-dead-beef-0000-000000000001`,
      {
        method: "PATCH",
        headers: {
          "Content-Type": "application/json",
          Cookie: cookie,
        },
        body: JSON.stringify({ status: "listo" }),
      }
    );
    expect(res.status).toBe(404);
    const body = await res.json();
    expect(body.error.code).toBe("NOT_FOUND");
  });

  it("returns 400 for empty patch body (Zod refine: at least one field)", async () => {
    const cookie = await signIn();
    // Get a valid case ID first
    const listRes = await fetch(`${BASE_URL}/api/cases?per_page=1`, {
      headers: { Cookie: cookie },
    });
    const listBody = await listRes.json();
    if (listBody.data.length === 0) return;

    const caseId = listBody.data[0].id;
    const res = await fetch(`${BASE_URL}/api/cases/${caseId}`, {
      method: "PATCH",
      headers: {
        "Content-Type": "application/json",
        Cookie: cookie,
      },
      body: JSON.stringify({}),
    });
    expect(res.status).toBe(400);
    const body = await res.json();
    expect(body.error.code).toBe("VALIDATION_FAILED");
  });

  it("returns 409 FSM_INVALID_TRANSITION for invalid status transition", async () => {
    // Find a 'cerrado' case to attempt cerrado → procesando (terminal → anything)
    const cookie = await signIn();
    const listRes = await fetch(`${BASE_URL}/api/cases?status=cerrado&per_page=1`, {
      headers: { Cookie: cookie },
    });
    const listBody = await listRes.json();
    if (listBody.data.length === 0) return; // No cerrado cases in seed

    const caseId = listBody.data[0].id;
    const res = await fetch(`${BASE_URL}/api/cases/${caseId}`, {
      method: "PATCH",
      headers: {
        "Content-Type": "application/json",
        Cookie: cookie,
      },
      body: JSON.stringify({ status: "procesando" }),
    });
    expect(res.status).toBe(409);
    const body = await res.json();
    expect(body.error.code).toBe("FSM_INVALID_TRANSITION");
  });

  it("AC15: successful PATCH returns updated case object", async () => {
    // Find a 'listo' case to transition to 'escalado'
    const cookie = await signIn();
    const listRes = await fetch(`${BASE_URL}/api/cases?status=listo&per_page=1`, {
      headers: { Cookie: cookie },
    });
    const listBody = await listRes.json();
    if (listBody.data.length === 0) return;

    const caseId = listBody.data[0].id;
    const res = await fetch(`${BASE_URL}/api/cases/${caseId}`, {
      method: "PATCH",
      headers: {
        "Content-Type": "application/json",
        Cookie: cookie,
      },
      body: JSON.stringify({ status: "escalado", reason: "manual escalation" }),
    });

    // Could be 200 (success) or 404 (analyst doesn't own it) depending on seed data
    expect([200, 404]).toContain(res.status);

    if (res.status === 200) {
      const body = await res.json();
      expect(body).toHaveProperty("case");
      expect(body.case.status).toBe("escalado");
    }
  });
});

// ── GET /api/cases/export.csv — CSV export ────────────────────────────────────

describe.skipIf(shouldSkip)("GET /api/cases/export.csv", () => {
  beforeEach(() => clearAllRateLimits());

  it("AC2: returns 401 without session", async () => {
    const res = await fetch(`${BASE_URL}/api/cases/export.csv`);
    expect(res.status).toBe(401);
  });

  it("AC13: returns 200 with text/csv content type", async () => {
    const cookie = await signIn();
    const res = await fetch(`${BASE_URL}/api/cases/export.csv`, {
      headers: { Cookie: cookie },
    });
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toContain("text/csv");
  });

  it("AC13: response has Content-Disposition: attachment", async () => {
    const cookie = await signIn();
    const res = await fetch(`${BASE_URL}/api/cases/export.csv`, {
      headers: { Cookie: cookie },
    });
    expect(res.status).toBe(200);
    const disposition = res.headers.get("content-disposition") ?? "";
    expect(disposition).toContain("attachment");
    expect(disposition).toContain("casos_");
    expect(disposition).toContain(".csv");
  });

  it("AC13: CSV has correct header row", async () => {
    const cookie = await signIn();
    const res = await fetch(`${BASE_URL}/api/cases/export.csv`, {
      headers: { Cookie: cookie },
    });
    expect(res.status).toBe(200);
    const text = await res.text();
    const firstLine = text.split("\r\n")[0];
    expect(firstLine).toContain("Nro. Siniestro");
    expect(firstLine).toContain("Asegurado");
    expect(firstLine).toContain("Póliza");
    expect(firstLine).toContain("Tipo");
    expect(firstLine).toContain("Estado");
    expect(firstLine).toContain("Confianza");
    expect(firstLine).toContain("Fecha");
    expect(firstLine).toContain("Analista");
  });

  it("AC13: CSV line count = 1 header + N data rows", async () => {
    const cookie = await signIn();
    // Get list count first
    const listRes = await fetch(`${BASE_URL}/api/cases`, {
      headers: { Cookie: cookie },
    });
    const listBody = await listRes.json();
    const total = Math.min(listBody.meta.total, 1000);

    const res = await fetch(`${BASE_URL}/api/cases/export.csv`, {
      headers: { Cookie: cookie },
    });
    const text = await res.text();
    const lines = text.split("\r\n").filter((l) => l.length > 0);
    // 1 header + total data rows (total may be 0 if no cases)
    expect(lines.length).toBe(total + 1);
  });

  it("accepts valid filters (status=listo&type=choque)", async () => {
    const cookie = await signIn();
    const res = await fetch(
      `${BASE_URL}/api/cases/export.csv?status=listo&type=choque`,
      { headers: { Cookie: cookie } }
    );
    expect(res.status).toBe(200);
  });
});

// ── IDOR abuse cases ──────────────────────────────────────────────────────────

describe.skipIf(shouldSkip)("IDOR abuse cases (AC10)", () => {
  beforeEach(() => clearAllRateLimits());

  it("probing non-existent UUIDs returns 404, never 403", async () => {
    const cookie = await signIn();
    const probes = [
      "00000000-0000-0000-0000-000000000099",
      "ffffffff-ffff-ffff-ffff-ffffffffffff",
      "12345678-1234-1234-1234-123456789012",
    ];
    for (const uuid of probes) {
      const res = await fetch(`${BASE_URL}/api/cases/${uuid}`, {
        headers: { Cookie: cookie },
      });
      expect(res.status).toBe(404);
      const body = await res.json();
      // Must be NOT_FOUND — never FORBIDDEN_ROLE or any 4xx that reveals existence
      expect(body.error.code).toBe("NOT_FOUND");
    }
  });
});
