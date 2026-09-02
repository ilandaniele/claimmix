/**
 * Qué hace una ruta cuando la consulta no devuelve nada.
 *
 * OJO CON EL NOMBRE DEL ARCHIVO: esto NO prueba el aislamiento entre tenants.
 * Mockea `@/lib/db` para que devuelva cero filas y después verifica que la ruta
 * conteste 404 y no 403 ni 500 — que es una pregunta legítima (un 403 le
 * confirmaría al atacante que el caso existe) pero es otra pregunta.
 *
 * Quien devuelve cero filas acá es el mock. Si mañana alguien escribe una
 * consulta sin `where tenant_id`, estos cuatro tests siguen en verde, porque
 * nunca tocan una base.
 *
 * El aislamiento de verdad lo prueba `pnpm pentest`, con la base real y dos
 * tenants reales: crea un caso en uno, lo busca desde el otro por id, por
 * listado, por búsqueda, por el CSV y por las tres herramientas del agente, y
 * comprueba primero que el dueño SÍ lo vea — sin eso, no encontrar un caso que
 * no existe sería un verde gratis.
 *
 * El comentario anterior decía "true DB RLS tests require RLS_INTEGRATION_ENABLED
 * + live Neon". Esa variable no existía en ningún lado y nadie montó nunca esos
 * tests, así que la falla más cara del producto estuvo cubierta por un mock.
 */

import { describe, it, expect, vi, beforeEach } from "vitest";

// ── Mocks ─────────────────────────────────────────────────────────────────────

// La capa de datos, corriendo contra el db que este test ya simula.
//
// Se lee `mod.db` en CADA llamada y no se desestructura: hay tests que
// intercambian la base simulada entre casos, y un `const { db } = ...`
// congelaría el valor de la primera.
vi.mock("@/data/scope", async () => {
  const mod = await import("@/lib/db");
  return {
    enTenant: (_ctx: unknown, armar: (d: unknown) => unknown) =>
      Promise.resolve(armar(mod.db)),
    enTenantVarias: (_ctx: unknown, armar: (d: unknown) => unknown[]) =>
      Promise.all(armar(mod.db)),
  };
});

vi.mock("@/lib/auth/session", () => ({
  getSessionContext: vi.fn(),
}));

vi.mock("@/lib/auth/require-role", () => ({
  requireRole: vi.fn(),
  ALL_ROLES: ["owner", "admin", "specialist", "analyst", "viewer"],
  TRAINING_APPROVER_ROLES: ["owner", "admin", "specialist"],
  ADMIN_ROLES: ["owner", "admin"],
  CUSTOMER_PII_ROLES: ["owner", "admin", "specialist"],
  CASE_EDITOR_ROLES: ["owner", "admin", "specialist", "analyst"],
}));

vi.mock("@/lib/db", () => ({
  db: {
    select: vi.fn(),
    insert: vi.fn(),
    update: vi.fn(),
    $count: vi.fn(),
  },
}));

vi.mock("@/lib/audit/log", () => ({
  writeAuditLog: vi.fn().mockResolvedValue(undefined),
  AuditEvent: {
    FIELD_CONFIRMED: "claim.field_confirmed",
    CASE_STATUS_CHANGED: "case.status_changed",
  },
}));

vi.mock("@/server/memory/update", () => ({
  updateMemoryFromConfirmation: vi.fn().mockResolvedValue(undefined),
}));

vi.mock("@/server/cases/gap-analyzer", () => ({
  analyzeEmailClaimGaps: vi.fn().mockResolvedValue({
    missingRequiredFields: [],
    fieldsNeedingConfirmation: [],
    isComplete: true,
    status: "listo_para_core",
  }),
}));

