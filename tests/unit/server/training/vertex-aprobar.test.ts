/**
 * `syncVertexAiTuningJobStatus`, `approveVertexAiTuningJob`, `rollbackVertexAiModel`
 * y `listVertexAiTuningJobs` — E18: aprobar antes de activar, y activar nunca
 * arranca un entrenamiento nuevo.
 *
 * Base simulada: `tables` es el esquema real (columnas de Drizzle de verdad),
 * sólo `db.select`/`db.update` están mockeados. Así el WHERE del approve se
 * puede convertir a SQL de verdad con `PgDialect().sqlToQuery()`, igual que en
 * `tests/unit/cases-patch.test.ts`.
 */

import { beforeEach, describe, expect, it, vi } from "vitest";
import { PgDialect } from "drizzle-orm/pg-core";

const { mockSelect, mockUpdate, mockWriteAuditLog, mockTokenDeGcp } = vi.hoisted(() => ({
  mockSelect: vi.fn(),
  mockUpdate: vi.fn(),
  mockWriteAuditLog: vi.fn().mockResolvedValue(undefined),
  mockTokenDeGcp: vi.fn().mockResolvedValue("token-gcp"),
}));

vi.mock("server-only", () => ({}));

vi.mock("@/lib/db", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/db")>();
  return { ...actual, db: { select: mockSelect, update: mockUpdate, insert: vi.fn() } };
});

vi.mock("@/data/scope", async () => {
  const mod = await import("@/lib/db");
  return {
    enTenant: (_ctx: unknown, armar: (d: unknown) => unknown) => Promise.resolve(armar(mod.db)),
  };
});

vi.mock("@/lib/audit/log", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/audit/log")>();
  return { ...actual, writeAuditLog: mockWriteAuditLog };
});

vi.mock("@/server/gcp/credenciales", () => ({ tokenDeGcp: mockTokenDeGcp }));

import {
  syncVertexAiTuningJobStatus,
  approveVertexAiTuningJob,
  rollbackVertexAiModel,
  listVertexAiTuningJobs,
} from "@/server/training/vertex-ai-fine-tuning";

const TENANT = "10000000-0000-0000-0000-000000000001";
const USER = "20000000-0000-0000-0000-000000000002";
const JOB = "30000000-0000-0000-0000-000000000003";

/** Encadena `.from()/.where()/.orderBy()/.limit()` y resuelve en `rows`. */
function selectChain(rows: unknown[]) {
  const chain = {
    from: () => chain,
    where: () => chain,
    orderBy: () => chain,
    limit: () => Promise.resolve(rows),
  };
  return chain;
}

/** Encadena `.set()/.where()/.returning()`, capturando el WHERE si se pide. */
function updateChain(rows: unknown[], onWhere?: (cond: unknown) => void) {
  return {
    set: () => ({
      where: (cond: unknown) => {
        onWhere?.(cond);
        return { returning: () => Promise.resolve(rows) };
      },
    }),
  };
}

beforeEach(() => {
  vi.clearAllMocks();
  mockWriteAuditLog.mockResolvedValue(undefined);
  mockTokenDeGcp.mockResolvedValue("token-gcp");
  process.env.VERTEX_AI_TUNING_ENABLED = "true";
  process.env.GOOGLE_CLOUD_PROJECT = "proyecto";
  process.env.GOOGLE_CLOUD_LOCATION = "us-central1";
  global.fetch = vi.fn();
});

describe("syncVertexAiTuningJobStatus", () => {
  function mockVertexResponse(body: Record<string, unknown>) {
    (global.fetch as ReturnType<typeof vi.fn>).mockResolvedValue({
      ok: true,
      json: () => Promise.resolve(body),
    });
  }

  function mockJobRow(overrides: Record<string, unknown>) {
    mockSelect.mockReturnValue(
      selectChain([
        {
          id: JOB,
          provider: "vertex_ai_gemini",
          status: "eval_pending",
          openai_fine_tuning_job_id: "projects/p/locations/us-central1/tuningJobs/123",
          eval_result: null,
          completed_at: null,
          ...overrides,
        },
      ])
    );
  }

  function captureUpdateSet(): { get: () => Record<string, unknown> | undefined } {
    let captured: Record<string, unknown> | undefined;
    mockUpdate.mockImplementation(() => ({
      set: (values: Record<string, unknown>) => {
        captured = values;
        return { where: () => ({ returning: () => Promise.resolve([{ id: JOB }]) }) };
      },
    }));
    return { get: () => captured };
  }

  it("con el job ya approved y Vertex JOB_STATE_SUCCEEDED, el set conserva status: approved", async () => {
    mockJobRow({ status: "approved" });
    mockVertexResponse({ state: "JOB_STATE_SUCCEEDED", tunedModel: { model: "modelo-1" } });
    const set = captureUpdateSet();

    await syncVertexAiTuningJobStatus(TENANT, USER, JOB);

    expect(set.get()?.status).toBe("approved");
  });

  it("usa tunedModel.model para fine_tuned_model_id aunque tunedModel.endpoint también venga", async () => {
    mockJobRow({});
    mockVertexResponse({
      state: "JOB_STATE_SUCCEEDED",
      tunedModel: { model: "modelo-bueno", endpoint: "projects/p/endpoints/9" },
    });
    const set = captureUpdateSet();

    await syncVertexAiTuningJobStatus(TENANT, USER, JOB);

    expect(set.get()?.fine_tuned_model_id).toBe("modelo-bueno");
  });

  it("conserva un completed_at ya guardado", async () => {
    mockJobRow({ completed_at: "2026-01-01T00:00:00.000Z" });
    mockVertexResponse({ state: "JOB_STATE_SUCCEEDED", tunedModel: { model: "modelo-1" } });
    const set = captureUpdateSet();

    await syncVertexAiTuningJobStatus(TENANT, USER, JOB);

    expect(set.get()?.completed_at).toBe("2026-01-01T00:00:00.000Z");
  });
});

