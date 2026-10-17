/**
 * E18: el paquete de contexto Gemini (`fine-tuning.ts`) nunca debe leer ni
 * pisar un trabajo de Vertex AI — ambos viven en `model_training_jobs`.
 *
 * Sin base: se captura la consulta que arma cada función, sin ejecutarla, y se
 * lee el SQL que produce Drizzle. Ver `tests/unit/dataset-solo-simulados.test.ts`
 * para el mismo patrón.
 */

const { mockTenant } = vi.hoisted(() => ({ mockTenant: vi.fn() }));

vi.mock("@/data/scope", () => ({
  enTenant: mockTenant,
}));
vi.mock("@/lib/audit/log");
vi.mock("@/server/ai/provider", async (orig) => ({
  ...(await orig<typeof import("@/server/ai/provider")>()),
  setTenantModelDefaults: vi.fn(),
}));

import { describe, expect, it, vi, beforeEach } from "vitest";
import { QueryBuilder } from "drizzle-orm/pg-core";

import { writeAuditLog, AuditEvent } from "@/lib/audit/log";
import { setTenantModelDefaults } from "@/server/ai/provider";
import {
  listFineTuneJobs,
  startFineTuneJob,
  activateFineTunedModel,
} from "@/server/training/fine-tuning";

const JOB = "30000000-0000-0000-0000-000000000003";

/** Captura el `.select(...)` armado contra un `QueryBuilder`, sin ejecutarlo. */
async function capturar(llamar: () => Promise<unknown>) {
  let capturada: { toSQL(): { sql: string; params: unknown[] } } | undefined;
  mockTenant.mockImplementation(async (_ctx: unknown, armar: (db: unknown) => unknown) => {
    capturada = armar(new QueryBuilder()) as typeof capturada;
    return [];
  });
  // startFineTuneJob/activateFineTunedModel tiran NOT_FOUND después del select
  // porque el mock siempre devuelve `[]`: no importa, ya se capturó la consulta.
  await llamar().catch(() => {});
  return capturada!.toSQL();
}

describe("fine-tuning.ts — nunca toca un trabajo de Vertex AI", () => {
  beforeEach(() => {
    mockTenant.mockReset();
  });

  it("listFineTuneJobs filtra por provider = gemini", async () => {
    const { sql, params } = await capturar(() =>
      listFineTuneJobs("10000000-0000-0000-0000-000000000001")
    );
    expect(sql).toMatch(/"provider" = \$\d+/);
    expect(params).toEqual(expect.arrayContaining(["gemini"]));
  });

  it("startFineTuneJob filtra por provider = gemini", async () => {
    const { sql, params } = await capturar(() =>
      startFineTuneJob("10000000-0000-0000-0000-000000000001", "20000000-0000-0000-0000-000000000001", JOB)
    );
    expect(sql).toMatch(/"provider" = \$\d+/);
    expect(params).toEqual(expect.arrayContaining(["gemini"]));
  });

  it("activateFineTunedModel filtra por provider = gemini", async () => {
    const { sql, params } = await capturar(() =>
      activateFineTunedModel("10000000-0000-0000-0000-000000000001", "20000000-0000-0000-0000-000000000001", JOB)
    );
    expect(sql).toMatch(/"provider" = \$\d+/);
    expect(params).toEqual(expect.arrayContaining(["gemini"]));
  });
});

describe("fine-tuning.ts — activar un paquete no pisa el modelo del inquilino", () => {
  const TENANT = "10000000-0000-0000-0000-000000000001";
  const USER = "20000000-0000-0000-0000-000000000001";

  beforeEach(() => {
    mockTenant.mockReset();
    vi.mocked(setTenantModelDefaults).mockClear();
    vi.mocked(writeAuditLog).mockClear();
  });

  it("no llama a setTenantModelDefaults y conserva update, auditoría y retorno", async () => {
    mockTenant
      .mockResolvedValueOnce([{ id: JOB, base_model: "gemini-test-model" }])
      .mockResolvedValueOnce(undefined);

    const res = await activateFineTunedModel(TENANT, USER, JOB);

    expect(setTenantModelDefaults).not.toHaveBeenCalled();
    expect(mockTenant).toHaveBeenCalledTimes(2);
    expect(writeAuditLog).toHaveBeenCalledWith(
      expect.objectContaining({
        event_type: AuditEvent.FINETUNE_MODEL_DEPLOYED,
        target_id: JOB,
      })
    );
    expect(res).toEqual({ model: "gemini-test-model", provider: "gemini" });
  });
});
