/**
 * La marca que nadie leía.
 *
 * Cuatro caminos del worker escriben `extraction_pending = true` con
 * comentarios que dicen «lo toma la próxima corrida». Y el único que la leía era
 * `releaseExtractionLease`, o sea el mismo proceso que la escribió: esa próxima
 * corrida sólo existía si la misma persona volvía a escribir.
 *
 * Si no escribía, el mensaje quedaba guardado y sin leer. Y como el ingreso no
 * toca `cases.updated_at`, el reloj del abandono seguía corriendo sobre la
 * última vez que le hablamos NOSOTROS: a los catorce días el barrido lo cerraba
 * con «sin respuesta del denunciante», habiendo contestado.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const { mockSelect, mockRunIntakeAgent } = vi.hoisted(() => ({
  mockSelect: vi.fn(),
  mockRunIntakeAgent: vi.fn(),
}));

vi.mock("server-only", () => ({}));
vi.mock("@/lib/db", () => ({ db: { select: mockSelect }, tables: {} }));
vi.mock("@/server/agents/intake-agent", () => ({ runIntakeAgent: mockRunIntakeAgent }));

import { retomarExtraccionesPendientes } from "@/server/intake/retomar-pendientes";

/** El `select(...).from(...).where(...).limit(n)` del barrido. */
function devuelve(filas: Array<{ id: string; tenant_id: string }> | Error) {
  mockSelect.mockReturnValue({
    from: () => ({
      where: () => ({
        limit: () => (filas instanceof Error ? Promise.reject(filas) : Promise.resolve(filas)),
      }),
    }),
  });
}

beforeEach(() => {
  vi.clearAllMocks();
  mockRunIntakeAgent.mockResolvedValue(undefined);
});
afterEach(() => vi.restoreAllMocks());

describe("retomarExtraccionesPendientes", () => {
  it("corre el agente sobre cada caso marcado", async () => {
    devuelve([
      { id: "caso-1", tenant_id: "t-1" },
      { id: "caso-2", tenant_id: "t-1" },
    ]);

    const r = await retomarExtraccionesPendientes();

    expect(r.retomados).toBe(2);
    expect(mockRunIntakeAgent).toHaveBeenCalledTimes(2);
    expect(mockRunIntakeAgent).toHaveBeenCalledWith({
      caseId: "caso-1",
      tenantId: "t-1",
      source: "worker",
    });
  });

  it("sin nada marcado, no importa el worker siquiera", async () => {
    // El control: el import del agente es diferido justamente para que una
    // corrida vacía —que es la mayoría— no arrastre el grafo del worker.
    devuelve([]);

    const r = await retomarExtraccionesPendientes();

    expect(r.retomados).toBe(0);
    expect(mockRunIntakeAgent).not.toHaveBeenCalled();
  });

  it("uno que falla no se lleva a los otros", async () => {
    devuelve([
      { id: "caso-1", tenant_id: "t-1" },
      { id: "caso-2", tenant_id: "t-1" },
    ]);
    mockRunIntakeAgent.mockRejectedValueOnce(new Error("Vertex se cayó"));
    const espia = vi.spyOn(console, "error").mockImplementation(() => {});

    const r = await retomarExtraccionesPendientes();
    espia.mockRestore();

    expect(r.retomados).toBe(1);
    expect(r.caseIds).toEqual(["caso-2"]);
  });

  it("y el barrido roto no se ve igual que el barrido vacío", async () => {
    /*
     * Es el error que el encabezado de `reap-stuck` describe haber cometido:
     * devolver cero y quedar en verde es peor que no tener red, porque el verde
     * convence. Devuelve cero igual —no hay nada mejor que devolver— pero lo
     * dice, y con el código del error.
     */
    const err = new Error("no anda");
    (err as unknown as { code: string }).code = "42P01";
    devuelve(err);
    const errores: string[] = [];
    const espia = vi
      .spyOn(console, "error")
      .mockImplementation((...a: unknown[]) => { errores.push(a.map(String).join(" ")); });

    const r = await retomarExtraccionesPendientes();
    espia.mockRestore();

    expect(r.retomados).toBe(0);
    expect(errores.join(" ")).toContain("retomar_pendientes.consulta_fallo");
    expect(errores.join(" ")).toContain("42P01");
  });
});
