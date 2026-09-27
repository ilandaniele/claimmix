/**
 * G37: el estado del agente para el indicador del sidebar.
 *
 * Nunca tira: un error de la base no puede voltear el layout entero, así que
 * cualquier falla —de `modoDeIa`, de `checkBudget` o de la consulta de
 * `procesando`— tiene que devolver null y no un rechazo.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const { mockDbSelect, mockModoDeIa, mockCheckBudget } = vi.hoisted(() => ({
  mockDbSelect: vi.fn(),
  mockModoDeIa: vi.fn(),
  mockCheckBudget: vi.fn(),
}));

// La capa de datos, corriendo contra el db que este test ya simula.
vi.mock("@/data/scope", async () => {
  const mod = await import("@/lib/db");
  return {
    enTenant: (_ctx: unknown, armar: (d: unknown) => unknown) =>
      Promise.resolve(armar(mod.db)),
  };
});

vi.mock("@/lib/db", () => ({
  db: { select: mockDbSelect },
}));

vi.mock("@/server/ai/provider", () => ({
  modoDeIa: mockModoDeIa,
}));

vi.mock("@/server/ai/budget", () => ({
  checkBudget: mockCheckBudget,
}));

import { leerEstadoDelAgente } from "@/server/agente/estado";

const TENANT = { tenantId: "10000000-0000-0000-0000-000000000001" };

function conProcesando(n: number) {
  mockDbSelect.mockReturnValue({
    from: vi.fn().mockReturnValue({
      where: vi.fn().mockResolvedValue([{ n }]),
    }),
  });
}

describe("leerEstadoDelAgente", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    conProcesando(0);
  });

  afterEach(() => {
    vi.clearAllMocks();
  });

  it("MOCK_AI da modo_prueba, y ni mira el presupuesto", async () => {
    mockModoDeIa.mockReturnValue("mock");
    conProcesando(3);

    const estado = await leerEstadoDelAgente(TENANT);

    expect(estado).toEqual({ estado: "modo_prueba", procesando: 3 });
    expect(mockCheckBudget).not.toHaveBeenCalled();
  });

  it("presupuesto agotado da sin_presupuesto", async () => {
    mockModoDeIa.mockReturnValue("gemini");
    mockCheckBudget.mockResolvedValue({ exceeded: true, reason: "agotado" });

    const estado = await leerEstadoDelAgente(TENANT);

    expect(estado).toEqual({ estado: "sin_presupuesto", procesando: 0 });
  });

  it("ni mock ni presupuesto agotado da activo, con la cuenta de procesando", async () => {
    mockModoDeIa.mockReturnValue("gemini");
    mockCheckBudget.mockResolvedValue({ exceeded: false });
    conProcesando(5);

    const estado = await leerEstadoDelAgente(TENANT);

    expect(estado).toEqual({ estado: "activo", procesando: 5 });
  });

  it("un error de la base nunca tira: devuelve null", async () => {
    mockModoDeIa.mockReturnValue("gemini");
    mockCheckBudget.mockResolvedValue({ exceeded: false });
    mockDbSelect.mockReturnValue({
      from: vi.fn().mockReturnValue({
        where: vi.fn().mockRejectedValue(new Error("connection refused")),
      }),
    });

    await expect(leerEstadoDelAgente(TENANT)).resolves.toBeNull();
  });

  it("un error de checkBudget tampoco tira: devuelve null", async () => {
    mockModoDeIa.mockReturnValue("gemini");
    mockCheckBudget.mockRejectedValue(new Error("timeout"));

    await expect(leerEstadoDelAgente(TENANT)).resolves.toBeNull();
  });
});
