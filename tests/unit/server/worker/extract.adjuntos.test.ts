/**
 * Los adjuntos en la corrida del worker (B1, B7, B8).
 *
 * Lo que se prueba es el cableado: que las fotos y PDF lleguen al modelo, que
 * lo que el modelo leyó de cada archivo vaya a su fila y a ningún otro lado,
 * que los indicios de los documentos queden en la ficha sin tocar lo que ve el
 * orquestador, y que un TIMEOUT deje los archivos afuera del reintento. Las
 * reglas de cada pieza tienen sus propios tests.
 */

import { afterEach, describe, expect, it, vi, type Mock } from "vitest";

import type { AdjuntoDelCaso, ParaElModelo } from "@/server/worker/adjuntos";

import { filaDeCaso, registrarMocks, type Conversacion, type FilaDeCaso } from "./worker-harness";

vi.setConfig({ testTimeout: 30_000 });

const CASE_ID = "aaaaaaaa-0000-4000-8000-000000000011";
const TENANT_ID = "bbbbbbbb-0000-4000-8000-000000000012";

afterEach(() => {
  vi.restoreAllMocks();
});

const adjunto = (cambios: Partial<AdjuntoDelCaso>): AdjuntoDelCaso => ({
  id: "adj-1",
  claim_message_id: "entrante-1",
  content_type: "application/pdf",
  storage_path: "t/c/a.pdf",
  content_hash: "h1",
  size_bytes: 100,
  resumen: null,
  util: null,
  rejected_reason: null,
  datos: null,
  metadatos: { firma: true },
  ...cambios,
});

const VISTOS: ParaElModelo = { hashes: ["h1"], media: [{ mimeType: "application/pdf", data: "JVBERi0=" }] };

function denuncia(cambios: Record<string, unknown> = {}) {
  return {
    is_claim: true,
    confidence: 0.9,
    fields: [{ field_key: "accident_date", field_value: "2026-09-10", confidence: 0.9, source: "ai" }],
    extracted_fields: { accident_date: "2026-09-10" },
    missing_fields: [],
    fields_pending_confirmation: [],
    possible_customer_matches: [],
    possible_policy_matches: [],
    severity: "medium",
    requires_specialist: false,
    fraud_risk_level: "none",
    fraud_indicators: [],
    summary: "",
    suggested_reply: "",
    adjuntos: [],
    ...cambios,
  };
}

