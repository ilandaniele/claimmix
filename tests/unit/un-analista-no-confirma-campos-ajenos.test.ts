/**
 * Un analista no confirma campos de un caso que no es suyo.
 *
 * `patchCase` ya devuelve NOT_FOUND cuando un analista pide un caso ajeno, y
 * `deleteCases` hace lo mismo al borrarlo. `resolveFieldConfirmation` no tenía
 * ese chequeo: cualquier analista del inquilino podía confirmar, corregir o
 * rechazar el campo de cualquier caso, y eso escribe en `extracted_fields` y
 * en la memoria del cliente.
 */

// vi.mock calls must be hoisted to module top level before any other imports
// La capa de datos, corriendo contra el db que este test ya simula.
//
// Se lee `mod.db` en CADA llamada y no se desestructura: el mock de @/lib/db
// suele exponer `db` con un getter para que los tests puedan intercambiar la
// base simulada entre corridas, y un `const { db } = ...` congelaría el valor
// de la primera llamada.
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

// Mock the audit log to avoid DB calls
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
import { writeAuditLog } from "@/lib/audit/log";
import { db } from "@/lib/db";

// ── Test fixtures ─────────────────────────────────────────────────────────────

const CASO = { id: "case-1", status: "listo", assigned_to: "user-analyst-1" };
const analista = { id: "user-analyst-1", role: "analyst" as const };
const otroAnalista = { id: "user-analyst-2", role: "analyst" as const };
const admin = { id: "user-admin-1", role: "admin" as const };

const CONFIRMACION = {
  id: "confirmation-1",
  proposed_value: "algo",
  conflict_with_value: null,
  status: "pending",
};

const input = { field_key: "policy_number", value: null, action: "reject" as const };

// ── Mock helpers ──────────────────────────────────────────────────────────────

/**
 * Configura, por posición, el select del caso y el de la confirmación
 * pendiente — el mismo orden en que los pide `resolveFieldConfirmation`.
 *
 * fetchCaseRows: filas que devuelve el primer select().from().where().limit(1)
 * fetchConfirmationRows: filas que devuelve el segundo
 */
function setupSelectMocks(fetchCaseRows: unknown[], fetchConfirmationRows: unknown[]) {
  const caseChain: any = {
    from: vi.fn().mockReturnThis(),
    where: vi.fn().mockReturnThis(),
    limit: vi.fn().mockResolvedValue(fetchCaseRows),
  };
  const confirmationChain: any = {
    from: vi.fn().mockReturnThis(),
    where: vi.fn().mockReturnThis(),
    limit: vi.fn().mockResolvedValue(fetchConfirmationRows),
  };
  vi.mocked(db.select)
    .mockReturnValueOnce(caseChain as any)
    .mockReturnValueOnce(confirmationChain as any);
}

/** db.update().set().where(), resuelto directo — el reject no usa .returning(). */
function setupUpdateMock() {
  const whereFn = vi.fn().mockResolvedValue(undefined);
  const setFn = vi.fn().mockReturnValue({ where: whereFn });
  vi.mocked(db.update).mockReturnValue({ set: setFn } as any);
}

// ── resolveFieldConfirmation — un caso ajeno ──────────────────────────────────

describe("resolveFieldConfirmation — un caso ajeno", () => {
  beforeEach(() => {
    // resetAllMocks y no clearAllMocks: los guardias de acceso cortan antes
    // del segundo select, y clearAllMocks no vacía la cola de
    // mockReturnValueOnce — el valor que sobra se arrastraba al test siguiente.
    vi.resetAllMocks();
  });

  it("un analista que no tiene el caso asignado recibe NOT_FOUND", async () => {
    setupSelectMocks([CASO], []);

    await expect(
      resolveFieldConfirmation({ tenantId: "tenant-1" }, "case-1", input, otroAnalista)
    ).rejects.toThrow(expect.objectContaining({ code: "NOT_FOUND" }));
  });

  it("y no escribe nada: ni la confirmación, ni el campo, ni la auditoría", async () => {
    setupSelectMocks([CASO], []);

    await expect(
      resolveFieldConfirmation({ tenantId: "tenant-1" }, "case-1", input, otroAnalista)
    ).rejects.toThrow();

    expect(db.update).not.toHaveBeenCalled();
    expect(db.insert).not.toHaveBeenCalled();
    expect(writeAuditLog).not.toHaveBeenCalled();
  });

  it("el analista asignado sí lo resuelve", async () => {
    setupSelectMocks([CASO], [CONFIRMACION]);
    setupUpdateMock();

    const result = await resolveFieldConfirmation(
      { tenantId: "tenant-1" },
      "case-1",
      input,
      analista
    );

    expect(result.new_status).toBe("listo");
    expect(db.update).toHaveBeenCalledTimes(1);
  });

  it("y un admin resuelve el de cualquiera del inquilino", async () => {
    const casoDeOtroAnalista = { ...CASO, assigned_to: "user-analyst-2" };
    setupSelectMocks([casoDeOtroAnalista], [CONFIRMACION]);
    setupUpdateMock();

    const result = await resolveFieldConfirmation(
      { tenantId: "tenant-1" },
      "case-1",
      input,
      admin
    );

    expect(result.new_status).toBe("listo");
  });
});
