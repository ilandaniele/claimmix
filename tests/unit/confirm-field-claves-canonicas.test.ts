/**
 * F1: confirmar un campo con una clave sinónima lo guarda con la canónica.
 *
 * Un analista puede corregir un campo que llegó como `numero_poliza` —así lo
 * mandó el modelo o el parser de respaldo—, y `extracted_fields` no puede
 * terminar con dos claves para el mismo dato.
 */

vi.mock("@/data/scope", async () => {
  const mod = await import("@/lib/db");
  return {
    enTenant: (_ctx: unknown, armar: (d: unknown) => unknown) =>
      Promise.resolve(armar(mod.db)),
    enTenantVarias: (_ctx: unknown, armar: (d: unknown) => unknown[]) =>
      Promise.all(armar(mod.db)),
  };
});

vi.mock("@/lib/db", () => ({
  db: {
    select: vi.fn(),
    insert: vi.fn(),
    update: vi.fn(),
    delete: vi.fn(),
    $count: vi.fn(),
  },
  tables: {},
}));

vi.mock("@/lib/audit/log", () => ({
  writeAuditLog: vi.fn().mockResolvedValue(undefined),
  AuditEvent: {
    FIELD_CONFIRMED: "claim.field_confirmed",
    CASE_STATUS_CHANGED: "case.status_changed",
  },
}));

vi.mock("@/server/cases/inbound-messages", () => ({ mensajesEntrantes: vi.fn().mockResolvedValue([]) }));
vi.mock("@/server/memory/update", () => ({ updateMemoryFromConfirmation: vi.fn() }));
vi.mock("@/server/cases/gap-analyzer", () => ({ analyzeEmailClaimGaps: vi.fn() }));
vi.mock("@/lib/observability/logger", () => ({ logger: { error: vi.fn(), warn: vi.fn(), info: vi.fn() } }));

import { describe, it, expect, vi, beforeEach } from "vitest";
import { resolveFieldConfirmation } from "@/server/cases/confirm-field";
import { analyzeEmailClaimGaps } from "@/server/cases/gap-analyzer";
import { mensajesEntrantes } from "@/server/cases/inbound-messages";
import { db } from "@/lib/db";

const CASO = { id: "case-1", status: "listo", assigned_to: "user-analyst-1" };
const analista = { id: "user-analyst-1", role: "analyst" as const };

/** El select del caso, el de la confirmación pendiente y el de reEvaluateStatus, por posición. */
function setupSelectMocks() {
  const caseChain: any = {
    from: vi.fn().mockReturnThis(),
    where: vi.fn().mockReturnThis(),
    limit: vi.fn().mockResolvedValue([CASO]),
  };
  const confirmationChain: any = {
    from: vi.fn().mockReturnThis(),
    where: vi.fn().mockReturnThis(),
    limit: vi.fn().mockResolvedValue([]),
  };
  const fieldsChain: any = {
    from: vi.fn().mockReturnThis(),
    where: vi.fn().mockResolvedValue([]),
  };
  vi.mocked(db.select)
    .mockReturnValueOnce(caseChain as any)
    .mockReturnValueOnce(confirmationChain as any)
    .mockReturnValueOnce(fieldsChain as any);
}

function setupInsertMock() {
  const valuesFn = vi.fn().mockReturnValue({ onConflictDoUpdate: vi.fn().mockResolvedValue(undefined) });
  vi.mocked(db.insert).mockReturnValue({ values: valuesFn } as any);
  return valuesFn;
}

function setupUpdateMock() {
  const whereFn = vi.fn().mockResolvedValue(undefined);
  const setFn = vi.fn().mockReturnValue({ where: whereFn });
  vi.mocked(db.update).mockReturnValue({ set: setFn } as any);
}

describe("resolveFieldConfirmation — claves canónicas (F1)", () => {
  beforeEach(() => {
    vi.resetAllMocks();
    vi.mocked(analyzeEmailClaimGaps).mockResolvedValue({ status: CASO.status } as any);
    vi.mocked(mensajesEntrantes).mockResolvedValue([]);
  });

  it("numero_poliza se guarda en extracted_fields como policy_number", async () => {
    setupSelectMocks();
    const valuesFn = setupInsertMock();
    setupUpdateMock();

    const input = { field_key: "numero_poliza", value: "AR-000111", action: "correct" as const };
    await resolveFieldConfirmation({ tenantId: "tenant-1" }, "case-1", input, analista);

    expect(valuesFn).toHaveBeenCalledWith(
      expect.objectContaining({ field_key: "policy_number", field_value: "AR-000111" })
    );
  });
});
