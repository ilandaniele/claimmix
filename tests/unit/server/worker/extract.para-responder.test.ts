/**
 * Lo que entra mientras el worker corre.
 *
 * El ingreso no lo marca porque el caso todavía no terminó, y el re-despacho
 * cae en un estado del que el worker no arranca: sin esto, el mensaje quedaba
 * sin leer y sin marcar. La corrida, al terminar, marca el caso si hay un
 * entrante que no leyó (el SQL de esa condición se prueba en
 * `tests/unit/server/cases/para-responder.test.ts`).
 */

import { afterEach, describe, expect, it, vi } from "vitest";

import { filaDeCaso, registrarMocks, type Conversacion } from "./worker-harness";

// Cada caso reimporta el grafo entero del worker: ver extract.overlay.test.ts.
vi.setConfig({ testTimeout: 30_000 });

const CASE_ID = "pararesp-test-0000-0000-000000000001";
const TENANT_ID = "pararesp-test-0000-0000-000000000002";

afterEach(() => {
  vi.restoreAllMocks();
});

async function correr(conversacion?: Conversacion["conversacion"], falla = false) {
  vi.resetModules();
  registrarMocks({
    fila: filaDeCaso(CASE_ID, TENANT_ID, { channel: "whatsapp" }),
    espiaDeUpdate: vi.fn(),
    conversacion,
  });
  const marcar = falla ? vi.fn().mockRejectedValue(new Error("neon")) : vi.fn().mockResolvedValue(undefined);
  vi.doMock("@/server/cases/para-responder", () => ({ marcarParaResponder: marcar }));

  const { runEmailExtractionWorker } = await import("@/server/worker/extract");
  await runEmailExtractionWorker(CASE_ID, TENANT_ID, null);
  const { orchestratePostExtraction } = await import("@/server/confirmations/orchestrate");
  return { marcar, orquestar: vi.mocked(orchestratePostExtraction) };
}

describe("el worker y «Para responder»", () => {
  it("al terminar, marca con los entrantes que leyó", async () => {
    const { marcar, orquestar } = await correr({
      enviado: "2026-09-25T10:00:00.000Z",
      mensajes: [
        ["Choqué en Alem", "2026-09-25T10:01:00.000Z"],
        ["Mando la foto", "2026-09-25T10:02:00.000Z"],
      ],
    });

    expect(marcar).toHaveBeenCalledWith(CASE_ID, TENANT_ID, {
      sinLeer: ["entrante-1", "entrante-2"],
    });
    // Después de que el orquestador dejó el estado final: antes, el caso
    // todavía no está terminado y la marca no aplica.
    expect(orquestar).toHaveBeenCalledTimes(1);
    expect(marcar.mock.invocationCallOrder[0]).toBeGreaterThan(
      orquestar.mock.invocationCallOrder[0]
    );
  });

  it("sin conversación que leer, no marca", async () => {
    const { marcar } = await correr();

    expect(marcar).not.toHaveBeenCalled();
  });

  it("si marcar falla, la corrida termina igual", async () => {
    const { marcar } = await correr(
      { enviado: "2026-09-25T10:00:00.000Z", mensajes: [["Hola", "2026-09-25T10:01:00.000Z"]] },
      true
    );

    expect(marcar).toHaveBeenCalledTimes(1);
  });
});

/**
 * B3: un mensaje a un caso que el agente ya terminó. El worker no lo lee ni lo
 * contesta; lo clasifica para la persona que lo atiende.
 */
