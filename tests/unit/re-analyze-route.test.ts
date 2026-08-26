import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { NextRequest } from "next/server";

const {
  afterCallbacks,
  mockAfter,
  mockCheckBudget,
  mockGetClientIp,
  mockRateLimit,
  mockRunIntakeAgent,
  mockWriteAuditLog,
  mockRequireRole,
  mockDb,
} = vi.hoisted(() => {
  const afterCallbacks: Array<() => unknown | Promise<unknown>> = [];
  const mockDb = {
    select: vi.fn(),
    update: vi.fn(),
    insert: vi.fn(),
    delete: vi.fn(),
    $count: vi.fn(),
  };
  return {
    afterCallbacks,
    mockAfter: vi.fn((callback: () => unknown | Promise<unknown>) => {
      afterCallbacks.push(callback);
    }),
    mockCheckBudget: vi.fn(),
    mockGetClientIp: vi.fn(),
    mockRateLimit: vi.fn(),
    mockRunIntakeAgent: vi.fn(),
    mockWriteAuditLog: vi.fn(),
    mockRequireRole: vi.fn(),
    mockDb,
  };
});

// La capa de datos, corriendo contra el db que este test ya simula.
//
// Se lee `mod.db` en CADA llamada y no se desestructura: el mock de @/lib/db
// suele exponer `db` con un getter para que los tests puedan intercambiar la
// base simulada entre corridas, y un `const { db } = ...` congelaría el valor
// de la primera llamada.
//
// Lo que NO se prueba acá es que el contexto de inquilino llegue a la base:
// eso se verifica en tests/unit/data-scope-sin-rol.test.ts y, contra bases de
// verdad, en `pnpm capa-datos` y `pnpm tenancy`.
vi.mock("@/data/scope", async () => {
  const mod = await import("@/lib/db");
  return {
    enTenant: (_ctx: unknown, armar: (d: unknown) => unknown) =>
      Promise.resolve(armar(mod.db)),
    enTenantVarias: (_ctx: unknown, armar: (d: unknown) => unknown[]) =>
      Promise.all(armar(mod.db)),
  };
});

vi.mock("server-only", () => ({}));

vi.mock("next/server", async () => {
  const actual = await vi.importActual<typeof import("next/server")>("next/server");
  return {
    ...actual,
    after: mockAfter,
  };
});

vi.mock("@/lib/db", () => ({
  db: mockDb,
  tables: {},
}));

vi.mock("@/lib/auth/require-role", () => ({
  requireRole: mockRequireRole,
  ALL_ROLES: ["owner", "admin", "specialist", "analyst", "viewer"],
}));

vi.mock("@/server/agents/intake-agent", () => ({
  runIntakeAgent: mockRunIntakeAgent,
}));

vi.mock("@/server/ai/budget", () => ({
  checkBudget: mockCheckBudget,
}));

vi.mock("@/lib/audit/log", () => ({
  AuditEvent: {},
  writeAuditLog: mockWriteAuditLog,
}));

vi.mock("@/lib/rate-limit/index", () => ({
  getClientIp: mockGetClientIp,
  rateLimit: mockRateLimit,
}));

import { POST } from "@/app/api/cases/[id]/re-analyze/route";

const CASE_ID = "123e4567-e89b-12d3-a456-426614174001";
const TENANT_ID = "10000000-0000-0000-0000-000000000001";
const USER_ID = "20000000-0000-0000-0000-000000000001";

function makeRequest() {
  return new NextRequest(`http://localhost/api/cases/${CASE_ID}/re-analyze`, {
    method: "POST",
    headers: {
      "user-agent": "vitest",
      "x-forwarded-for": "127.0.0.1",
    },
  });
}

/**
 * Build db.select chain that resolves to the given rows.
 * The route does: db.select({...}).from(...).where(...).limit(1)
 */
function makeSelectChain(rows: unknown[]) {
  const chain: any = {
    from: vi.fn().mockReturnThis(),
    where: vi.fn().mockReturnThis(),
    limit: vi.fn().mockResolvedValue(rows),
  };
  return chain;
}

/**
 * Build db.update chain that resolves successfully.
 * The route does: db.update(cases).set({...}).where(...).returning(...)
 */
