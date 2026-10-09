/**
 * Integration tests for POST /api/admin/reprocess-unclassified.
 *
 * AC12: 401 sin credencial interna (o con la equivocada), incluido el header
 *        `X-Internal-Worker: true` que ANTES alcanzaba y ya no — ver
 *        internal-auth.ts. La autorización es CRON_SECRET por Bearer.
 * AC13: con el Bearer correcto → { triggered: N, case_ids: [...] }.
 * AC14: no unclassified cases → 200 { triggered: 0, case_ids: [], failed: [] }.
 * AC15: one fetch fails → that case in failed[], others still triggered.
 *
 * Con BASE_POR_CLIENTE=1 (P10) busca y marca en la base de cada cliente, y el tope de
 * 50 es de toda la llamada.
 *
 * Mocks: @/lib/db, @/server/email/dispatch-url, and global.fetch.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { NextRequest } from "next/server";

// ── Hoisted mocks ─────────────────────────────────────────────────────────────

const { mockGetWorkerBaseUrl } = vi.hoisted(() => ({
  mockGetWorkerBaseUrl: vi.fn(),
}));

// ── Module mocks ──────────────────────────────────────────────────────────────

vi.mock("@/server/email/dispatch-url", () => ({
  getWorkerBaseUrl: mockGetWorkerBaseUrl,
}));

// ── Mock @/lib/db ──────────────────────────────────────────────────────────────

/**
 * A mock Drizzle db whose select().from().where().orderBy().limit() chain
 * resolves to the given cases array (or throws when queryError is set).
 */
function buildMockDb(
  cases: Array<{ id: string; tenant_id: string }> | null,
  queryError: Error | null = null
) {
  const limitFn = vi.fn().mockImplementation(() => {
    if (queryError) return Promise.reject(queryError);
    return Promise.resolve(cases ?? []);
  });

  const orderByFn = vi.fn().mockReturnValue({ limit: limitFn });
  const whereFn = vi.fn().mockReturnValue({ orderBy: orderByFn });
  const fromFn = vi.fn().mockReturnValue({ where: whereFn });
  const selectFn = vi.fn().mockReturnValue({ from: fromFn });

  return {
    select: selectFn,
    limit: limitFn,
    insert: vi.fn().mockReturnValue({ values: vi.fn().mockResolvedValue({ rowCount: 1 }) }),
    update: vi.fn().mockReturnValue({ set: vi.fn().mockReturnValue({ where: vi.fn().mockResolvedValue({ rowCount: 1 }) }) }),
    delete: vi.fn().mockReturnValue({ where: vi.fn().mockResolvedValue({ rowCount: 0 }) }),
    $count: vi.fn().mockResolvedValue(0),
  };
}

// The mock db is a module-level var so tests can swap it out.
let mockDbInstance = buildMockDb([]);

// Las bases de cliente, por nombre, para `dbDeBase` (sólo con BASE_POR_CLIENTE=1).
const basesDeCliente: Record<string, ReturnType<typeof buildMockDb>> = {};

vi.mock("@/lib/db", () => ({
  get db() { return mockDbInstance; },
  dbDeBase: (nombre: string) => basesDeCliente[nombre],
  tables: {
    cases: {
      id: "id",
      tenant_id: "tenant_id",
      channel: "channel",
      status: "status",
      severity: "severity",
      claim_type: "claim_type",
      created_at: "created_at",
    },
  },
}));

// ── Imports (after mocks) ─────────────────────────────────────────────────────

import { POST } from "@/app/api/admin/reprocess-unclassified/route";

// ── Helpers ───────────────────────────────────────────────────────────────────

/** Build a NextRequest with optional auth headers. */
function buildRequest(
  opts: {
    internalWorker?: boolean;
    bearerToken?: string;
  } = {}
): NextRequest {
  const headers: Record<string, string> = {
    "Content-Type": "application/json",
  };
  if (opts.internalWorker) {
    // El header viejo. Se sigue pudiendo mandar; lo que cambió es que ya no
    // autoriza. Los tests de abajo dependen de eso.
    headers["x-internal-worker"] = "true";
  }
  if (opts.bearerToken) {
    headers["authorization"] = `Bearer ${opts.bearerToken}`;
  }
  return new NextRequest("http://localhost:3000/api/admin/reprocess-unclassified", {
    method: "POST",
    headers,
  });
}

