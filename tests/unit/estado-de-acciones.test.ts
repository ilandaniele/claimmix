/**
 * Qué botones muestra el caso (P6): nunca rechaza, y sin confirmación no hay
 * botón que ofrecer.
 */

import { beforeEach, describe, expect, it, vi } from "vitest";

const { mockEnTenantVarias } = vi.hoisted(() => ({ mockEnTenantVarias: vi.fn() }));

vi.mock("server-only", () => ({}));
vi.mock("@/data/scope", () => ({ enTenantVarias: mockEnTenantVarias, enTenant: vi.fn() }));
vi.mock("@/lib/observability/logger", () => ({
  logger: { error: vi.fn(), warn: vi.fn(), info: vi.fn() },
}));

import { leerEstadoDeAcciones, SIN_ACCIONES } from "@/server/cases/acciones";

const CTX = { tenantId: "10000000-0000-0000-0000-000000000001" };
const CASE_ID = "123e4567-e89b-12d3-a456-426614174001";

beforeEach(() => vi.clearAllMocks());

describe("leerEstadoDeAcciones", () => {
  it("una fila confirma y trae el nombre de quien confirmó", async () => {
    mockEnTenantVarias.mockResolvedValue([[{ quien: "Ana" }]]);

    const acciones = await leerEstadoDeAcciones(CTX, CASE_ID);

    expect(acciones.confirmado).toBe(true);
    expect(acciones.confirmadoPor).toBe("Ana");
  });

  it("un nombre nulo confirma sin decir quién", async () => {
    mockEnTenantVarias.mockResolvedValue([[{ quien: null }]]);

    const acciones = await leerEstadoDeAcciones(CTX, CASE_ID);

    expect(acciones.confirmado).toBe(true);
    expect(acciones.confirmadoPor).toBeNull();
  });

  it("un lote que rechaza da SIN_ACCIONES y no tira", async () => {
    mockEnTenantVarias.mockRejectedValue(new Error("neon"));

    await expect(leerEstadoDeAcciones(CTX, CASE_ID)).resolves.toEqual(SIN_ACCIONES);
  });
});
