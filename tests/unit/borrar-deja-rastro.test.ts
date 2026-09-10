/**
 * La única operación irreversible del producto era la única sin registro.
 *
 * Ninguna de las dos rutas de DELETE escribía auditoría, y no había evento que
 * escribir: `AuditEvent` no tenía ninguno de borrado. Un caso desaparecía con
 * sus mensajes, sus adjuntos y sus campos extraídos, y no quedaba nada que
 * dijera quién lo hizo ni cuándo.
 *
 * Y el rastro estaba disponible: `audit_log.target_id` NO es clave foránea, y
 * el comentario del esquema dice que es justamente para que la fila sobreviva a
 * lo que describe.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const { mockEnTenant, mockAudit } = vi.hoisted(() => ({
  mockEnTenant: vi.fn(),
  mockAudit: vi.fn(),
}));

vi.mock("server-only", () => ({}));
vi.mock("@/data/scope", () => ({ enTenant: mockEnTenant }));
vi.mock("@/lib/db/schema", () => ({ cases: {} }));
vi.mock("@/lib/audit/log", () => ({
  writeAuditLog: mockAudit,
  AuditEvent: { CASE_DELETED: "case.deleted" },
}));

import { deleteCases } from "@/server/cases/delete";

beforeEach(() => {
  vi.clearAllMocks();
  mockAudit.mockResolvedValue(undefined);
});
afterEach(() => vi.restoreAllMocks());

describe("deleteCases", () => {
  it("anota una fila por caso, con quién lo borró", async () => {
    mockEnTenant.mockResolvedValue([{ id: "caso-1" }, { id: "caso-2" }]);

    const borrados = await deleteCases({ tenantId: "t-1" }, ["caso-1", "caso-2"], "user-9");

    expect(borrados).toEqual(["caso-1", "caso-2"]);
    expect(mockAudit).toHaveBeenCalledTimes(2);
    expect(mockAudit).toHaveBeenCalledWith(
      expect.objectContaining({
        tenant_id: "t-1",
        actor_id: "user-9",
        event_type: "case.deleted",
        target_type: "case",
        target_id: "caso-1",
      })
    );
  });

  it("una por caso y no una por tanda", async () => {
    // El que después busca «qué pasó con este siniestro» busca por id, y un
    // evento con cien ids adentro no aparece.
    mockEnTenant.mockResolvedValue([{ id: "a" }, { id: "b" }, { id: "c" }]);

    await deleteCases({ tenantId: "t-1" }, ["a", "b", "c"], "user-9");

    expect(mockAudit.mock.calls.map((c) => c[0].target_id)).toEqual(["a", "b", "c"]);
  });

  it("anota lo que se borró de verdad, no lo que se pidió", async () => {
    // El control: si la fila ya no estaba, el DELETE no la devuelve y no hay
    // nada que auditar. Auditar la petición sería inventar un borrado.
    mockEnTenant.mockResolvedValue([{ id: "caso-1" }]);

    await deleteCases({ tenantId: "t-1" }, ["caso-1", "caso-que-no-existe"], "user-9");

    expect(mockAudit).toHaveBeenCalledTimes(1);
    expect(mockAudit.mock.calls[0][0].target_id).toBe("caso-1");
  });

  it("con nada que borrar no escribe nada", async () => {
    const borrados = await deleteCases({ tenantId: "t-1" }, [], "user-9");
    expect(borrados).toEqual([]);
    expect(mockAudit).not.toHaveBeenCalled();
    expect(mockEnTenant).not.toHaveBeenCalled();
  });
});
