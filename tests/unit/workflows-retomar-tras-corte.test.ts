/**
 * El flujo de la retoma tras un corte, paso por paso.
 *
 * Sin el compilador de flujos `"use step"` y `"use workflow"` son literales de
 * cadena: las funciones corren como cualquier otra y se pueden probar acá. Que
 * el flujo se compile, se registre y se suspenda de verdad lo prueba
 * `tests/workflows/retomar-tras-corte.test.ts`, que sí necesita el compilador.
 *
 * Lo que se fija es lo que sale caro si se rompe sin darse cuenta: esperar
 * ANTES de retomar, retomar sólo ese caso con un corte coherente con la
 * función, no reintentar el paso (pagaría el modelo otra vez) y no leer la
 * hora en el orquestador.
 */

import { readFileSync } from "node:fs";

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const h = vi.hoisted(() => ({
  sleep: vi.fn(),
  retomar: vi.fn(),
}));

vi.mock("workflow", () => ({ sleep: h.sleep }));
vi.mock("@/server/intake/retomar-pendientes", () => ({ retomarExtraccionesPendientes: h.retomar }));

import { FUNCION_MAS_CORTA_MS } from "@/core/case/reserva-de-extraccion";
import { retomarTrasCorte } from "@/workflows/retomar-tras-corte";

const ENTRADA = { caseId: "caso-1", tenantId: "aaaaaaaa-0000-0000-0000-00000000000a" };
const T0 = 1_700_000_000_000;

beforeEach(() => {
  vi.clearAllMocks();
  h.sleep.mockResolvedValue(undefined);
  h.retomar.mockResolvedValue({ retomados: 1, caseIds: ["caso-1"] });
  vi.useFakeTimers({ toFake: ["Date"], now: T0 });
});

afterEach(() => {
  vi.useRealTimers();
});

describe("el flujo de la retoma", () => {
  it("espera 45 s y recién después retoma", async () => {
    const orden: string[] = [];
    h.sleep.mockImplementation(async () => {
      orden.push("espera");
    });
    h.retomar.mockImplementation(async () => {
      orden.push("retoma");
      return { retomados: 1, caseIds: ["caso-1"] };
    });

    await retomarTrasCorte(ENTRADA);

    // Retomar antes gasta los intentos contra el proveedor que acaba de fallar.
    expect(orden).toEqual(["espera", "retoma"]);
    expect(h.sleep).toHaveBeenCalledOnce();
    expect(h.sleep).toHaveBeenCalledWith("45s");
  });

  it("retoma sólo ese caso, de a uno, con el corte de la función más corta", async () => {
    await retomarTrasCorte(ENTRADA);

    expect(h.retomar).toHaveBeenCalledOnce();
    expect(h.retomar).toHaveBeenCalledWith({
      tenantId: ENTRADA.tenantId,
      caseId: ENTRADA.caseId,
      limit: 1,
      hasta: T0 + FUNCION_MAS_CORTA_MS,
    });
  });

  it("devuelve cuántos retomó", async () => {
    await expect(retomarTrasCorte(ENTRADA)).resolves.toBe(1);

    h.retomar.mockResolvedValue({ retomados: 0, caseIds: [] });
    await expect(retomarTrasCorte(ENTRADA)).resolves.toBe(0);
  });

  it("si el paso tira, el flujo también: no se lo traga", async () => {
    h.retomar.mockRejectedValue(new Error("no cargó el agente"));

    await expect(retomarTrasCorte(ENTRADA)).rejects.toThrow("no cargó el agente");
  });
});

describe("lo que no se puede ver desde afuera", () => {
  // Normalizado: el archivo llega con CRLF acá y con LF en el checkout de CI.
  const fuente = readFileSync("src/workflows/retomar-tras-corte.ts", "utf8").replace(/\r\n/g, "\n");

  it("el paso no se reintenta: reintentar pagaría el modelo otra vez", () => {
    expect(fuente).toContain("retomarElCaso.maxRetries = 0;");
  });

  it("el orquestador no lee la hora", () => {
    // Su cuerpo se vuelve a ejecutar desde el principio en cada reanudación.
    const desde = fuente.indexOf('"use workflow"');
    expect(desde).toBeGreaterThan(-1);
    expect(fuente.slice(desde)).not.toContain("Date.now");
  });

  it("la hora se lee adentro del paso", () => {
    const paso = fuente.slice(fuente.indexOf('"use step"'), fuente.indexOf('"use workflow"'));
    expect(paso).toContain("Date.now() + FUNCION_MAS_CORTA_MS");
  });
});
