/**
 * POST /api/cases/:id/confirm-training — sólo acepta corridas del mismo caso.
 *
 * Antes, `agent_run_id` se pasaba directo a `approveTrainingExample` sin
 * comprobar que el run fuera de ESTE caso: alguien con acceso a un caso propio
 * podía aprobar como ejemplo de referencia un run de otro caso del mismo
 * inquilino, sólo adivinando su id.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { NextRequest } from "next/server";

const { mockEntrar, mockApprove, mockGetLatestAgentRun, selectQueue } = vi.hoisted(() => ({
  mockEntrar: vi.fn(),
  mockApprove: vi.fn(),
  mockGetLatestAgentRun: vi.fn(),
  selectQueue: [] as unknown[][],
}));

vi.mock("server-only", () => ({}));
vi.mock("@/lib/api/entrada", () => ({ entrar: mockEntrar }));
vi.mock("@/lib/auth/require-role", async () => ({
  TRAINING_APPROVER_ROLES: (await import("@/lib/auth/roles")).TRAINING_APPROVER_ROLES,
}));
vi.mock("@/lib/rate-limit/index", () => ({
  RATE_LIMIT_CONFIGS: { CASES_API: { limit: 100, windowMs: 60_000 } },
}));
vi.mock("@/server/training/examples", () => ({ approveTrainingExample: mockApprove }));
vi.mock("@/server/training/agent-runs", () => ({ getLatestAgentRun: mockGetLatestAgentRun }));
vi.mock("@/lib/db", () => ({ db: {} }));
vi.mock("@/lib/db/schema", () => ({
  cases: { id: "id" },
  agentRuns: { id: "id", case_id: "case_id" },
}));
// Cada llamada a `enTenant` corre contra un `db` de juguete que devuelve, en
// orden, lo que cada test cargó en `selectQueue` — una fila por `select()`.
const fakeDb = {
  select: () => ({
    from: () => ({
      where: () => ({
        limit: () => Promise.resolve(selectQueue.shift() ?? []),
      }),
    }),
  }),
};

vi.mock("@/data/scope", async () => (await import("../mocks/puente-de-alcance")).puenteDeAlcance(() => fakeDb));

import { POST } from "@/app/api/cases/[id]/confirm-training/route";

const CASE_ID = "123e4567-e89b-12d3-a456-426614174001";
const OTRO_RUN_ID = "223e4567-e89b-12d3-a456-426614174002";
const MISMO_RUN_ID = "323e4567-e89b-12d3-a456-426614174003";
const TENANT_ID = "10000000-0000-0000-0000-000000000001";
const USER_ID = "20000000-0000-0000-0000-000000000001";

function llamar(agentRunId: string) {
  return POST(
    new NextRequest(`http://localhost/api/cases/${CASE_ID}/confirm-training`, {
      method: "POST",
      body: JSON.stringify({ agent_run_id: agentRunId }),
    }),
    { params: Promise.resolve({ id: CASE_ID }) }
  );
}

describe("POST /api/cases/:id/confirm-training — sólo el mismo caso", () => {
  beforeEach(() => {
    selectQueue.length = 0;
    mockEntrar.mockResolvedValue({
      ctx: {
        user: { id: USER_ID },
        userRow: { id: USER_ID, tenant_id: TENANT_ID, role: "admin" },
      },
      rl: { allowed: true, remaining: 0, retryAfterSeconds: 60 },
    });
    mockApprove.mockResolvedValue({ ok: true, exampleId: "ejemplo-1" });
    mockGetLatestAgentRun.mockResolvedValue(null);
  });

  afterEach(() => {
    vi.clearAllMocks();
  });

  it("un run de otro caso devuelve 404 y no escribe", async () => {
    // 1) el caso existe en el inquilino; 2) el run no es de ESTE caso.
    selectQueue.push([{ id: CASE_ID }], []);

    const res = await llamar(OTRO_RUN_ID);

    expect(res.status).toBe(404);
    expect(mockApprove).not.toHaveBeenCalled();
  });

  it("un run del mismo caso da 201", async () => {
    selectQueue.push([{ id: CASE_ID }], [{ id: MISMO_RUN_ID }]);

    const res = await llamar(MISMO_RUN_ID);

    expect(res.status).toBe(201);
    expect(mockApprove).toHaveBeenCalledWith(
      expect.objectContaining({ agentRunId: MISMO_RUN_ID, tenantId: TENANT_ID })
    );
  });
});
