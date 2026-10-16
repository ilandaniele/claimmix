/**
 * La sombra y el entrenamiento, vistos desde el worker.
 *
 * Cada corrida deja en agent_runs lo que decidiría el modelo frente a lo que
 * decide el código (gravedad y derivación, con lo que el modelo devolvió CRUDO,
 * antes de que el worker lo corrija) y con qué entrenamiento corrió. Después de
 * orquestar, lo que el orquestador anotó (pedir y responder) completa esa fila.
 * Nada de esto cambia lo que el worker decide.
 */

import { describe, it, expect, vi, afterEach } from "vitest";

import { VERSION_DEL_ENTRENAMIENTO_BASE } from "@/core/agente/entrenamiento-base";
import type { ParteDeSombra } from "@/core/agente/sombra";
import { filaDeCaso, registrarMocks, type OpcionesDelExtractor } from "./worker-harness";

// Cada caso reimporta el grafo entero del worker: ver extract.overlay.test.ts.
vi.setConfig({ testTimeout: 30_000 });

const CASE_ID = "sombra-test-0000-0000-000000000001";
const TENANT_ID = "sombra-test-0000-0000-000000000002";

const CHOQUE = { field_key: "claim_type", field_value: "choque", confidence: 0.88, source: "ai" };

const PEDIR_EL_DNI = {
  pedir: { agente: null, codigo: ["dni"], descartadas: 0 },
} satisfies ParteDeSombra;

const REGLAS = [
  { id: "regla-1", title: "Fecha", rule_text: "la fecha va como AAAA-MM-DD.", rule_type: "extraction" },
  {
    id: "regla-2",
    title: "Pedí primero el DNI",
    rule_text: "si faltan varios datos, empezá por el DNI.",
    rule_type: "missing_fields",
  },
  { id: "regla-3", title: "Cercanía", rule_text: "escribí corto y sin vueltas.", rule_type: "reply_style" },
  {
    id: "regla-4",
    title: "Sitio",
    rule_text: "mandalo a www.x.com para ver el estado.",
    rule_type: "reply_style",
  },
];

afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllEnvs();
});

async function correr({
  extractor = { fields: [CHOQUE], severity: "low", requires_specialist: false },
  cuerpo,
  pedido,
  anota,
  runId = "run-1",
  reglas,
  claim,
}: {
  extractor?: OpcionesDelExtractor;
  cuerpo?: string;
  pedido?: string[];
  /** Lo que el orquestador anota por el séptimo argumento. Sin esto no anota nada. */
  anota?: ParteDeSombra;
  /** Lo que devuelve `logAgentRun`: `null` es la fila que no se pudo escribir. */
  runId?: string | null;
  reglas?: typeof REGLAS;
  /** Lo que el modelo dice además: `is_claim: false` o `parse_failed: true`. */
  claim?: Record<string, unknown>;
} = {}) {
  vi.resetModules();

  registrarMocks({
    fila: filaDeCaso(CASE_ID, TENANT_ID, { channel: "whatsapp" }),
    espiaDeUpdate: vi.fn(),
    extractor,
    cuerpo,
    pedido,
  });

  const logAgentRun = vi.fn(async (_params: Record<string, unknown>) => runId);
  const anotarSombraEnLaCorrida = vi.fn(async () => undefined);
  vi.doMock("@/server/training/agent-runs", async (orig) => ({
    ...(await orig<typeof import("@/server/training/agent-runs")>()),
    logAgentRun,
    anotarSombraEnLaCorrida,
  }));

  // El orquestador anota por el séptimo argumento, como el de verdad.
  const orquestar = vi.fn(async (...args: unknown[]) => {
    (args[6] as ((p: ParteDeSombra) => void) | undefined)?.(anota ?? {});
  });
  vi.doMock("@/server/confirmations/orchestrate", () => ({ orchestratePostExtraction: orquestar }));

  if (claim) {
    vi.doMock("@/server/ai/mock-extractor", () => {
      const claimSimulado = vi.fn().mockReturnValue({
        extraction_model: "mock-email-v1",
        fields: [],
        prompt_tokens: 0,
        completion_tokens: 0,
        cost_usd: 0,
        is_claim: true,
        confidence: 0.9,
        extracted_fields: {},
        field_confidences: {},
        missing_fields: [],
        fields_pending_confirmation: [],
        possible_customer_matches: [],
        possible_policy_matches: [],
        severity: "low",
        requires_specialist: false,
        summary: "",
        suggested_reply: "",
        ...claim,
      });
      return { extractEmailClaimMock: claimSimulado, denunciaSimuladaVacia: vi.fn(() => claimSimulado()) };
    });
  }

  if (reglas) {
    // El lote falla y el worker vuelve a cargar las reglas de a una: ahí entran las de la prueba.
    vi.doMock("@/server/training/prompt-rules", async (importOriginal) => ({
      ...(await importOriginal<typeof import("@/server/training/prompt-rules")>()),
      consultaPromptRules: () => {
        throw new Error("sin lote");
      },
      loadActivePromptRules: vi.fn(async () => reglas),
    }));
  }

  const { runEmailExtractionWorker } = await import("@/server/worker/extract");
  await runEmailExtractionWorker(CASE_ID, TENANT_ID, null);

  expect(logAgentRun).toHaveBeenCalledTimes(1);
  return { registrado: logAgentRun.mock.calls[0][0], anotarSombraEnLaCorrida, orquestar };
}