/** A resolved 200 fetch response. */
function mockFetchOk() {
  return Promise.resolve(
    new Response(JSON.stringify({ ok: true }), { status: 200 })
  );
}

/** A resolved non-2xx fetch response. */
function mockFetchFail(status = 500) {
  return Promise.resolve(
    new Response(JSON.stringify({ error: "oops" }), { status })
  );
}

// ── Tests ─────────────────────────────────────────────────────────────────────

describe("POST /api/admin/reprocess-unclassified", () => {
  const originalFetch = global.fetch;
  const originalCronSecret = process.env.CRON_SECRET;

  beforeEach(() => {
    vi.clearAllMocks();
    mockGetWorkerBaseUrl.mockReturnValue("http://localhost:3000");
    process.env.CRON_SECRET = "super-secret-cron";
    mockDbInstance = buildMockDb([]);
  });

  afterEach(() => {
    global.fetch = originalFetch;
    process.env.CRON_SECRET = originalCronSecret;
  });

  // ── AC12: Auth enforcement ─────────────────────────────────────────────────

  it("AC12: returns 401 when no auth header is provided", async () => {
    const request = buildRequest(); // no headers
    const response = await POST(request);
    const body = await response.json();

    expect(response.status).toBe(401);
    expect(body.error.code).toBe("UNAUTHORIZED");
  });

  it("AC12: returns 401 when x-internal-worker header is wrong value", async () => {
    const req = new NextRequest("http://localhost:3000/api/admin/reprocess-unclassified", {
      method: "POST",
      headers: { "x-internal-worker": "false" },
    });

    const response = await POST(req);
    const body = await response.json();

    expect(response.status).toBe(401);
    expect(body.error.code).toBe("UNAUTHORIZED");
  });

  it("AC12: el header X-Internal-Worker: true YA NO alcanza", async () => {
    // Era el bypass: un header que manda cualquiera pasaba por credencial. Este
    // test existe para que no vuelva. Esta ruta dispara 50 extracciones reales
    // por llamada, así que el header abierto era también gasto contra la tarjeta.
    const response = await POST(buildRequest({ internalWorker: true }));

    expect(response.status).toBe(401);
  });

  it("AC12: returns 401 when Bearer token is wrong", async () => {
    const req = new NextRequest("http://localhost:3000/api/admin/reprocess-unclassified", {
      method: "POST",
      headers: { authorization: "Bearer wrong-token" },
    });

    const response = await POST(req);
    const body = await response.json();

    expect(response.status).toBe(401);
    expect(body.error.code).toBe("UNAUTHORIZED");
  });

  it("AC12: accepts valid Bearer CRON_SECRET", async () => {
    mockDbInstance = buildMockDb([]);

    const req = new NextRequest("http://localhost:3000/api/admin/reprocess-unclassified", {
      method: "POST",
      headers: { authorization: "Bearer super-secret-cron" },
    });

    const response = await POST(req);
    expect(response.status).toBe(200);
  });

  // ── AC13: Successful dispatch ──────────────────────────────────────────────

  it("AC13: dispatches extract for each unclassified case, returns triggered count and case_ids", async () => {
    const cases = [
      { id: "case-001", tenant_id: "tenant-001" },
      { id: "case-002", tenant_id: "tenant-001" },
      { id: "case-003", tenant_id: "tenant-001" },
    ];

    mockDbInstance = buildMockDb(cases);

    global.fetch = vi.fn().mockResolvedValue(
      new Response(JSON.stringify({ ok: true }), { status: 200 })
    );

    const request = buildRequest({ bearerToken: "super-secret-cron" });
    const response = await POST(request);
    const body = await response.json();

    expect(response.status).toBe(200);
    expect(body.data.triggered).toBe(3);
    expect(body.data.case_ids).toHaveLength(3);
    expect(body.data.case_ids).toEqual(expect.arrayContaining(["case-001", "case-002", "case-003"]));
    expect(body.data.failed).toHaveLength(0);

    // Verify dispatch was called for each case with the correct URL and headers.
    expect(global.fetch).toHaveBeenCalledTimes(3);
    const [callUrl, callInit] = (global.fetch as ReturnType<typeof vi.fn>).mock.calls[0];
    expect(callUrl).toBe("http://localhost:3000/api/worker/extract");
    expect(callInit.method).toBe("POST");
    // Hacia el worker viaja el secreto, no el header adivinable.
    expect(callInit.headers["Authorization"]).toBe("Bearer super-secret-cron");
    expect(callInit.headers["X-Internal-Worker"]).toBeUndefined();
  });

  it("AC13: forwards caseId and tenantId in the dispatch body", async () => {
    const cases = [{ id: "case-abc", tenant_id: "tenant-xyz" }];

    mockDbInstance = buildMockDb(cases);

    global.fetch = vi.fn().mockResolvedValue(
      new Response(JSON.stringify({ ok: true }), { status: 200 })
    );

    const request = buildRequest({ bearerToken: "super-secret-cron" });
    await POST(request);

    const [, callInit] = (global.fetch as ReturnType<typeof vi.fn>).mock.calls[0];
    const dispatchBody = JSON.parse(callInit.body as string);
    expect(dispatchBody.caseId).toBe("case-abc");
    expect(dispatchBody.tenantId).toBe("tenant-xyz");
  });

  // ── AC14: Empty result ─────────────────────────────────────────────────────

  it("AC14: returns 200 with triggered=0 and empty arrays when no unclassified cases exist", async () => {
    mockDbInstance = buildMockDb([]);

    global.fetch = vi.fn(); // should not be called

    const request = buildRequest({ bearerToken: "super-secret-cron" });
    const response = await POST(request);
    const body = await response.json();

    expect(response.status).toBe(200);
    expect(body.data).toEqual({ triggered: 0, case_ids: [], failed: [] });
    expect(global.fetch).not.toHaveBeenCalled();
  });

  it("AC14: returns 200 with triggered=0 when cases is null (no rows)", async () => {
    mockDbInstance = buildMockDb(null);

    global.fetch = vi.fn();

    const request = buildRequest({ bearerToken: "super-secret-cron" });
    const response = await POST(request);
    const body = await response.json();

    expect(response.status).toBe(200);
    expect(body.data).toEqual({ triggered: 0, case_ids: [], failed: [] });
    expect(global.fetch).not.toHaveBeenCalled();
  });

  // ── AC15: Per-case failure isolation ──────────────────────────────────────

  it("AC15: isolates one failing dispatch — that case goes to failed[], others still triggered", async () => {
    const cases = [
      { id: "case-ok-1", tenant_id: "tenant-001" },
      { id: "case-fail", tenant_id: "tenant-001" },
      { id: "case-ok-2", tenant_id: "tenant-001" },
    ];

    mockDbInstance = buildMockDb(cases);

    // The middle case throws a network error; others succeed.
    global.fetch = vi.fn().mockImplementation((_url: string, init: RequestInit) => {
      const body = JSON.parse(init.body as string) as { caseId: string };
      if (body.caseId === "case-fail") {
        return Promise.reject(new Error("Network timeout"));
      }
      return Promise.resolve(new Response(JSON.stringify({ ok: true }), { status: 200 }));
    });

    const request = buildRequest({ bearerToken: "super-secret-cron" });
    const response = await POST(request);
    const body = await response.json();

    expect(response.status).toBe(200);
    expect(body.data.triggered).toBe(2);
    expect(body.data.case_ids).toHaveLength(2);
    expect(body.data.case_ids).toEqual(expect.arrayContaining(["case-ok-1", "case-ok-2"]));
    expect(body.data.failed).toHaveLength(1);
    expect(body.data.failed).toContain("case-fail");
  });

  it("AC15: non-2xx worker response moves case to failed[], does not throw", async () => {
    const cases = [
      { id: "case-ok", tenant_id: "tenant-001" },
      { id: "case-500", tenant_id: "tenant-001" },
    ];

    mockDbInstance = buildMockDb(cases);

    global.fetch = vi.fn().mockImplementation((_url: string, init: RequestInit) => {
      const body = JSON.parse(init.body as string) as { caseId: string };
      if (body.caseId === "case-500") {
        return mockFetchFail(500);
      }
      return mockFetchOk();
    });

    const request = buildRequest({ bearerToken: "super-secret-cron" });
    const response = await POST(request);
    const body = await response.json();

    expect(response.status).toBe(200);
    expect(body.data.triggered).toBe(1);
    expect(body.data.case_ids).toContain("case-ok");
    expect(body.data.failed).toContain("case-500");
  });

  // ── DB error path ──────────────────────────────────────────────────────────

  it("returns 500 INTERNAL_ERROR when db query fails", async () => {
    const dbError = new Error("relation not found");
    (dbError as Error & { code?: string }).code = "PGRST116";
    mockDbInstance = buildMockDb(null, dbError);

    const request = buildRequest({ bearerToken: "super-secret-cron" });
    const response = await POST(request);
    const body = await response.json();

    expect(response.status).toBe(500);
    expect(body.error.code).toBe("INTERNAL_ERROR");
  });
});