describe("el worker y el mensaje tardío", () => {
  async function tardio(
    channel: string,
    falla = false,
    { status = "requiere_especialista", despues, hasta }: { status?: string; despues?: (tarea: () => Promise<void>) => void; hasta?: number } = {}
  ) {
    vi.resetModules();
    // `doMock` sobrevive a `resetModules`: sin esto el `after` de un caso queda para los que siguen.
    vi.doUnmock("next/server");
    if (despues) {
      vi.doMock("next/server", async () => ({ ...(await vi.importActual<object>("next/server")), after: despues }));
    }
    const auditar = vi.fn().mockResolvedValue(undefined);
    registrarMocks({
      fila: filaDeCaso(CASE_ID, TENANT_ID, { channel, status }),
      espiaDeUpdate: vi.fn(),
      espiaDeAuditoria: auditar,
    });
    const atender = falla ? vi.fn().mockRejectedValue(new Error("neon")) : vi.fn().mockResolvedValue(undefined);
    vi.doMock("@/server/cases/mensaje-tardio", () => ({ atenderMensajeTardio: atender }));
    const cartas = vi.fn().mockResolvedValue(undefined);
    vi.doMock("@/server/cases/lectura-reclamo", () => ({ atenderCartas: vi.fn(), atenderCartasDeUnTardio: cartas }));

    const { runEmailExtractionWorker } = await import("@/server/worker/extract");
    const corrida = runEmailExtractionWorker(CASE_ID, TENANT_ID, null, hasta ? { hasta } : undefined);
    const { orchestratePostExtraction } = await import("@/server/confirmations/orchestrate");
    return { corrida, atender, cartas, auditar, orquestar: vi.mocked(orchestratePostExtraction) };
  }

  it.each(["email", "whatsapp"])("por %s lo clasifica después de auditar que no se leyó, y no contesta", async (canal) => {
    const { corrida, atender, auditar, orquestar } = await tardio(canal);
    await corrida;

    expect(atender).toHaveBeenCalledWith({ tenantId: TENANT_ID, caseId: CASE_ID });
    const noLeido = auditar.mock.calls.findIndex(
      ([e]) => (e as { payload?: { motivo?: string } }).payload?.motivo === "estado_no_reanudable"
    );
    expect(noLeido).toBeGreaterThanOrEqual(0);
    expect(atender.mock.invocationCallOrder[0]).toBeGreaterThan(auditar.mock.invocationCallOrder[noLeido]);
    expect(orquestar).not.toHaveBeenCalled();
  });

  it("si clasificar falla, la corrida termina igual", async () => {
    const { corrida, atender } = await tardio("whatsapp", true);

    // Si la corrida tirara, el test fallaría acá.
    await corrida;
    expect(atender).toHaveBeenCalledTimes(1);
  });

  it.each(["requiere_especialista", "cerrado", "enviado_a_core", "listo_para_core"])(
    "un caso %s con un mensaje nuevo también lee la carta de un tercero para el equipo",
    async (status) => {
      const { corrida, cartas } = await tardio("whatsapp", false, { status });
      await corrida;

      expect(cartas).toHaveBeenCalledTimes(1);
      expect(cartas.mock.calls[0]![0]).toMatchObject({ tenantId: TENANT_ID, caseId: CASE_ID });
    }
  );

  it("la carta se lee después de clasificar el mensaje, sin contestar nada", async () => {
    const { corrida, atender, cartas, orquestar } = await tardio("email");
    await corrida;

    expect(cartas.mock.invocationCallOrder[0]).toBeGreaterThan(atender.mock.invocationCallOrder[0]!);
    expect(orquestar).not.toHaveBeenCalled();
  });

  it("le pasa el momento en que Vercel mata la invocación, o uno propio si nadie se lo dio", async () => {
    const dada = await tardio("whatsapp", false, { hasta: 1_800_000_000_000 });
    await dada.corrida;
    expect(dada.cartas.mock.calls[0]![0].hasta).toBe(1_800_000_000_000);

    const antes = Date.now();
    const propia = await tardio("whatsapp");
    await propia.corrida;
    const { hasta } = propia.cartas.mock.calls[0]![0];
    expect(hasta).toBeGreaterThan(antes);
    expect(hasta).toBeLessThanOrEqual(Date.now() + 180_000);
  });

  it("la lectura sale de la respuesta del worker: no demora al re-despacho ni al siguiente mensaje", async () => {
    const pendientes: Array<() => Promise<void>> = [];
    const { corrida, cartas } = await tardio("whatsapp", false, { despues: (tarea) => void pendientes.push(tarea) });
    await corrida;

    expect(cartas).not.toHaveBeenCalled();
    expect(pendientes).toHaveLength(1);
    await pendientes[0]!();
    expect(cartas).toHaveBeenCalledTimes(1);
  });
});
