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
  /** Lo que contesta `anotarLecturas`: false si no pudo guardar las lecturas. */
  lecturasAnotadas?: boolean;
  hasta?: number;
  /** El `after()` de Next: por defecto el real, que fuera de un pedido tira y la lectura corre en el momento. */
  despues?: (tarea: () => Promise<void>) => void;
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

  const anotarLecturas = vi.fn().mockResolvedValue(opciones.lecturasAnotadas ?? true);
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

  const atenderCartas = vi.fn().mockResolvedValue(undefined);
  vi.doMock("@/server/cases/lectura-reclamo", () => ({ atenderCartas }));
  const { despues } = opciones;
  // `doMock` sobrevive a `resetModules`: sin esto el `after` de un caso queda para los que siguen.
  vi.doUnmock("next/server");
  if (despues) {
    vi.doMock("next/server", async () => ({ ...(await vi.importActual<object>("next/server")), after: despues }));
  }

  const { runEmailExtractionWorker } = await import("@/server/worker/extract");
  await runEmailExtractionWorker(CASE_ID, TENANT_ID, null, opciones.hasta ? { hasta: opciones.hasta } : undefined);

  const escrito = espiaDeUpdate.mock.calls.map((c) => c[0]);
  const delCaso = escrito.find((d) => "is_claim" in d && d.is_claim === true);
  return {
    extractor,
    anotarLecturas,
    paraElModelo,
    marcarPlazoAgotado,
    transcribir,
    logAgentRun,
    orquestador,
    atenderCartas,
    espiaDeUpdate,
    escrito,
    delCaso,
  };
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

describe("responsabilidad en choques (B18)", () => {
  const mecanica = (c: Record<string, unknown> = {}) => ({
    maniobra_asegurado: null,
    maniobra_tercero: null,
    semaforo_asegurado: null,
    semaforo_tercero: null,
    interseccion: null,
    venia_por_la_derecha: null,
    embistio_de_atras: "tercero",
    excepcion_prioridad: null,
    ...c,
  });
  const choque = { field_confidences: {}, extracted_fields: { accident_date: "2026-09-10", claim_type: "choque" } };

  it("un choque con mecánica deja la opinión en el mismo UPDATE del caso", async () => {
    const { delCaso } = await correr({ claim: { ...choque, mecanica: mecanica() } });
    expect(delCaso?.responsabilidad).toMatchObject({ v: 1, responsable: "tercero", regla: "ley24449_art48g" });
  });

  it("la mecánica del relato no llega al registro de la corrida ni al orquestador", async () => {
    const { logAgentRun, orquestador } = await correr({ claim: { ...choque, mecanica: mecanica() } });
    expect(logAgentRun.mock.calls[0]![0].claim.mecanica).toBeNull();
    expect(orquestador.mock.calls[0]![2].extractedClaim.mecanica).toBeNull();
  });

  it("la mecánica de un parte leído en esta corrida también cuenta", async () => {
    const lectura = {
      indice: 1,
      resumen: "Parte amistoso.",
      util: true,
      documento: { tipo: "Parte", fecha: null, patente: null, dni: null, nombre: null, lugar: null, provincia: null },
      mecanica: mecanica({ embistio_de_atras: "asegurado" }),
    };
    const { delCaso } = await correr({ adjuntos: [adjunto({})], vistos: VISTOS, claim: { ...choque, adjuntos: [lectura] } });
    expect(delCaso?.responsabilidad).toMatchObject({ responsable: "asegurado", regla: "ley24449_art48g" });
  });

  it("un choque sin mecánica no escribe opinión", async () => {
    const { delCaso } = await correr({ claim: choque });
    expect(delCaso).not.toHaveProperty("responsabilidad");
  });

  it("un choque donde el asegurado responde ante un tercero (rc) también deja opinión", async () => {
    const { delCaso } = await correr({
      claim: { field_confidences: {}, extracted_fields: { accident_date: "2026-09-10", claim_type: "rc" }, mecanica: mecanica() },
    });
    expect(delCaso?.responsabilidad).toMatchObject({ responsable: "tercero", regla: "ley24449_art48g" });
  });

  it("si el caso ya no es un choque, borra la opinión que tenía aunque el modelo mande mecánica", async () => {
    const { delCaso } = await correr({
      fila: { responsabilidad: { v: 1, responsable: "tercero" } },
      claim: { field_confidences: {}, extracted_fields: { accident_date: "2026-09-10", claim_type: "robo" }, mecanica: mecanica() },
    });
    expect(delCaso).toHaveProperty("responsabilidad", null);
  });
});

