/**
 * Alguien escribe «hola», y después la denuncia de verdad.
 *
 * `no_relevante` era terminal en la máquina de estados y el worker no arranca
 * desde ahí, así que el segundo mensaje se guardaba y no lo leía nadie. En un
 * producto de intake es la peor forma de fallar: la denuncia entró y se perdió
 * adentro. Y es el balde más grande de la base — 329 casos.
 *
 * Ahora hay UNA arista de salida, y la toma el camino de ingreso cuando llega un
 * mensaje. LLM08 sigue en pie: el modelo no puede tomarla.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

const { mockSelect, mockUpdate, mockAudit } = vi.hoisted(() => ({
  mockSelect: vi.fn(),
  mockUpdate: vi.fn(),
  mockAudit: vi.fn(),
}));

vi.mock("server-only", () => ({}));

vi.mock("@/lib/db", () => ({
  db: { select: mockSelect, update: mockUpdate },
  tables: {},
}));

vi.mock("@/data/scope", async () => {
  const mod = await import("@/lib/db");
  return {
    enTenant: (_c: unknown, armar: (d: unknown) => unknown) =>
      Promise.resolve(armar((mod as { db: unknown }).db)),
  };
});

vi.mock("@/lib/db/helpers", () => ({
  firstRow: (rows: unknown[]) => rows[0] ?? null,
}));

vi.mock("@/lib/audit/log", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/audit/log")>()),
  writeAuditLog: mockAudit,
}));

import { reabrirSiEraNoRelevante } from "@/server/cases/reabrir-no-relevante";
import { isValidTransition } from "@/core/case/fsm";

const CASE = "bbbbbbbb-0000-0000-0000-000000000001";
const TENANT = "cccccccc-0000-0000-0000-000000000001";

/** El caso, en el estado que se le pase. */
function elCasoEsta(status: string) {
  mockSelect.mockImplementation(() => ({
    from: () => ({ where: () => ({ limit: () => Promise.resolve([{ status }]) }) }),
  }));
}

/** Lo que se escribió con `.set(...)`, si se escribió algo. */
function loEscrito(): Array<Record<string, unknown>> {
  return mockUpdate.mock.results
    .map((r) => r.value as { __set?: Record<string, unknown> })
    .flatMap((v) => (v?.__set ? [v.__set] : []));
}

beforeEach(() => {
  vi.clearAllMocks();
  mockAudit.mockResolvedValue(undefined);
  mockUpdate.mockImplementation(() => {
    const capturado: { __set?: Record<string, unknown> } = {};
    return Object.assign(capturado, {
      set: (data: Record<string, unknown>) => {
        capturado.__set = data;
        return { where: () => Promise.resolve([]) };
      },
    });
  });
  vi.spyOn(console, "info").mockImplementation(() => {});
  vi.spyOn(console, "error").mockImplementation(() => {});
});

afterEach(() => {
  vi.restoreAllMocks();
});

describe("reabrirSiEraNoRelevante", () => {
  it("un caso no-relevante vuelve a `recibido`", async () => {
    elCasoEsta("no_relevante");

    expect(await reabrirSiEraNoRelevante(CASE, TENANT)).toBe(true);
    expect(loEscrito()[0]?.status).toBe("recibido");
  });

  it("y queda asentado, porque un caso reabierto se ve igual que uno que nunca se cerró", async () => {
    elCasoEsta("no_relevante");

    await reabrirSiEraNoRelevante(CASE, TENANT);

    const entrada = mockAudit.mock.calls.find(
      (c) => (c[0] as { event_type?: string })?.event_type === "claim.case_reopened"
    );
    expect(entrada).toBeDefined();
    expect((entrada![0] as { payload: { desde: string } }).payload.desde).toBe(
      "no_relevante"
    );
  });

  it("un caso en cualquier OTRO estado no se toca", async () => {
    /*
     * El control. Sin él, una función que reabriera siempre pasaría los dos
     * tests de arriba y movería casos que una persona está trabajando — o peor,
     * uno ya cerrado.
     */
    for (const estado of [
      "recibido",
      "info_faltante",
      "confirmacion_pendiente",
      "requiere_especialista",
      "listo_para_core",
      "cerrado",
    ]) {
      vi.clearAllMocks();
      elCasoEsta(estado);

      expect(await reabrirSiEraNoRelevante(CASE, TENANT)).toBe(false);
      expect(loEscrito()).toEqual([]);
      expect(mockAudit).not.toHaveBeenCalled();
    }
  });

  it("si el caso no existe, no escribe nada", async () => {
    mockSelect.mockImplementation(() => ({
      from: () => ({ where: () => ({ limit: () => Promise.resolve([]) }) }),
    }));

    expect(await reabrirSiEraNoRelevante(CASE, TENANT)).toBe(false);
    expect(loEscrito()).toEqual([]);
  });

  it("si la base falla, devuelve false y NO tira", async () => {
    // El mensaje ya está guardado cuando esto corre. Tirar acá dejaría el
    // mensaje sin entrar, que es peor que no reabrir.
    mockSelect.mockImplementation(() => {
      throw new Error("la base se cayó");
    });

    await expect(reabrirSiEraNoRelevante(CASE, TENANT)).resolves.toBe(false);
  });
});

describe("la máquina de estados", () => {
  it("tiene la arista, y sólo esa", async () => {
    expect(isValidTransition("no_relevante", "recibido")).toBe(true);

    // Cualquier otra salida sigue prohibida: no es «no_relevante dejó de ser
    // terminal», es «tiene una salida, al principio del flujo».
    for (const otro of [
      "listo_para_core",
      "cerrado",
      "requiere_especialista",
      "enviado_a_core",
      "confirmacion_pendiente",
    ] as const) {
      expect(isValidTransition("no_relevante", otro)).toBe(false);
    }
  });

  it("y la función se lo PREGUNTA en vez de escribir directo", async () => {
    /*
     * Si alguien saca la arista del `fsm.ts`, esto tiene que dejar de reabrir en
     * vez de escribir un estado que la máquina no reconoce. El test de arriba
     * cuida la arista; éste cuida que la función la respete.
     */
    const fuente = await import("node:fs").then((fs) =>
      fs.readFileSync("src/server/cases/reabrir-no-relevante.ts", "utf8")
    );
    expect(fuente).toContain('isValidTransition("no_relevante", "recibido")');
  });
});