function makeUpdateChain(rows: unknown[] = [{ id: CASE_ID, status: "procesando" }]) {
  const chain: any = {
    set: vi.fn().mockReturnValue({
      where: vi.fn().mockReturnValue({
        returning: vi.fn().mockResolvedValue(rows),
      }),
    }),
  };
  return chain;
}

describe("POST /api/cases/:id/re-analyze", () => {
  beforeEach(() => {
    afterCallbacks.length = 0;

    // requireRole resolves with a valid role context (admin user)
    mockRequireRole.mockResolvedValue({
      db: mockDb,
      user: { id: USER_ID },
      userRow: { id: USER_ID, tenant_id: TENANT_ID, role: "admin" },
    });

    // db.select returns a case in "listo_para_core" status by default
    mockDb.select.mockReturnValue(
      makeSelectChain([{ id: CASE_ID, status: "listo_para_core" }])
    );

    // db.update succeeds
    mockDb.update.mockReturnValue(makeUpdateChain());

    mockCheckBudget.mockResolvedValue({ exceeded: false });
    mockGetClientIp.mockReturnValue("127.0.0.1");
    mockRateLimit.mockResolvedValue({
      allowed: true,
      remaining: 4,
      retryAfterSeconds: 0,
    });
    mockRunIntakeAgent.mockResolvedValue({ ok: true, action: "extract_email" });
    mockWriteAuditLog.mockResolvedValue(undefined);
  });

  afterEach(() => {
    vi.clearAllMocks();
  });

  it("returns 202, resets the case, and schedules the intake agent", async () => {
    const res = await POST(makeRequest(), {
      params: Promise.resolve({ id: CASE_ID }),
    });

    expect(res.status).toBe(202);
    await expect(res.json()).resolves.toMatchObject({
      case_id: CASE_ID,
      status: "procesando",
    });

    // db.update was called to reset the case
    expect(mockDb.update).toHaveBeenCalledTimes(1);

    expect(mockWriteAuditLog).toHaveBeenCalledWith(
      expect.objectContaining({
        tenant_id: TENANT_ID,
        actor_id: USER_ID,
        event_type: "case.re_analyze_triggered",
        target_id: CASE_ID,
        payload: { previous_status: "listo_para_core" },
      })
    );

    expect(mockAfter).toHaveBeenCalledTimes(1);
    expect(afterCallbacks).toHaveLength(1);

    await afterCallbacks[0]();

    expect(mockRunIntakeAgent).toHaveBeenCalledWith({
      caseId: CASE_ID,
      tenantId: TENANT_ID,
      userId: USER_ID,
      source: "manual",
    });
  });

  it("re-analyzes an escalated case after resetting it to procesando", async () => {
    mockDb.select.mockReturnValue(
      makeSelectChain([{ id: CASE_ID, status: "escalado" }])
    );

    const res = await POST(makeRequest(), {
      params: Promise.resolve({ id: CASE_ID }),
    });

    expect(res.status).toBe(202);
    expect(mockDb.update).toHaveBeenCalledTimes(1);
    expect(mockWriteAuditLog).toHaveBeenCalledWith(
      expect.objectContaining({
        payload: { previous_status: "escalado" },
      })
    );

    await afterCallbacks[0]();
    expect(mockRunIntakeAgent).toHaveBeenCalledWith({
      caseId: CASE_ID,
      tenantId: TENANT_ID,
      userId: USER_ID,
      source: "manual",
    });
  });

  it("returns a clear error when the reset update does not affect the case", async () => {
    mockDb.update.mockReturnValue(makeUpdateChain([]));

    const res = await POST(makeRequest(), {
      params: Promise.resolve({ id: CASE_ID }),
    });

    expect(res.status).toBe(500);
    await expect(res.json()).resolves.toMatchObject({
      error: { code: "INTERNAL_ERROR" },
    });
    expect(mockAfter).not.toHaveBeenCalled();
    expect(mockRunIntakeAgent).not.toHaveBeenCalled();
  });

  it("does not schedule the agent for closed cases", async () => {
    // Return a closed case
    mockDb.select.mockReturnValue(
      makeSelectChain([{ id: CASE_ID, status: "cerrado" }])
    );

    const res = await POST(makeRequest(), {
      params: Promise.resolve({ id: CASE_ID }),
    });

    expect(res.status).toBe(409);
    await expect(res.json()).resolves.toMatchObject({
      error: { code: "FSM_INVALID_TRANSITION" },
    });
    expect(mockDb.update).not.toHaveBeenCalled();
    expect(mockAfter).not.toHaveBeenCalled();
    expect(mockRunIntakeAgent).not.toHaveBeenCalled();
  });

  it("allows admin to re-analyze no_relevante cases (provider-error recovery)", async () => {
    // Admin is the default in beforeEach (role: "admin")
    mockDb.select.mockReturnValue(
      makeSelectChain([{ id: CASE_ID, status: "no_relevante" }])
    );

    const res = await POST(makeRequest(), {
      params: Promise.resolve({ id: CASE_ID }),
    });

    expect(res.status).toBe(202);
    await expect(res.json()).resolves.toMatchObject({
      case_id: CASE_ID,
      status: "procesando",
    });
    expect(mockDb.update).toHaveBeenCalledTimes(1);
    expect(mockAfter).toHaveBeenCalledTimes(1);
  });

  it("does not allow non-admin analysts to re-analyze no_relevante cases", async () => {
    mockRequireRole.mockResolvedValue({
      db: mockDb,
      user: { id: USER_ID },
      userRow: { id: USER_ID, tenant_id: TENANT_ID, role: "analyst" },
    });
    mockDb.select.mockReturnValue(
      makeSelectChain([{ id: CASE_ID, status: "no_relevante" }])
    );

    const res = await POST(makeRequest(), {
      params: Promise.resolve({ id: CASE_ID }),
    });

    expect(res.status).toBe(409);
    await expect(res.json()).resolves.toMatchObject({
      error: { code: "FSM_INVALID_TRANSITION" },
    });
    expect(mockDb.update).not.toHaveBeenCalled();
    expect(mockAfter).not.toHaveBeenCalled();
    expect(mockRunIntakeAgent).not.toHaveBeenCalled();
  });

  it("returns 401 when requireRole throws (unauthenticated)", async () => {
    const { AppError } = await import("@/lib/errors");
    mockRequireRole.mockRejectedValue(new AppError("MISSING_SESSION"));

    const res = await POST(makeRequest(), {
      params: Promise.resolve({ id: CASE_ID }),
    });

    expect(res.status).toBe(401);
    await expect(res.json()).resolves.toMatchObject({
      error: { code: "MISSING_SESSION" },
    });
    expect(mockRunIntakeAgent).not.toHaveBeenCalled();
  });

  it("returns 403 for viewer role", async () => {
    mockRequireRole.mockResolvedValue({
      db: mockDb,
      user: { id: USER_ID },
      userRow: { id: USER_ID, tenant_id: TENANT_ID, role: "viewer" },
    });

    const res = await POST(makeRequest(), {
      params: Promise.resolve({ id: CASE_ID }),
    });

    expect(res.status).toBe(403);
    await expect(res.json()).resolves.toMatchObject({
      error: { code: "FORBIDDEN_ROLE" },
    });
    expect(mockRunIntakeAgent).not.toHaveBeenCalled();
  });

  it("returns 404 when the case does not belong to the tenant", async () => {
    // db.select returns empty (no case found for this tenant)
    mockDb.select.mockReturnValue(makeSelectChain([]));

    const res = await POST(makeRequest(), {
      params: Promise.resolve({ id: CASE_ID }),
    });

    expect(res.status).toBe(404);
    await expect(res.json()).resolves.toMatchObject({
      error: { code: "NOT_FOUND" },
    });
    expect(mockAfter).not.toHaveBeenCalled();
  });

  it("returns 429 when rate limit is exceeded", async () => {
    mockRateLimit.mockResolvedValue({
      allowed: false,
      remaining: 0,
      retryAfterSeconds: 3600,
    });

    const res = await POST(makeRequest(), {
      params: Promise.resolve({ id: CASE_ID }),
    });

    expect(res.status).toBe(429);
    const body = await res.json();
    expect(body.error.code).toBe("RATE_LIMITED");
    expect(mockAfter).not.toHaveBeenCalled();
  });

  it("returns 429 when AI budget is exceeded", async () => {
    mockCheckBudget.mockResolvedValue({ exceeded: true });

    const res = await POST(makeRequest(), {
      params: Promise.resolve({ id: CASE_ID }),
    });

    expect(res.status).toBe(429);
    await expect(res.json()).resolves.toMatchObject({
      error: { code: "AI_BUDGET_EXCEEDED" },
    });
    expect(mockAfter).not.toHaveBeenCalled();
  });
});
