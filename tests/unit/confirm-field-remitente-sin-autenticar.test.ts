/**
 * E17: sin SPF/DKIM del remitente, la confirmación no toca la memoria.
 *
 * `getSenderEmail` reusa `mensajesEntrantes`, que ahora informa `autenticado`.
 * Si el último mensaje entrante falló la autenticación, la dirección no es
 * confiable como clave de memoria: no se le atribuye a esa persona lo que el
 * analista confirmó.
 */

vi.mock("@/data/scope", () => import("../mocks/puente-de-alcance").then((m) => m.puenteSobreLibDb()));

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
import { updateMemoryFromConfirmation } from "@/server/memory/update";
import { logger } from "@/lib/observability/logger";
import { db } from "@/lib/db";

const CASO = { id: "case-1", status: "listo", assigned_to: "user-analyst-1" };
const analista = { id: "user-analyst-1", role: "analyst" as const };

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
}

function setupUpdateMock() {
  const whereFn = vi.fn().mockResolvedValue(undefined);
  const setFn = vi.fn().mockReturnValue({ where: whereFn });
  vi.mocked(db.update).mockReturnValue({ set: setFn } as any);
}

describe("resolveFieldConfirmation — remitente sin autenticar (E17)", () => {
  beforeEach(() => {
    vi.resetAllMocks();
    vi.mocked(analyzeEmailClaimGaps).mockResolvedValue({ status: CASO.status } as any);
  });

  it("con autenticado: false no llama a updateMemoryFromConfirmation y avisa", async () => {
    setupSelectMocks();
    setupInsertMock();
    setupUpdateMock();
    vi.mocked(mensajesEntrantes).mockResolvedValue([
      { subject: "s", body: "b", from_addr: "falso@ejemplo.com", received_at: "x", autenticado: false },
    ]);

    const input = { field_key: "policy_number", value: "AR-000111", action: "correct" as const };
    const res = await resolveFieldConfirmation({ tenantId: "tenant-1" }, "case-1", input, analista);

    expect(updateMemoryFromConfirmation).not.toHaveBeenCalled();
    expect(res.claim_memory_updated).toBe(false);
    expect(logger.warn).toHaveBeenCalledWith(
      { case_id: "case-1" },
      "confirm_field.memoria_omitida_remitente_sin_autenticar"
    );
  });

  it("con autenticado: true llama a updateMemoryFromConfirmation", async () => {
    setupSelectMocks();
    setupInsertMock();
    setupUpdateMock();
    vi.mocked(mensajesEntrantes).mockResolvedValue([
      { subject: "s", body: "b", from_addr: "real@ejemplo.com", received_at: "x", autenticado: true },
    ]);

    const input = { field_key: "policy_number", value: "AR-000111", action: "correct" as const };
    const res = await resolveFieldConfirmation({ tenantId: "tenant-1" }, "case-1", input, analista);

    expect(updateMemoryFromConfirmation).toHaveBeenCalledWith(
      "tenant-1",
      "policy_number",
      "AR-000111",
      "real@ejemplo.com",
      "case-1",
      "user-analyst-1",
      undefined
    );
    expect(res.claim_memory_updated).toBe(true);
  });
});
