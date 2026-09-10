/**
 * La salud que miraba las dependencias, no el trabajo.
 *
 * Los nueve chequeos de `/api/health` preguntan «¿alcanzo a X?»: la base, la
 * capa, el esquema, el almacenamiento, el modelo, WhatsApp, Gmail, la
 * configuración del agente, el presupuesto. Todos pueden estar en verde con el
 * producto sin hacer nada.
 *
 * El 09/09, con 80 timeouts del modelo y 189 adjuntos que R2 nunca recibió,
 * estuvo verde todo el día. Se consulta cada quince minutos.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const { mockExecute } = vi.hoisted(() => ({ mockExecute: vi.fn() }));

vi.mock("server-only", () => ({}));
vi.mock("@/lib/db", () => ({ db: { execute: mockExecute }, tables: {} }));

import {
  chequearAdjuntos,
  chequearCasosTrabados,
  chequearEnvios,
  chequearExtraccion,
} from "@/app/api/health/trabajo";

const filas = (rows: Record<string, number>[]) => Promise.resolve({ rows });

beforeEach(() => vi.clearAllMocks());
afterEach(() => vi.restoreAllMocks());

describe("casos trabados", () => {
  it("ninguno es ok", async () => {
    mockExecute.mockReturnValue(filas([{ n: 0 }]));
    expect((await chequearCasosTrabados()).status).toBe("ok");
  });

  it("uno solo tira la salud abajo", async () => {
    // `down`, no `degraded`: un caso sin tomar es una denuncia sin leer, y el
    // job `salud` sólo pone el workflow en rojo cuando algo está `down`.
    mockExecute.mockReturnValue(filas([{ n: 1 }]));
    const c = await chequearCasosTrabados();
    expect(c.status).toBe("down");
    expect(c.detail).toContain("1 caso");
  });
});

describe("extracción", () => {
  it("un día malo del proveedor no es una falla", async () => {
    // 9,5% fue el peor día medido entre el 4 y el 9 de septiembre.
    mockExecute.mockReturnValue(filas([{ malas: 9, total: 100 }]));
    expect((await chequearExtraccion()).status).toBe("ok");
  });

  it("pero una de cada cinco sí", async () => {
    mockExecute.mockReturnValue(filas([{ malas: 20, total: 100 }]));
    const c = await chequearExtraccion();
    expect(c.status).toBe("degraded");
    expect(c.detail).toContain("20%");
  });

  it("y sin llamadas no hay proporción que calcular", async () => {
    // El control: `0/0` es NaN, y `NaN > 0.15` es false — pero decir «0% falló»
    // sobre cero llamadas es afirmar algo que no se midió. De madrugada no
    // entra nada y eso no es una falla.
    mockExecute.mockReturnValue(filas([{ malas: 0, total: 0 }]));
    const c = await chequearExtraccion();
    expect(c.status).toBe("ok");
    expect(c.detail).toContain("sin llamadas");
  });
});

describe("envíos y adjuntos", () => {
  it("un mensaje que no salió es alguien esperando", async () => {
    mockExecute.mockReturnValue(filas([{ n: 3 }]));
    expect((await chequearEnvios()).status).toBe("degraded");
  });

  it("y un adjunto perdido es una foto que la persona creyó haber mandado", async () => {
    mockExecute.mockReturnValue(filas([{ n: 189 }]));
    const c = await chequearAdjuntos();
    expect(c.status).toBe("degraded");
    expect(c.detail).toContain("189");
  });
});

describe("un chequeo que no pudo consultar", () => {
  it("no dice que está todo bien", async () => {
    /*
     * Es el error que el encabezado de `reap-stuck` describe haber cometido:
     * devolver cero y quedar en verde es peor que no tener red, porque el verde
     * convence.
     */
    const err = new Error("no anda");
    (err as unknown as { code: string }).code = "42P01";
    mockExecute.mockRejectedValue(err);

    for (const fn of [chequearCasosTrabados, chequearExtraccion, chequearEnvios, chequearAdjuntos]) {
      const c = await fn();
      expect(c.status, fn.name).not.toBe("ok");
      expect(c.detail, fn.name).toContain("42P01");
    }
  });
});