async function correr(opciones: {
  adjuntos?: AdjuntoDelCaso[];
  vistos?: ParaElModelo;
  claim?: Record<string, unknown>;
  error?: unknown;
  fila?: Partial<FilaDeCaso> & Record<string, unknown>;
  transcripciones?: Map<string, string>;
  motor?: "gemini" | "mock";
} & Conversacion = {}) {
  vi.resetModules();
  const espiaDeUpdate: Mock<(data: Record<string, unknown>) => void> = vi.fn();
  registrarMocks({
    fila: { ...filaDeCaso(CASE_ID, TENANT_ID), ...opciones.fila } as FilaDeCaso,
    espiaDeUpdate,
    conversacion: opciones.conversacion,
  });

  const { GeminiExtractionError } = await import("@/server/ai/gemini-extractor");
  const extractor = vi.fn();
  if (opciones.error) {
    const e = opciones.error as { code?: string; status?: number };
    extractor.mockRejectedValue(new GeminiExtractionError("falló", e));
  } else {
    extractor.mockResolvedValue(denuncia(opciones.claim));
  }
  vi.doMock("@/server/ai/claim-agent", () => ({
    runEmailClaimAgent: extractor,
    runClaimTextAgent: extractor,
    ClaimAgentError: class extends Error {},
  }));

  vi.doMock("@/server/ai/provider", async () => ({
    ...(await vi.importActual<typeof import("@/server/ai/provider")>("@/server/ai/provider")),
    resolveExtractionEngine: vi.fn().mockResolvedValue(opciones.motor ?? "gemini"),
  }));

  const anotarLecturas = vi.fn().mockResolvedValue(undefined);
  const paraElModelo = vi.fn().mockResolvedValue(opciones.vistos ?? { hashes: [], media: [] });
  const marcarPlazoAgotado = vi.fn().mockResolvedValue(undefined);
  vi.doMock("@/server/worker/adjuntos", async () => ({
    ...(await vi.importActual<typeof import("@/server/worker/adjuntos")>("@/server/worker/adjuntos")),
    // El andamiaje no deja armar el lote del prompt: los adjuntos llegan por el reserva.
    adjuntosDelCaso: vi.fn().mockResolvedValue(opciones.adjuntos ?? []),
    paraElModelo,
    anotarLecturas,
    marcarPlazoAgotado,
  }));

  const transcribir = vi.fn().mockResolvedValue(opciones.transcripciones ?? new Map());
  vi.doMock("@/server/worker/transcribir", () => ({ transcribirNotasDeVoz: transcribir }));

  const logAgentRun = vi.fn().mockResolvedValue(undefined);
  vi.doMock("@/server/training/agent-runs", () => ({
    logAgentRun,
    logAgentRunError: vi.fn().mockResolvedValue(undefined),
  }));

  const orquestador = vi.fn().mockResolvedValue(undefined);
  vi.doMock("@/server/confirmations/orchestrate", () => ({ orchestratePostExtraction: orquestador }));

  const { runEmailExtractionWorker } = await import("@/server/worker/extract");
  await runEmailExtractionWorker(CASE_ID, TENANT_ID, null);

  const escrito = espiaDeUpdate.mock.calls.map((c) => c[0]);
  const delCaso = escrito.find((d) => "is_claim" in d && d.is_claim === true);
  return { extractor, anotarLecturas, paraElModelo, marcarPlazoAgotado, transcribir, logAgentRun, orquestador, escrito, delCaso };
}

describe("fotos y PDF al modelo", () => {

  it("los archivos van en el payload de la misma extracción", async () => {
    const { extractor } = await correr({ adjuntos: [adjunto({})], vistos: VISTOS });
    expect(extractor.mock.calls[0]![0].payload.media).toEqual(VISTOS.media);
  });

  it("sin archivos el payload no lleva media", async () => {
    const { extractor } = await correr();
    expect(extractor.mock.calls[0]![0].payload).not.toHaveProperty("media");
  });

  it("lo leído va a las filas y no al registro de la corrida ni al orquestador", async () => {
    const lectura = { indice: 1, resumen: "Constancia de denuncia policial.", util: true, documento: null };
    const { anotarLecturas, logAgentRun, orquestador } = await correr({
      adjuntos: [adjunto({})],
      vistos: VISTOS,
      claim: { adjuntos: [lectura] },
    });
    expect(anotarLecturas).toHaveBeenCalledWith(CASE_ID, expect.anything(), VISTOS, [lectura]);
    expect(logAgentRun.mock.calls[0]![0].claim.adjuntos).toEqual([]);
    expect(orquestador.mock.calls[0]![2].extractedClaim.adjuntos).toEqual([]);
  });

  it("con el motor mock no se leen ni se transcriben: quedan para el modelo de verdad", async () => {
    const { extractor, paraElModelo, transcribir, anotarLecturas } = await correr({
      adjuntos: [adjunto({})],
      vistos: VISTOS,
      motor: "mock",
      conversacion: { enviado: "2026-09-20T10:00:00Z", mensajes: [["[Mensaje de audio adjunto]", "2026-09-20T10:05:00Z"]] },
    });
    expect(paraElModelo).not.toHaveBeenCalled();
    expect(transcribir).not.toHaveBeenCalled();
    expect(extractor.mock.calls[0]![0].payload).not.toHaveProperty("media");
    expect(anotarLecturas).toHaveBeenCalledWith(CASE_ID, expect.anything(), { hashes: [], media: [] }, []);
  });

  it("una respuesta que no se pudo leer no anota nada: los archivos vuelven a ir", async () => {
    const { anotarLecturas } = await correr({ adjuntos: [adjunto({})], vistos: VISTOS, claim: { parse_failed: true } });
    expect(anotarLecturas).not.toHaveBeenCalled();
  });
});