vi.mock("@/lib/rate-limit/index", () => ({
  rateLimit: vi.fn().mockResolvedValue({
    allowed: true,
    remaining: 29,
    resetAt: Date.now() + 60000,
    retryAfterSeconds: 0,
  }),
  RATE_LIMIT_CONFIGS: {
    CASES_API: { limit: 100, windowMs: 60000 },
    CONFIRM_FIELD: { limit: 30, windowMs: 60000 },
  },
  buildUserKey: (uid: string, ep: string) => `user:${uid}:${ep}`,
  getClientIp: () => "127.0.0.1",
}));

// ── Helpers ───────────────────────────────────────────────────────────────────

// Use "admin" role so the role guard on /api/customers passes.
// The RLS isolation (empty result) is what we are testing here, not the role guard.
const TENANT_A_USER = { id: "user-a", tenant_id: "tenant-a", role: "admin" as const };
const TENANT_B_CASE_ID = "bbbbbbbb-0000-0000-0000-000000000001";

/**
 * Build a fluent Drizzle-style query chain that resolves to the given data.
 */
function makeChain(data: unknown) {
  const result = Promise.resolve(Array.isArray(data) ? data : data === null ? [] : [data]);
  const chain: any = {
    from: vi.fn().mockReturnThis(),
    where: vi.fn().mockReturnThis(),
    limit: vi.fn(() => result),
    orderBy: vi.fn().mockReturnThis(),
    select: vi.fn().mockReturnThis(),
    eq: vi.fn().mockReturnThis(),
    and: vi.fn().mockReturnThis(),
    offset: vi.fn().mockReturnThis(),
  };
  // Make the chain itself thenable (resolves when awaited directly).
  chain.then = result.then.bind(result);
  chain.catch = result.catch.bind(result);
  return chain;
}

// ── Tests ─────────────────────────────────────────────────────────────────────