describe("la sombra de gravedad y derivación en la fila de la corrida", () => {
  it("«Sí» a heridos con el modelo en low: la gravedad cruda y la derivación del código, en el piso", async () => {
    const { registrado } = await correr({ cuerpo: "Sí", pedido: ["hay_heridos"] });

    expect(registrado.sombra).toEqual({
      v: 1,
      gravedad: { agente: "low", codigo: "high" },
      derivar: { agente: false, codigo: true, piso: true },
    });
  });

  it("lo que el modelo dijo de la derivación es lo crudo, no lo que decide el código", async () => {
    const { registrado } = await correr({
      extractor: { fields: [CHOQUE], severity: "low", requires_specialist: true },
    });

    expect(registrado.sombra).toEqual({
      v: 1,
      gravedad: { agente: "low", codigo: "low" },
      derivar: { agente: true, codigo: false, piso: false },
    });
  });

  it.each([
    ["is_claim en false", { is_claim: false }],
    ["parse_failed", { parse_failed: true }],
  ])("con %s no hay clave sombra", async (_nombre, claim) => {
    const { registrado } = await correr({ claim });

    expect(registrado.claim).toMatchObject(claim);
    expect(Object.keys(registrado)).not.toContain("sombra");
    expect(registrado.entrenamiento).toBeDefined();
  });
});

describe("el entrenamiento en la fila de la corrida", () => {
  it("lleva la versión de la base, y sin reglas ninguna", async () => {
    const { registrado } = await correr();

    expect(registrado.entrenamiento).toEqual({ base: VERSION_DEL_ENTRENAMIENTO_BASE, extraccion: [] });
  });

  it("con la bandera apagada, los id de las reglas que lee la extracción y nada más", async () => {
    vi.stubEnv("AGENTE_APRENDIDO_EN_CONVERSACION", undefined);

    const { registrado } = await correr({ reglas: REGLAS });

    expect(registrado.entrenamiento).toEqual({
      base: VERSION_DEL_ENTRENAMIENTO_BASE,
      extraccion: ["regla-1", "regla-2", "regla-3", "regla-4"],
    });
  });

  it("con la bandera prendida suma los id de decidir y redactar: la del enlace no entra", async () => {
    vi.stubEnv("AGENTE_APRENDIDO_EN_CONVERSACION", "1");

    const { registrado } = await correr({ reglas: REGLAS });

    expect(registrado.entrenamiento).toEqual({
      base: VERSION_DEL_ENTRENAMIENTO_BASE,
      extraccion: ["regla-1", "regla-2", "regla-3", "regla-4"],
      decidir: ["regla-2"],
      redactar: ["regla-3"],
    });
  });
});

describe("lo que el orquestador anota después", () => {
  it("se suma a la fila de la corrida, con el caso y el inquilino, después de orquestar", async () => {
    const { anotarSombraEnLaCorrida, orquestar } = await correr({ anota: PEDIR_EL_DNI });

    expect(anotarSombraEnLaCorrida).toHaveBeenCalledTimes(1);
    expect(anotarSombraEnLaCorrida).toHaveBeenCalledWith(TENANT_ID, CASE_ID, "run-1", PEDIR_EL_DNI);
    expect(anotarSombraEnLaCorrida.mock.invocationCallOrder[0]).toBeGreaterThan(
      orquestar.mock.invocationCallOrder[0]
    );
  });

  it("con sólo responder también", async () => {
    const responder = { responder: { agente: "pedir", codigo: "pedir", rechazo: null } } satisfies ParteDeSombra;

    const { anotarSombraEnLaCorrida } = await correr({ anota: responder });

    expect(anotarSombraEnLaCorrida).toHaveBeenCalledWith(TENANT_ID, CASE_ID, "run-1", responder);
  });

  it("si el orquestador no anota nada, no hay UPDATE", async () => {
    const { anotarSombraEnLaCorrida, orquestar } = await correr();

    expect(orquestar).toHaveBeenCalledTimes(1);
    expect(anotarSombraEnLaCorrida).not.toHaveBeenCalled();
  });

  it("si la fila no se pudo escribir, tampoco", async () => {
    const { anotarSombraEnLaCorrida } = await correr({ anota: PEDIR_EL_DNI, runId: null });

    expect(anotarSombraEnLaCorrida).not.toHaveBeenCalled();
  });
});