describe("approveVertexAiTuningJob", () => {
  it("con el tuning apagado, tira VERTEX_AI_TUNING_DISABLED", async () => {
    process.env.VERTEX_AI_TUNING_ENABLED = "false";

    await expect(approveVertexAiTuningJob(TENANT, USER, JOB, "approved")).rejects.toThrow(
      "VERTEX_AI_TUNING_DISABLED"
    );
  });

  it("sin filas devueltas, tira JOB_NOT_EVAL_PENDING y no escribe auditoría", async () => {
    mockUpdate.mockReturnValue(updateChain([]));

    await expect(approveVertexAiTuningJob(TENANT, USER, JOB, "approved")).rejects.toThrow(
      "JOB_NOT_EVAL_PENDING"
    );
    expect(mockWriteAuditLog).not.toHaveBeenCalled();
  });

  it("una aprobación exitosa escribe training.finetune_job_approved", async () => {
    mockUpdate.mockReturnValue(updateChain([{ id: JOB }]));

    await approveVertexAiTuningJob(TENANT, USER, JOB, "approved");

    expect(mockWriteAuditLog).toHaveBeenCalledWith(
      expect.objectContaining({
        event_type: "training.finetune_job_approved",
        payload: { job_id: JOB, decision: "approved" },
      })
    );
  });

  it("el WHERE lleva eval_pending y vertex_ai_gemini, e is not null sólo al aprobar", async () => {
    let capturedApproved: unknown;
    mockUpdate.mockImplementationOnce(() =>
      updateChain([{ id: JOB }], (cond) => (capturedApproved = cond))
    );
    await approveVertexAiTuningJob(TENANT, USER, JOB, "approved");

    let capturedRejected: unknown;
    mockUpdate.mockImplementationOnce(() =>
      updateChain([{ id: JOB }], (cond) => (capturedRejected = cond))
    );
    await approveVertexAiTuningJob(TENANT, USER, JOB, "rejected");

    const dialecto = new PgDialect();
    const aprobado = dialecto.sqlToQuery(capturedApproved as never);
    const rechazado = dialecto.sqlToQuery(capturedRejected as never);

    expect(aprobado.params).toEqual(expect.arrayContaining(["eval_pending", "vertex_ai_gemini"]));
    expect(aprobado.sql.toLowerCase()).toContain("is not null");
    expect(rechazado.params).toEqual(expect.arrayContaining(["eval_pending", "vertex_ai_gemini"]));
    expect(rechazado.sql.toLowerCase()).not.toContain("is not null");
  });
});

describe("rollbackVertexAiModel", () => {
  it("con el tuning apagado, tira VERTEX_AI_TUNING_DISABLED", async () => {
    process.env.VERTEX_AI_TUNING_ENABLED = "false";

    await expect(rollbackVertexAiModel(TENANT, USER)).rejects.toThrow(
      "VERTEX_AI_TUNING_DISABLED"
    );
  });
});

describe("listVertexAiTuningJobs", () => {
  it("selecciona vertex_tuned_model_endpoint y vertex_tuning_job_name, no los nombres viejos", async () => {
    mockSelect.mockReturnValue(selectChain([]));

    await listVertexAiTuningJobs(TENANT);

    const columnas = mockSelect.mock.calls[0]?.[0] as Record<string, unknown>;
    expect(columnas).toHaveProperty("vertex_tuned_model_endpoint");
    expect(columnas).toHaveProperty("vertex_tuning_job_name");
    expect(columnas).not.toHaveProperty("fine_tuned_model_id");
    expect(columnas).not.toHaveProperty("openai_fine_tuning_job_id");
  });
});
