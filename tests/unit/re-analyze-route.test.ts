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
vi.mock("@/data/scope", () => import("../mocks/puente-de-alcance").then((m) => m.puenteSobreLibDb()));

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

/*
 * La sesión, que ahora la ruta mira antes que nada.
 *
 * `entrar()` la pide una sola vez y con ella lanza en paralelo la fila de
 * `users` y el cupo. La lectura de la sesión salió de adentro de
 * `require-role`, así que su mock ya no la arrastra.
 */
vi.mock("@/lib/auth/session", () => ({
  getSessionContext: vi.fn().mockResolvedValue({ user: { id: "user-1" } }),
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

function makeRequest(body?: unknown) {
  return new NextRequest(`http://localhost/api/cases/${CASE_ID}/re-analyze`, {
    method: "POST",
    headers: {
      "user-agent": "vitest",
      "x-forwarded-for": "127.0.0.1",
      ...(body === undefined ? {} : { "content-type": "application/json" }),
    },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
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
      makeSelectChain([{ id: CASE_ID, status: "listo_para_core", assigned_to: null, extraction_lease_at: null, extraction_pending: false }])
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
    // «Para responder» lo saca sólo una persona: si la re-extracción falla o
    // escala, el mensaje pendiente no se pierde.
    expect(mockDb.update.mock.results[0].value.set.mock.calls[0][0]).not.toHaveProperty(
      "para_responder_desde"
    );

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
      makeSelectChain([{ id: CASE_ID, status: "escalado", assigned_to: null, extraction_lease_at: null, extraction_pending: false }])
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

  it("returns FSM_INVALID_TRANSITION when the reset update matches no rows (el caso cambió en la carrera)", async () => {
    mockDb.update.mockReturnValue(makeUpdateChain([]));

    const res = await POST(makeRequest(), {
      params: Promise.resolve({ id: CASE_ID }),
    });

    expect(res.status).toBe(409);
    await expect(res.json()).resolves.toMatchObject({
      error: { code: "FSM_INVALID_TRANSITION" },
    });
    expect(mockAfter).not.toHaveBeenCalled();
    expect(mockRunIntakeAgent).not.toHaveBeenCalled();
  });

  it("does not re-analyze a case already sent to core, and does not update", async () => {
    mockDb.select.mockReturnValue(
      makeSelectChain([{ id: CASE_ID, status: "enviado_a_core", assigned_to: null, extraction_lease_at: null, extraction_pending: false }])
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

  it.each(["en_liquidacion", "pagado", "rechazado"])(
    "does not re-analyze a %s case, not even an admin (B25: settlement is human-only)",
    async (status) => {
      // Admin is the default in beforeEach (role: "admin")
      mockDb.select.mockReturnValue(
        makeSelectChain([{ id: CASE_ID, status, assigned_to: null, extraction_lease_at: null, extraction_pending: false }])
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
    }
  );

  it("does not schedule the agent for closed cases", async () => {
    // Return a closed case
    mockDb.select.mockReturnValue(
      makeSelectChain([{ id: CASE_ID, status: "cerrado", assigned_to: null, extraction_lease_at: null, extraction_pending: false }])
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
      makeSelectChain([{ id: CASE_ID, status: "no_relevante", assigned_to: null, extraction_lease_at: null, extraction_pending: false }])
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

  it("allows owner to re-analyze no_relevante cases (owner cuenta como admin)", async () => {
    mockRequireRole.mockResolvedValue({
      db: mockDb,
      user: { id: USER_ID },
      userRow: { id: USER_ID, tenant_id: TENANT_ID, role: "owner" },
    });
    mockDb.select.mockReturnValue(
      makeSelectChain([{ id: CASE_ID, status: "no_relevante", assigned_to: null, extraction_lease_at: null, extraction_pending: false }])
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
      makeSelectChain([{ id: CASE_ID, status: "no_relevante", assigned_to: null, extraction_lease_at: null, extraction_pending: false }])
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

  describe("«Marcar como relevante» (marcar_relevante)", () => {
    const descartado = {
      id: CASE_ID,
      status: "no_relevante",
      assigned_to: null,
      extraction_lease_at: null,
      extraction_pending: false,
    };

    it("un admin sobre un descartado: pone is_claim en true y deja el motivo en la auditoría", async () => {
      mockDb.select.mockReturnValue(makeSelectChain([descartado]));

      const res = await POST(makeRequest({ marcar_relevante: true }), {
        params: Promise.resolve({ id: CASE_ID }),
      });

      expect(res.status).toBe(202);
      expect(mockDb.update.mock.results[0].value.set.mock.calls[0][0]).toMatchObject({
        status: "procesando",
        is_claim: true,
      });
      expect(mockWriteAuditLog).toHaveBeenCalledWith(
        expect.objectContaining({
          actor_id: USER_ID,
          event_type: "case.re_analyze_triggered",
          payload: { previous_status: "no_relevante", reason: "marcado_relevante" },
        })
      );
      expect(mockAfter).toHaveBeenCalledTimes(1);
    });

    it("un analista recibe FSM_INVALID_TRANSITION y no se escribe nada", async () => {
      mockRequireRole.mockResolvedValue({
        db: mockDb,
        user: { id: USER_ID },
        userRow: { id: USER_ID, tenant_id: TENANT_ID, role: "analyst" },
      });
      mockDb.select.mockReturnValue(makeSelectChain([descartado]));

      const res = await POST(makeRequest({ marcar_relevante: true }), {
        params: Promise.resolve({ id: CASE_ID }),
      });

      expect(res.status).toBe(409);
      await expect(res.json()).resolves.toMatchObject({ error: { code: "FSM_INVALID_TRANSITION" } });
      expect(mockDb.update).not.toHaveBeenCalled();
      expect(mockWriteAuditLog).not.toHaveBeenCalled();
      expect(mockAfter).not.toHaveBeenCalled();
    });

    it("sobre un caso que no está descartado responde 409 y no lo toca", async () => {
      // El default de beforeEach: listo_para_core.
      const res = await POST(makeRequest({ marcar_relevante: true }), {
        params: Promise.resolve({ id: CASE_ID }),
      });

      expect(res.status).toBe(409);
      await expect(res.json()).resolves.toMatchObject({ error: { code: "FSM_INVALID_TRANSITION" } });
      expect(mockDb.update).not.toHaveBeenCalled();
      expect(mockAfter).not.toHaveBeenCalled();
    });

    it("sin el cuerpo, un descartado se re-analiza como siempre: sin is_claim y sin motivo", async () => {
      mockDb.select.mockReturnValue(makeSelectChain([descartado]));

      const res = await POST(makeRequest(), { params: Promise.resolve({ id: CASE_ID }) });

      expect(res.status).toBe(202);
      expect(mockDb.update.mock.results[0].value.set.mock.calls[0][0]).not.toHaveProperty("is_claim");
      expect(mockWriteAuditLog).toHaveBeenCalledWith(
        expect.objectContaining({ payload: { previous_status: "no_relevante" } })
      );
    });

    it("un cuerpo con marcar_relevante distinto de true se rechaza antes de leer el caso", async () => {
      const res = await POST(makeRequest({ marcar_relevante: false }), {
        params: Promise.resolve({ id: CASE_ID }),
      });

      expect(res.status).toBe(400);
      await expect(res.json()).resolves.toMatchObject({ error: { code: "VALIDATION_FAILED" } });
      expect(mockDb.select).not.toHaveBeenCalled();
      expect(mockDb.update).not.toHaveBeenCalled();
    });
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

  // ── E3: un analyst re-analiza sólo un caso suyo o sin asignar ──────────────

  it("returns 404 when an analyst re-analyzes a case assigned to someone else", async () => {
    mockRequireRole.mockResolvedValue({
      db: mockDb,
      user: { id: USER_ID },
      userRow: { id: USER_ID, tenant_id: TENANT_ID, role: "analyst" },
    });
    mockDb.select.mockReturnValue(
      makeSelectChain([
        {
          id: CASE_ID,
          status: "listo_para_core",
          assigned_to: "other-analyst-id",
          extraction_lease_at: null,
          extraction_pending: false,
        },
      ])
    );

    const res = await POST(makeRequest(), {
      params: Promise.resolve({ id: CASE_ID }),
    });

    expect(res.status).toBe(404);
    await expect(res.json()).resolves.toMatchObject({
      error: { code: "NOT_FOUND" },
    });
    expect(mockDb.update).not.toHaveBeenCalled();
  });

  it("allows an analyst to re-analyze an unassigned case", async () => {
    mockRequireRole.mockResolvedValue({
      db: mockDb,
      user: { id: USER_ID },
      userRow: { id: USER_ID, tenant_id: TENANT_ID, role: "analyst" },
    });
    mockDb.select.mockReturnValue(
      makeSelectChain([
        {
          id: CASE_ID,
          status: "listo_para_core",
          assigned_to: null,
          extraction_lease_at: null,
          extraction_pending: false,
        },
      ])
    );

    const res = await POST(makeRequest(), {
      params: Promise.resolve({ id: CASE_ID }),
    });

    expect(res.status).toBe(202);
  });

  it("allows an analyst to re-analyze their own case", async () => {
    mockRequireRole.mockResolvedValue({
      db: mockDb,
      user: { id: USER_ID },
      userRow: { id: USER_ID, tenant_id: TENANT_ID, role: "analyst" },
    });
    mockDb.select.mockReturnValue(
      makeSelectChain([
        {
          id: CASE_ID,
          status: "listo_para_core",
          assigned_to: USER_ID,
          extraction_lease_at: null,
          extraction_pending: false,
        },
      ])
    );

    const res = await POST(makeRequest(), {
      params: Promise.resolve({ id: CASE_ID }),
    });

    expect(res.status).toBe(202);
  });

  it("allows an admin to re-analyze a case assigned to someone else", async () => {
    mockDb.select.mockReturnValue(
      makeSelectChain([
        {
          id: CASE_ID,
          status: "listo_para_core",
          assigned_to: "other-analyst-id",
          extraction_lease_at: null,
          extraction_pending: false,
        },
      ])
    );

    const res = await POST(makeRequest(), {
      params: Promise.resolve({ id: CASE_ID }),
    });

    expect(res.status).toBe(202);
  });

  // ── E4: no se re-analiza mientras el agente sigue trabajando ───────────────

  it("returns FSM_INVALID_TRANSITION with the reservation still alive", async () => {
    mockDb.select.mockReturnValue(
      makeSelectChain([
        {
          id: CASE_ID,
          status: "listo_para_core",
          assigned_to: null,
          extraction_lease_at: new Date(Date.now() - 60_000).toISOString(),
          extraction_pending: false,
        },
      ])
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
    expect(mockWriteAuditLog).not.toHaveBeenCalled();
  });

  it("allows re-analysis with an expired reservation and no pending run", async () => {
    mockDb.select.mockReturnValue(
      makeSelectChain([
        {
          id: CASE_ID,
          status: "listo_para_core",
          assigned_to: null,
          extraction_lease_at: new Date(Date.now() - 10 * 60_000).toISOString(),
          extraction_pending: false,
        },
      ])
    );

    const res = await POST(makeRequest(), {
      params: Promise.resolve({ id: CASE_ID }),
    });

    expect(res.status).toBe(202);
  });

  it("returns FSM_INVALID_TRANSITION with extraction_pending true and no reservation", async () => {
    mockDb.select.mockReturnValue(
      makeSelectChain([
        {
          id: CASE_ID,
          status: "listo_para_core",
          assigned_to: null,
          extraction_lease_at: null,
          extraction_pending: true,
        },
      ])
    );

    const res = await POST(makeRequest(), {
      params: Promise.resolve({ id: CASE_ID }),
    });

    expect(res.status).toBe(409);
    await expect(res.json()).resolves.toMatchObject({
      error: { code: "FSM_INVALID_TRANSITION" },
    });
    expect(mockDb.update).not.toHaveBeenCalled();
  });

  it("a closed case with a live reservation still gets the terminal-state error (that guard runs first)", async () => {
    mockDb.select.mockReturnValue(
      makeSelectChain([
        {
          id: CASE_ID,
          status: "cerrado",
          assigned_to: null,
          extraction_lease_at: new Date(Date.now() - 60_000).toISOString(),
          extraction_pending: false,
        },
      ])
    );

    const res = await POST(makeRequest(), {
      params: Promise.resolve({ id: CASE_ID }),
    });

    expect(res.status).toBe(409);
    await expect(res.json()).resolves.toMatchObject({
      error: { code: "FSM_INVALID_TRANSITION" },
    });
    expect(mockDb.update).not.toHaveBeenCalled();
  });
});
