/**
 * Los pasos del flujo de carga simulada, uno por uno.
 *
 * Sin el compilador de flujos, `"use step"` y `"use workflow"` son literales de
 * cadena que no hacen nada: las funciones corren como cualquier otra. Eso
 * permite probarlas acá, en los tests unitarios, sin levantar el runtime.
 *
 * Lo que se prueba es lo que un flujo durable hace distinto de un `after()`, y
 * que es fácil romper sin darse cuenta:
 *
 *   · el orquestador NO puede tener efectos — se vuelve a ejecutar entero en
 *     cada retoma, reproduciendo lo ya hecho
 *   · esperar el turno y correr el agente van en pasos separados, porque el
 *     límite de un paso es el límite de lo que se repite cuando algo falla
 *   · una espera que se agota NO frena el procesamiento
 *
 * La durabilidad en sí —que un paso ya hecho no se repita— se prueba aparte, en
 * `tests/workflows/durabilidad.test.ts`, que sí necesita el compilador.
 */
import { describe, it, expect, beforeEach, vi } from "vitest";

const { mockRunIntakeAgent, mockWaitForTurn } = vi.hoisted(() => ({
  mockRunIntakeAgent: vi.fn(),
  mockWaitForTurn: vi.fn(),
}));

vi.mock("@/server/agents/intake-agent", () => ({
  runIntakeAgent: mockRunIntakeAgent,
}));

vi.mock("@/server/intake/simulation-throttle", () => ({
  waitForSimulationTurn: mockWaitForTurn,
}));

import { procesarCasoSimulado } from "@/workflows/intake-simulado";

const ENTRADA = {
  caseId: "caso-1",
  tenantId: "aaaaaaaa-0000-0000-0000-00000000000a",
  userId: "usuario-1",
  caseCreatedAt: "2026-08-26T00:00:00.000Z",
};

beforeEach(() => {
  vi.clearAllMocks();
  mockWaitForTurn.mockResolvedValue({ timedOut: false, blockers: 0, waitedMs: 0 });
  mockRunIntakeAgent.mockResolvedValue(undefined);
  vi.spyOn(console, "warn").mockImplementation(() => {});
});

describe("el flujo de una carga simulada", () => {
  it("espera el turno y recién después corre el agente", async () => {
    const orden: string[] = [];
    mockWaitForTurn.mockImplementation(async () => {
      orden.push("turno");
      return { timedOut: false, blockers: 0, waitedMs: 0 };
    });
    mockRunIntakeAgent.mockImplementation(async () => {
      orden.push("agente");
    });

    await procesarCasoSimulado(ENTRADA);

    // El orden es la razón de ser de la espera: existe para no mandarle veinte
    // casos al modelo a la vez. Correr el agente primero la vuelve decorativa.
    expect(orden).toEqual(["turno", "agente"]);
  });

  it("le pasa al agente el caso, el inquilino y el usuario", async () => {
    await procesarCasoSimulado(ENTRADA);

    expect(mockRunIntakeAgent).toHaveBeenCalledWith({
      caseId: ENTRADA.caseId,
      tenantId: ENTRADA.tenantId,
      userId: ENTRADA.userId,
      source: "simulate",
    });
  });

  it("sigue adelante cuando la espera se agota", async () => {
    mockWaitForTurn.mockResolvedValue({ timedOut: true, blockers: 7, waitedMs: 30_000 });

    await procesarCasoSimulado(ENTRADA);

    // Frenar acá dejaría el caso en `procesando` para siempre, que es
    // exactamente lo que la ejecución durable vino a arreglar. La espera es
    // para no atropellar al modelo, no una condición para procesar.
    expect(mockRunIntakeAgent).toHaveBeenCalledOnce();
  });

  it("deja registro cuando la espera se agota", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    mockWaitForTurn.mockResolvedValue({ timedOut: true, blockers: 7, waitedMs: 30_000 });

    await procesarCasoSimulado(ENTRADA);

    // Seguir sin avisar convierte una cola saturada en algo invisible: los
    // casos salen bien, uno por uno, y nadie se entera de que la espera dejó
    // de funcionar.
    expect(warn).toHaveBeenCalledOnce();
    const anotado = JSON.parse(warn.mock.calls[0][0] as string);
    expect(anotado.msg).toBe("intake.simulate.queue_wait_timed_out");
    expect(anotado.case_id).toBe(ENTRADA.caseId);
    expect(anotado.blockers).toBe(7);
  });

  it("no corre el agente si la espera se cae", async () => {
    mockWaitForTurn.mockRejectedValue(new Error("la base no responde"));

    await expect(procesarCasoSimulado(ENTRADA)).rejects.toThrow("la base no responde");

    // Que el paso falle es lo correcto: el runtime lo reintenta. Tragarse el
    // error y seguir haría que el agente corriera sin turno, y encima sin que
    // nadie sepa que la espera dejó de andar.
    expect(mockRunIntakeAgent).not.toHaveBeenCalled();
  });

  it("acepta un caso sin fecha de creación", async () => {
    // Pasa cuando el INSERT no devolvió `created_at`. La espera lo resuelve
    // sola devolviendo cero; el flujo no tiene que decidir nada.
    await procesarCasoSimulado({ ...ENTRADA, caseCreatedAt: null });

    expect(mockWaitForTurn).toHaveBeenCalledWith(
      expect.objectContaining({ caseCreatedAt: null })
    );
    expect(mockRunIntakeAgent).toHaveBeenCalledOnce();
  });
});

describe("el orquestador no puede tener efectos propios", () => {
  it("no hace nada más que llamar a sus dos pasos", async () => {
    await procesarCasoSimulado(ENTRADA);

    // El cuerpo del flujo se vuelve a ejecutar completo en cada retoma,
    // reproduciendo los resultados que ya tiene. Cualquier efecto escrito ahí
    // —una consulta, un `Date.now()`, un contador— se repetiría en cada
    // reanudación o haría divergir la reproducción.
    //
    // Esto no lo puede comprobar un test del todo; el compilador rechaza los
    // módulos de Node en el grafo del flujo, y eso cubre lo peor. Lo que sí se
    // fija acá es que las dos llamadas sean exactamente una cada una.
    expect(mockWaitForTurn).toHaveBeenCalledOnce();
    expect(mockRunIntakeAgent).toHaveBeenCalledOnce();
  });
});