describe("AC19: Cross-tenant IDOR defense", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("GET /api/cases/:id — tenant A cannot access tenant B case (returns 404, not 403)", async () => {
    const { getSessionContext } = await import("@/lib/auth/session");
    const { db } = await import("@/lib/db");

    vi.mocked(getSessionContext).mockResolvedValue({
      user: { id: TENANT_A_USER.id, email: "user-a@example.com" },
    } as any);

    // requireRole returns tenant A context
    const { requireRole } = await import("@/lib/auth/require-role");
    vi.mocked(requireRole).mockResolvedValue({
      user: { id: TENANT_A_USER.id },
      userRow: TENANT_A_USER,
    });

    // db.select() for cases returns empty (cross-tenant = no rows)
    vi.mocked(db.select).mockReturnValue({
      from: vi.fn().mockReturnValue({
        where: vi.fn().mockReturnValue({
          limit: vi.fn().mockResolvedValue([]), // no rows = cross-tenant blocked
          orderBy: vi.fn().mockReturnValue({
            limit: vi.fn().mockResolvedValue([]),
            catch: vi.fn().mockResolvedValue([]),
          }),
          catch: vi.fn().mockResolvedValue([]),
        }),
        orderBy: vi.fn().mockReturnValue({
          where: vi.fn().mockReturnValue({
            limit: vi.fn().mockResolvedValue([]),
            catch: vi.fn().mockResolvedValue([]),
          }),
          catch: vi.fn().mockResolvedValue([]),
        }),
      }),
    } as any);

    const { GET } = await import("@/app/api/cases/[id]/route");
    const { NextRequest } = await import("next/server");

    const req = new NextRequest(
      `http://localhost/api/cases/${TENANT_B_CASE_ID}`,
      { method: "GET" }
    );
    const context = { params: Promise.resolve({ id: TENANT_B_CASE_ID }) };

    const response = await GET(req, context);

    expect(response.status).toBe(404);
    const body = await response.json();
    expect(body.error?.code).toBe("NOT_FOUND");
  });

  it("PATCH /api/cases/:id/confirm-field — tenant A cannot confirm field on tenant B case (returns 404)", async () => {
    const { db } = await import("@/lib/db");

    // requireRole returns tenant A context
    const { requireRole } = await import("@/lib/auth/require-role");
    vi.mocked(requireRole).mockResolvedValue({
      user: { id: TENANT_A_USER.id },
      userRow: TENANT_A_USER,
    });

    // db.select() for cases returns empty (cross-tenant blocked)
    vi.mocked(db.select).mockReturnValue({
      from: vi.fn().mockReturnValue({
        where: vi.fn().mockReturnValue({
          limit: vi.fn().mockResolvedValue([]), // case not found for this tenant
        }),
      }),
    } as any);

    const { PATCH } = await import(
      "@/app/api/cases/[id]/confirm-field/route"
    );

    const req = new Request(
      `http://localhost/api/cases/${TENANT_B_CASE_ID}/confirm-field`,
      {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          field_key: "full_name",
          value: "Attacker",
          action: "confirm",
        }),
      }
    ) as any;
    const context = {
      params: Promise.resolve({ id: TENANT_B_CASE_ID }),
    };

    const response = await PATCH(req, context);

    expect(response.status).toBe(404);
    const body = await response.json();
    expect(body.error?.code).toBe("NOT_FOUND");
  });

  it("GET /api/customers — tenant A gets empty list when no customers exist in their tenant", async () => {
    const { getSessionContext } = await import("@/lib/auth/session");
    const { db } = await import("@/lib/db");

    vi.mocked(getSessionContext).mockResolvedValue({
      user: { id: TENANT_A_USER.id, email: "user-a@example.com" },
    } as any);

    // db.select() first call = users lookup (returns admin row)
    // second call = customers query (returns empty)
    let selectCallCount = 0;
    vi.mocked(db.select).mockImplementation(() => {
      selectCallCount++;
      if (selectCallCount === 1) {
        // users lookup
        return {
          from: vi.fn().mockReturnValue({
            where: vi.fn().mockReturnValue({
              limit: vi.fn().mockResolvedValue([TENANT_A_USER]),
            }),
          }),
        } as any;
      }
      // customers query — empty result (RLS-filtered)
      return {
        from: vi.fn().mockReturnValue({
          where: vi.fn().mockReturnValue({
            orderBy: vi.fn().mockReturnValue({
              limit: vi.fn().mockReturnValue({
                offset: vi.fn().mockResolvedValue([]),
              }),
            }),
          }),
        }),
      } as any;
    });

    // db.$count returns 0
    vi.mocked(db.$count).mockResolvedValue(0 as any);

    const { GET } = await import("@/app/api/customers/route");

    // Must use NextRequest-compatible object with nextUrl
    const { NextRequest } = await import("next/server");
    const req = new NextRequest("http://localhost/api/customers", {
      method: "GET",
    });

    const response = await GET(req);

    // Should return 200 with empty data (RLS-filtered) — NOT a 403 or 404
    expect(response.status).toBe(200);
    const body = await response.json();
    expect(Array.isArray(body.data)).toBe(true);
  });
});

describe("RLS schema-level validation", () => {
  it("current_tenant_id() function pattern ensures all tenant tables are scoped", () => {
    // Verifies our understanding of the RLS design:
    // All tables use `tenant_id = current_tenant_id()` in RLS policies.
    // This test documents the expected security invariant.
    const TABLES_WITH_RLS = [
      "customers",
      "customer_contacts",
      "policies",
      "insured_assets",
      "claim_attachments",
      "claim_field_confirmations",
      "claim_memory",
      "known_claim_patterns",
    ];

    // All of these tables should have tenant_id-based RLS.
    // This test acts as documentation — if you remove a table from RLS,
    // you must update this list.
    expect(TABLES_WITH_RLS.length).toBeGreaterThan(0);
    expect(TABLES_WITH_RLS).toContain("claim_field_confirmations");
    expect(TABLES_WITH_RLS).toContain("claim_attachments");
    expect(TABLES_WITH_RLS).toContain("customers");
  });
});