describe("POST /api/admin/reprocess-unclassified: una base por cliente (P10)", () => {
  const originalFetch = global.fetch;
  const originalCronSecret = process.env.CRON_SECRET;
  const originalBase = process.env.BASE_POR_CLIENTE;
  const A = "aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee";
  const B = "11111111-2222-3333-4444-555555555555";
  const nombre = (id: string) => `t_${id.replaceAll("-", "")}`;
  const casos = (tenant: string, n: number) =>
    Array.from({ length: n }, (_, i) => ({ id: `caso-${tenant.slice(0, 2)}-${i}`, tenant_id: tenant }));

  beforeEach(() => {
    vi.clearAllMocks();
    mockGetWorkerBaseUrl.mockReturnValue("http://localhost:3000");
    process.env.CRON_SECRET = "super-secret-cron";
    process.env.BASE_POR_CLIENTE = "1";
    global.fetch = vi.fn().mockResolvedValue(new Response(JSON.stringify({ ok: true }), { status: 200 }));
  });

  afterEach(() => {
    global.fetch = originalFetch;
    process.env.CRON_SECRET = originalCronSecret;
    if (originalBase === undefined) delete process.env.BASE_POR_CLIENTE;
    else process.env.BASE_POR_CLIENTE = originalBase;
    vi.restoreAllMocks();
  });

  /** Control lista las dos bases; la hora 0 deja el recorrido en el orden A, B. */
  function conDosBases(deA: number, deB: number) {
    vi.spyOn(Date, "now").mockReturnValue(0);
    mockDbInstance = {
      ...buildMockDb([]),
      execute: vi.fn().mockResolvedValue({ rows: [{ tenant_id: A }, { tenant_id: B }] }),
    } as ReturnType<typeof buildMockDb>;
    basesDeCliente[nombre(A)] = buildMockDb(casos(A, deA));
    basesDeCliente[nombre(B)] = buildMockDb(casos(B, deB));
  }

  it("junta los casos de cada base y marca cada grupo en la base de donde salió", async () => {
    conDosBases(2, 1);

    const response = await POST(buildRequest({ bearerToken: "super-secret-cron" }));
    const body = await response.json();

    expect(body.data.triggered).toBe(3);
    expect(basesDeCliente[nombre(A)].update).toHaveBeenCalledOnce();
    expect(basesDeCliente[nombre(B)].update).toHaveBeenCalledOnce();
    expect(mockDbInstance.update).not.toHaveBeenCalled();
    expect(mockDbInstance.select).not.toHaveBeenCalled();
  });

  it("el tope de 50 es de toda la llamada: la segunda base pide sólo lo que queda", async () => {
    conDosBases(30, 5);

    await POST(buildRequest({ bearerToken: "super-secret-cron" }));

    expect(basesDeCliente[nombre(A)].limit).toHaveBeenCalledWith(50);
    expect(basesDeCliente[nombre(B)].limit).toHaveBeenCalledWith(20);
  });

  it("con el tope ya cumplido no consulta las demás bases", async () => {
    conDosBases(50, 5);

    const response = await POST(buildRequest({ bearerToken: "super-secret-cron" }));
    const body = await response.json();

    expect(body.data.triggered).toBe(50);
    expect(basesDeCliente[nombre(B)].select).not.toHaveBeenCalled();
  });

  it("una base que falla no tira la llamada: se despachan los casos de las otras", async () => {
    conDosBases(0, 2);
    basesDeCliente[nombre(A)] = buildMockDb(null, new Error("la base no existe"));

    const response = await POST(buildRequest({ bearerToken: "super-secret-cron" }));
    const body = await response.json();

    expect(response.status).toBe(200);
    expect(body.data.triggered).toBe(2);
  });
});
