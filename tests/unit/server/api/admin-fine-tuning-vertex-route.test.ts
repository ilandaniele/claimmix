/**
 * Unit tests for POST /api/admin/fine-tuning/vertex/:id
 *
 * Verifies:
 *  - action="approve" calls approveVertexAiTuningJob con "approved" y responde 200
 *  - action="reject" la llama con "rejected"
 *  - JOB_NOT_EVAL_PENDING responde 400 con el mensaje en español
 *  - una acción desconocida responde 400 (falla el schema)
 */

import { beforeEach, describe, expect, it, vi } from "vitest";
import { NextRequest } from "next/server";

const { mockRequireAdmin, mockApprove } = vi.hoisted(() => ({
  mockRequireAdmin: vi.fn(),
  mockApprove: vi.fn(),
}));

vi.mock("@/lib/auth/require-admin", () => ({
  requireAdmin: mockRequireAdmin,
}));

vi.mock("@/server/training/vertex-ai-fine-tuning", () => ({
  getVertexAiTuningJob: vi.fn(),
  activateVertexAiModel: vi.fn(),
  rollbackVertexAiModel: vi.fn(),
  approveVertexAiTuningJob: mockApprove,
}));

import { POST } from "@/app/api/admin/fine-tuning/vertex/[id]/route";

const TENANT_ID = "10000000-0000-0000-0000-000000000001";
const USER_ID = "20000000-0000-0000-0000-000000000001";
const JOB_ID = "30000000-0000-0000-0000-000000000001";

function makeRequest(action: string) {
  return new NextRequest(`http://localhost/api/admin/fine-tuning/vertex/${JOB_ID}`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ action }),
  });
}

function makeContext() {
  return { params: Promise.resolve({ id: JOB_ID }) };
}

describe("POST /api/admin/fine-tuning/vertex/:id", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockRequireAdmin.mockResolvedValue({
      user: { id: USER_ID },
      userRow: { id: USER_ID, tenant_id: TENANT_ID, role: "admin" },
    });
  });

  it('action="approve" llama a approveVertexAiTuningJob con "approved" y responde 200', async () => {
    mockApprove.mockResolvedValue({ id: JOB_ID, status: "approved" });

    const res = await POST(makeRequest("approve"), makeContext());

    expect(res.status).toBe(200);
    expect(mockApprove).toHaveBeenCalledWith(TENANT_ID, USER_ID, JOB_ID, "approved");
  });

  it('action="reject" la llama con "rejected"', async () => {
    mockApprove.mockResolvedValue({ id: JOB_ID, status: "rejected" });

    await POST(makeRequest("reject"), makeContext());

    expect(mockApprove).toHaveBeenCalledWith(TENANT_ID, USER_ID, JOB_ID, "rejected");
  });

  it("JOB_NOT_EVAL_PENDING responde 400 con el mensaje en español", async () => {
    mockApprove.mockRejectedValue(new Error("JOB_NOT_EVAL_PENDING"));

    const res = await POST(makeRequest("approve"), makeContext());

    expect(res.status).toBe(400);
    const body = await res.json();
    expect(body.error.message).toBe("Sólo se aprueba un entrenamiento terminado y sin revisar.");
  });

  it("una acción desconocida responde 400", async () => {
    const res = await POST(makeRequest("borrar"), makeContext());

    expect(res.status).toBe(400);
    expect(mockApprove).not.toHaveBeenCalled();
  });
});