describe("carta de un tercero (B24)", () => {
  const lecturaDeCarta = {
    indice: 1,
    resumen: "Carta documento.",
    util: true,
    documento: { tipo: "carta_reclamo", fecha: null, patente: null, dni: null, nombre: null, lugar: null, provincia: null },
    mecanica: null,
  };

  it("la carta que el modelo reconoció en esta corrida se lee después de contestar, con el archivo que ya vio", async () => {
    const { atenderCartas, orquestador } = await correr({
      adjuntos: [adjunto({})],
      vistos: VISTOS,
      claim: { adjuntos: [lecturaDeCarta] },
    });
    expect(atenderCartas).toHaveBeenCalledTimes(1);
    const pedido = atenderCartas.mock.calls[0]![0];
    expect(pedido).toMatchObject({ tenantId: TENANT_ID, caseId: CASE_ID, vistos: VISTOS });
    expect(pedido.adjuntos[0].datos).toMatchObject({ tipo: "carta_reclamo" });
    expect(orquestador.mock.invocationCallOrder[0]).toBeLessThan(atenderCartas.mock.invocationCallOrder[0]!);
  });

  it("la lectura sale de la respuesta del worker: el re-despacho no espera a que el modelo lea la carta", async () => {
    const pendientes: Array<() => Promise<void>> = [];
    const { atenderCartas } = await correr({
      adjuntos: [adjunto({})],
      vistos: VISTOS,
      claim: { adjuntos: [lecturaDeCarta] },
      despues: (tarea) => void pendientes.push(tarea),
    });
    // La corrida ya terminó y la carta todavía no se leyó.
    expect(atenderCartas).not.toHaveBeenCalled();
    expect(pendientes).toHaveLength(1);

    await pendientes[0]!();
    expect(atenderCartas).toHaveBeenCalledTimes(1);
    expect(atenderCartas.mock.calls[0]![0]).toMatchObject({ tenantId: TENANT_ID, caseId: CASE_ID, vistos: VISTOS });
  });

  it("si Next no puede agendar la lectura, se lee en el momento y no se pierde", async () => {
    const { atenderCartas } = await correr({
      adjuntos: [adjunto({})],
      vistos: VISTOS,
      claim: { adjuntos: [lecturaDeCarta] },
      despues: () => {
        throw new Error("`after` was called outside a request scope");
      },
    });
    expect(atenderCartas).toHaveBeenCalledTimes(1);
  });

  it("se lee cuando la corrida ya soltó la reserva del caso: leerla antes demoraría la respuesta de lo que entre", async () => {
    const { atenderCartas, espiaDeUpdate } = await correr({
      adjuntos: [adjunto({})],
      vistos: VISTOS,
      claim: { adjuntos: [lecturaDeCarta] },
    });
    const soltar = espiaDeUpdate.mock.calls.findIndex(([d]) => d.extraction_lease_at === null);
    expect(soltar).toBeGreaterThanOrEqual(0);
    expect(espiaDeUpdate.mock.invocationCallOrder[soltar]).toBeLessThan(atenderCartas.mock.invocationCallOrder[0]!);
  });

  it("no se lee si la corrida no terminó: el caso queda para el barrido, sin carta que leer", async () => {
    const { atenderCartas } = await correr({
      adjuntos: [adjunto({})],
      vistos: VISTOS,
      claim: { adjuntos: [lecturaDeCarta] },
      error: { status: 500 },
    });
    expect(atenderCartas).not.toHaveBeenCalled();
  });

  it("le pasa el momento en que Vercel mata la invocación, o uno propio si nadie se lo dio", async () => {
    const dada = await correr({ adjuntos: [adjunto({})], vistos: VISTOS, hasta: 1_800_000_000_000 });
    expect(dada.atenderCartas.mock.calls[0]![0].hasta).toBe(1_800_000_000_000);

    const antes = Date.now();
    const propia = await correr({ adjuntos: [adjunto({})], vistos: VISTOS });
    const { hasta } = propia.atenderCartas.mock.calls[0]![0];
    expect(hasta).toBeGreaterThan(antes);
    expect(hasta).toBeLessThanOrEqual(Date.now() + 180_000);
  });

  it("si las lecturas de esta corrida no se pudieron guardar, no se usan: la próxima corrida pisaría la carta", async () => {
    const { atenderCartas } = await correr({
      adjuntos: [adjunto({})],
      vistos: VISTOS,
      claim: { adjuntos: [lecturaDeCarta] },
      lecturasAnotadas: false,
    });
    expect(atenderCartas.mock.calls[0]![0].adjuntos).toEqual([adjunto({})]);
    expect(atenderCartas.mock.calls[0]![0].adjuntos[0].datos).toBeNull();
  });

  it("sin lectura de esta corrida, las filas van como estaban", async () => {
    const previa = adjunto({ datos: { tipo: "carta_reclamo", fecha: null, patente: null, dni: null, nombre: null, lugar: null, provincia: null } });
    const { atenderCartas } = await correr({ adjuntos: [previa] });
    expect(atenderCartas.mock.calls[0]![0].adjuntos).toEqual([previa]);
  });

  it("lo que se lee de la carta no entra al orquestador ni al registro de la corrida", async () => {
    const { orquestador, logAgentRun } = await correr({
      adjuntos: [adjunto({})],
      vistos: VISTOS,
      claim: { adjuntos: [lecturaDeCarta] },
    });
    expect(orquestador.mock.calls[0]![2].extractedClaim.adjuntos).toEqual([]);
    expect(JSON.stringify(logAgentRun.mock.calls)).not.toContain("carta_reclamo");
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
