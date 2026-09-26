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

// Las 8 consultas de `consultasDelReenvio` (P8), vacías: sin caso no hay nada
// para reenviar.
const SIN_REENVIO = () => [[], [], [], [], [], [], [], []];

beforeEach(() => vi.clearAllMocks());

describe("leerEstadoDeAcciones", () => {
  it("una fila confirma y trae el nombre de quien confirmó", async () => {
    mockEnTenantVarias.mockResolvedValue([[{ quien: "Ana" }], ...SIN_REENVIO()]);

    const acciones = await leerEstadoDeAcciones(CTX, CASE_ID);

    expect(acciones.confirmado).toBe(true);
    expect(acciones.confirmadoPor).toBe("Ana");
    expect(acciones.reabrible).toBe(false);
    expect(acciones.puedeReenviar).toBe(false);
    expect(acciones.motivoSinReenvio).toBe("estado");
  });

  it("un nombre nulo confirma sin decir quién", async () => {
    mockEnTenantVarias.mockResolvedValue([[{ quien: null }], ...SIN_REENVIO()]);

    const acciones = await leerEstadoDeAcciones(CTX, CASE_ID);

    expect(acciones.confirmado).toBe(true);
    expect(acciones.confirmadoPor).toBeNull();
  });

  it("un lote que rechaza da SIN_ACCIONES y no tira", async () => {
    mockEnTenantVarias.mockRejectedValue(new Error("neon"));

    await expect(leerEstadoDeAcciones(CTX, CASE_ID)).resolves.toEqual(SIN_ACCIONES);
  });

  it("info_faltante con algo pendiente puede reenviar", async () => {
    mockEnTenantVarias.mockResolvedValue([
      [],
      [{ id: CASE_ID, status: "info_faltante", channel: "email", assigned_to: null, updated_at: "2026-09-25T00:00:00.000Z" }],
      [{ from_addr: "juan@x.com", received_at: "2026-09-25T00:00:00.000Z" }],
      [],
      [{ asked_keys: ["full_name"], created_at: "2026-09-01T00:00:00.000Z" }],
      [],
      [],
      [],
      [],
    ]);

    const acciones = await leerEstadoDeAcciones(CTX, CASE_ID);

    expect(acciones.reabrible).toBe(false);
    expect(acciones.puedeReenviar).toBe(true);
    expect(acciones.motivoSinReenvio).toBeNull();
  });

  it("cerrado por abandono es reabrible y puede reenviar", async () => {
    mockEnTenantVarias.mockResolvedValue([
      [],
      [{
        id: CASE_ID,
        status: "cerrado",
        channel: "email",
        assigned_to: null,
        updated_at: "2026-09-25T00:00:00.000Z",
        closed_at: "2026-09-20T00:00:00.000Z",
      }],
      [{ from_addr: "juan@x.com", received_at: "2026-09-25T00:00:00.000Z" }],
      [],
      [{ asked_keys: ["full_name"], created_at: "2026-09-01T00:00:00.000Z" }],
      [],
      [],
      [],
      [{ event_type: "claim.closed_abandoned", created_at: "2026-09-20T00:00:00.000Z" }],
    ]);

    const acciones = await leerEstadoDeAcciones(CTX, CASE_ID);

    expect(acciones.reabrible).toBe(true);
    expect(acciones.puedeReenviar).toBe(true);
    expect(acciones.motivoSinReenvio).toBeNull();
  });

  it("P8-01: un abandono anterior al cierre vigente no lo hace reabrible", async () => {
    mockEnTenantVarias.mockResolvedValue([
      [],
      [{
        id: CASE_ID,
        status: "cerrado",
        channel: "email",
        assigned_to: null,
        updated_at: "2026-09-25T00:00:00.000Z",
        closed_at: "2026-09-24T00:00:00.000Z", // lo cerró una persona, después del abandono
      }],
      [{ from_addr: "juan@x.com", received_at: "2026-09-25T00:00:00.000Z" }],
      [],
      [{ asked_keys: ["full_name"], created_at: "2026-09-01T00:00:00.000Z" }],
      [],
      [],
      [],
      [{ event_type: "claim.closed_abandoned", created_at: "2026-09-10T00:00:00.000Z" }],
    ]);

    const acciones = await leerEstadoDeAcciones(CTX, CASE_ID);

    expect(acciones.reabrible).toBe(false);
    expect(acciones.motivoSinReenvio).toBe("cierre_no_es_abandono");
  });
});
