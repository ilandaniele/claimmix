/**
 * GET /api/cases/:id/agent-run — una consulta relacionada que falla deja su
 * lista vacía, pero la respuesta lo dice (`parcial`) y el log lo registra:
 * «sin valores» no puede ser lo mismo que «no se pudo leer».
 */

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { NextRequest } from "next/server";

const { mockEntrar, mockEnTenant, mockLogError } = vi.hoisted(() => ({
  mockEntrar: vi.fn(),
  mockEnTenant: vi.fn(),
  mockLogError: vi.fn(),
}));

vi.mock("server-only", () => ({}));
vi.mock("@/lib/api/entrada", () => ({ entrar: mockEntrar }));
vi.mock("@/lib/auth/require-role", async () => ({
  ALL_ROLES: (await import("@/lib/auth/roles")).ALL_ROLES,
}));
vi.mock("@/data/scope", () => ({ enTenant: mockEnTenant }));
vi.mock("@/server/training/agent-runs", () => ({
  getLatestAgentRun: vi.fn().mockResolvedValue(null),
}));
vi.mock("@/server/cases/pii", () => ({ sinPiiSiNoCorresponde: (run: unknown) => run }));
vi.mock("@/lib/observability/logger", () => ({ logger: { error: mockLogError } }));
vi.mock("@/lib/rate-limit/index", () => ({
  RATE_LIMIT_CONFIGS: { CASES_API: { limit: 100, windowMs: 60_000 } },
}));

import { GET } from "@/app/api/cases/[id]/agent-run/route";

const CASE_ID = "123e4567-e89b-12d3-a456-426614174001";
const TENANT_ID = "10000000-0000-0000-0000-000000000001";

function llamar() {
  return GET(new NextRequest(`http://localhost/api/cases/${CASE_ID}/agent-run`), {
    params: Promise.resolve({ id: CASE_ID }),
  });
}

describe("GET /api/cases/:id/agent-run — carga parcial", () => {
  beforeEach(() => {
    mockEntrar.mockResolvedValue({
      ctx: { userRow: { id: "u", tenant_id: TENANT_ID, role: "analyst" } },
      rl: { allowed: true, remaining: 10, retryAfterSeconds: 0 },
    });
    // 1.º el caso; después campos, documentos faltantes y confirmaciones.
    mockEnTenant.mockResolvedValueOnce([{ id: CASE_ID, status: "procesando", is_claim: true }]);
  });

  afterEach(() => {
    vi.clearAllMocks();
  });

  it("con todo leído, parcial es false y no hay log", async () => {
    mockEnTenant.mockResolvedValue([]);
    const body = await (await llamar()).json();
    expect(body.parcial).toBe(false);
    expect(mockLogError).not.toHaveBeenCalled();
  });

  it("una consulta caída deja su lista vacía, marca parcial y se registra", async () => {
    mockEnTenant
      .mockResolvedValueOnce([{ field_key: "marca", field_value: "Ford", confidence: "0.9", extracted_at: null }])
      .mockRejectedValueOnce(Object.assign(new Error("se cayó"), { code: "57P01" }))
      .mockResolvedValueOnce([]);
    const res = await llamar();
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.parcial).toBe(true);
    expect(body.missing_docs).toEqual([]);
    expect(body.extracted_fields).toHaveLength(1);
    expect(mockLogError).toHaveBeenCalledWith(
      expect.objectContaining({ case_id: CASE_ID }),
      "agent_run.consulta_fallo"
    );
  });
});
