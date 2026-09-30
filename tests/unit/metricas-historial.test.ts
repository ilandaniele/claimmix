/**
 * `getHistorialDeMetricas`: el mes a mes en su propio viaje.
 *
 * Antes viajaba dentro de `getTenantKpis`, y la vista del historial (que no
 * dibuja nada del tablero) pagaba once consultas para tirarlas. Lo que se
 * afirma acá es que ahora es UNA consulta y que la ventana leída es la misma
 * que se rellena.
 */

vi.mock("server-only", () => ({}));

const { mockEnTenant, mockConsulta } = vi.hoisted(() => ({
  mockEnTenant: vi.fn(),
  mockConsulta: vi.fn(),
}));

vi.mock("@/data/scope", () => ({ enTenant: mockEnTenant }));
vi.mock("@/server/metrics/trayecto", () => ({ consultaDeHistorial: mockConsulta }));

import { describe, it, expect, vi, beforeEach } from "vitest";
import { rangoDelHistorial, type FilaDeHistorial } from "@/core/metricas/ciclo";
import { getHistorialDeMetricas } from "@/server/metrics/historial";

const CTX = { tenantId: "10000000-0000-0000-0000-000000000001" };
const AHORA = new Date("2026-09-15T15:00:00Z");
const DB = { db: "falsa" };

const junio: FilaDeHistorial = {
  mes: "2026-06",
  reclamos: 10,
  con_listo: 6,
  mediana_horas_listo: 2.5,
  con_cierre: 3,
  mediana_horas_cierre: 40,
  sin_intervencion: 4,
  mensajes_por_caso: 5.3,
  completados: 6,
  escalados: 2,
  cerrados: 3,
};

beforeEach(() => {
  mockEnTenant.mockReset();
  mockConsulta.mockReset();
  mockEnTenant.mockImplementation(async (_ctx, consulta: (db: unknown) => unknown) => consulta(DB));
  mockConsulta.mockReturnValue([junio]);
});

describe("getHistorialDeMetricas", () => {
  it("es una sola consulta, en un solo viaje, para el inquilino que pregunta", async () => {
    await getHistorialDeMetricas(CTX, AHORA);

    expect(mockEnTenant).toHaveBeenCalledTimes(1);
    expect(mockEnTenant.mock.calls[0]![0]).toEqual(CTX);
    expect(mockConsulta).toHaveBeenCalledTimes(1);
  });

  it("lee la ventana de los últimos doce meses argentinos", async () => {
    await getHistorialDeMetricas(CTX, AHORA);

    const { desde, hasta } = rangoDelHistorial(AHORA);
    expect(mockConsulta).toHaveBeenCalledWith(DB, desde, hasta);
  });

  it("pone la fila en su mes y rellena los doce con ceros", async () => {
    const filas = await getHistorialDeMetricas(CTX, AHORA);

    expect(filas).toHaveLength(12);
    expect(filas[0]!.mes).toBe("2025-10");
    expect(filas.at(-1)!.mes).toBe("2026-09");
    expect(filas.find((f) => f.mes === "2026-06")).toEqual(junio);
    expect(filas.find((f) => f.mes === "2026-07")).toMatchObject({ reclamos: 0, mediana_horas_listo: null });
  });

  it("si la base falla, el error llega a quien llama", async () => {
    mockEnTenant.mockRejectedValue(new Error("connection refused"));

    await expect(getHistorialDeMetricas(CTX, AHORA)).rejects.toThrow("connection refused");
  });
});