describe("indicios de los documentos", () => {
  const constancia = adjunto({
    resumen: "Constancia.",
    datos: { tipo: "Constancia de denuncia", fecha: "2026-09-13", patente: null, dni: null, nombre: null, lugar: null, provincia: null },
  });

  it("una constancia con otra fecha queda en la ficha y no en lo que lee el orquestador", async () => {
    const { delCaso, orquestador } = await correr({ adjuntos: [constancia] });
    expect(delCaso?.fraud_risk_level).toBe("low");
    expect(delCaso?.fraud_indicators).toEqual([
      expect.objectContaining({ type: "timeline_inconsistency", origen: "documentos" }),
    ]);
    const vistoPorElOrquestador = orquestador.mock.calls[0]![2].extractedClaim;
    expect(vistoPorElOrquestador.fraud_indicators).toEqual([]);
    expect(vistoPorElOrquestador.fraud_risk_level).toBe("none");
  });

  it("el nivel del caso no baja aunque el modelo diga menos", async () => {
    const { delCaso } = await correr({
      adjuntos: [constancia],
      fila: { fraud_risk_level: "high", fraud_indicators: [] },
      claim: { fraud_risk_level: "low", fraud_indicators: [{ type: "other", description: "x" }] },
    });
    expect(delCaso?.fraud_risk_level).toBe("high");
  });

  it("sin nada que marcar no escribe fraude", async () => {
    const { delCaso } = await correr();
    expect(delCaso).not.toHaveProperty("fraud_risk_level");
    expect(delCaso).not.toHaveProperty("fraud_indicators");
  });
});

describe("resumen del caso", () => {
  it("el summary de la extracción queda como resumen", async () => {
    const { delCaso, extractor } = await correr({ claim: { summary: "Choque en una esquina, sin heridos." } });
    expect(extractor).toHaveBeenCalledTimes(1);
    expect(delCaso?.resumen).toBe("Choque en una esquina, sin heridos.");
  });

  it("un summary con un correo no se guarda y borra el anterior", async () => {
    const { delCaso } = await correr({
      fila: { resumen: "Choque en una esquina." },
      claim: { summary: "Escribió desde alguien@ejemplo.com por un choque." },
    });
    expect(delCaso).toHaveProperty("resumen", null);
  });
});

describe("TIMEOUT con archivos", () => {
  it("marca los archivos para que el reintento vaya sin ellos", async () => {
    const { marcarPlazoAgotado } = await correr({ adjuntos: [adjunto({})], vistos: VISTOS, error: { code: "TIMEOUT" } });
    expect(marcarPlazoAgotado).toHaveBeenCalledWith(CASE_ID, expect.anything(), ["h1"]);
  });

  it("un 429 no es culpa de los archivos", async () => {
    const { marcarPlazoAgotado } = await correr({ adjuntos: [adjunto({})], vistos: VISTOS, error: { status: 429 } });
    expect(marcarPlazoAgotado).not.toHaveBeenCalled();
  });
});

describe("notas de voz", () => {
  const conversacion = {
    enviado: "2026-09-20T10:00:00Z",
    mensajes: [["[Mensaje de audio adjunto]", "2026-09-20T10:05:00Z"]] as Array<[string, string]>,
  };

  it("la transcripción entra en la conversación que lee el extractor", async () => {
    const { extractor, orquestador } = await correr({
      conversacion,
      transcripciones: new Map([["entrante-1", "Transcripción de nota de voz:\nChoqué en la esquina."]]),
    });
    expect(extractor.mock.calls[0]![0].payload.body).toContain("Choqué en la esquina.");
    expect(orquestador.mock.calls[0]![2].latestMessageText).toContain("Choqué en la esquina.");
  });

  it("sin mensajes del caso no se transcribe", async () => {
    const { transcribir } = await correr();
    expect(transcribir).not.toHaveBeenCalled();
  });
});
