/**
 * Un documento al modelo (B6, B21, B24): motor, presupuesto de IA y cupo antes de
 * gastar; el consumo se anota; y sin lectura vuelve el motivo, nunca un dato
 * inventado. Tampoco tira: la pantalla dice «sin leer».
 */

import { beforeEach, describe, expect, it, vi } from "vitest";
import { z } from "zod";

const m = vi.hoisted(() => ({
  motor: vi.fn(),
  checkBudget: vi.fn(),
  soltar: vi.fn(),
  registrar: vi.fn(),
  rateLimit: vi.fn(),
  callGemini: vi.fn(),
  contarTokens: vi.fn(),
  warn: vi.fn(),
}));

vi.mock("server-only", () => ({}));
vi.mock("@/server/ai/provider", () => ({ resolveExtractionEngine: m.motor }));
vi.mock("@/server/ai/budget", () => ({
  checkBudget: m.checkBudget,
  registrarConsumoDelModelo: m.registrar,
  soltarReserva: m.soltar,
}));
vi.mock("@/server/ai/gemini-extractor", () => ({ callGemini: m.callGemini, contarTokens: m.contarTokens }));
vi.mock("@/server/worker/adjuntos", () => ({ PLAZO_DE_CONTEO_MS: 1000, TOPE_TOKENS_PDF: 5000 }));
vi.mock("@/lib/rate-limit/index", () => ({
  rateLimit: m.rateLimit,
  RATE_LIMIT_CONFIGS: {
    CONDICIONES_POR_POLIZA: { limit: 5, windowMs: 1 },
    LECTURA_PRESUPUESTO_POR_CASO: { limit: 5, windowMs: 2 },
    LECTURA_RECLAMO_POR_CASO: { limit: 3, windowMs: 3 },
    ASISTENTE_CASO: { limit: 30, windowMs: 4 },
  },
}));
vi.mock("@/lib/observability/logger", () => ({ logger: { warn: m.warn, error: vi.fn(), info: vi.fn() } }));

import { leerDocumento } from "@/server/ai/leer-documento";

const TENANT = "10000000-0000-0000-0000-000000000001";
const USUARIO = "20000000-0000-0000-0000-000000000001";
const CASO = "11111111-1111-1111-1111-111111111111";
const PDF = { mimeType: "application/pdf", data: "JVBERi0=" };
const Schema = z.object({ total: z.number() });

const leer = (extra: Partial<Parameters<typeof leerDocumento<{ total: number }>>[0]> = {}) =>
  leerDocumento({
    tenantId: TENANT,
    userId: USUARIO,
    caseId: CASO,
    ambito: "lectura-presupuesto",
    partesDeClave: [TENANT, "caso-1"],
    sistema: "sistema",
    usuario: "<presupuesto_taller>nota</presupuesto_taller>",
    media: [PDF],
    schema: Schema,
    ...extra,
  });

beforeEach(() => {
  vi.clearAllMocks();
  m.motor.mockResolvedValue("gemini");
  m.checkBudget.mockResolvedValue({ exceeded: false });
  m.rateLimit.mockResolvedValue({ allowed: true });
  m.contarTokens.mockResolvedValue(1200);
  m.callGemini.mockResolvedValue({ text: '{"total": 5}', model: "gemini-2.5-flash", usage: { promptTokens: 9 } });
  m.registrar.mockResolvedValue(undefined);
});

describe("leerDocumento", () => {
  it("lee, valida y anota el consumo a nombre de quien lo pidió", async () => {
    await expect(leer()).resolves.toEqual({ ok: { total: 5 } });
    expect(m.registrar).toHaveBeenCalledWith(TENANT, "gemini-2.5-flash", { promptTokens: 9 }, USUARIO, CASO);
    expect(m.callGemini).toHaveBeenCalledWith("sistema", expect.any(String), undefined, undefined, [PDF]);
  });

  it("el cupo es por caso o por póliza, con su propia configuración", async () => {
    await leer();
    expect(m.rateLimit).toHaveBeenCalledWith(`lectura-presupuesto:${TENANT}:caso-1`, { limit: 5, windowMs: 2 });

    await leer({ ambito: "condiciones-poliza", partesDeClave: [TENANT, "poliza-1"] });
    expect(m.rateLimit).toHaveBeenLastCalledWith(`condiciones-poliza:${TENANT}:poliza-1`, { limit: 5, windowMs: 1 });

    await leer({ ambito: "lectura-reclamo" });
    expect(m.rateLimit).toHaveBeenLastCalledWith(`lectura-reclamo:${TENANT}:caso-1`, { limit: 3, windowMs: 3 });

    await leer({ ambito: "asistente-caso", partesDeClave: [TENANT, USUARIO, "caso-1"] });
    expect(m.rateLimit).toHaveBeenLastCalledWith(`asistente-caso:${TENANT}:${USUARIO}:caso-1`, { limit: 30, windowMs: 4 });
  });

  it.each([
    ["mock", () => m.motor.mockResolvedValue("mock")],
    ["presupuesto", () => m.checkBudget.mockResolvedValue({ exceeded: true })],
    ["cupo", () => m.rateLimit.mockResolvedValue({ allowed: false })],
    ["cupo", () => m.rateLimit.mockRejectedValue(new Error("sin base"))],
    ["archivo", () => m.contarTokens.mockResolvedValue("rechazo")],
    ["modelo", () => m.contarTokens.mockResolvedValue("plazo")],
    ["modelo", () => m.contarTokens.mockResolvedValue(null)],
    ["paginas", () => m.contarTokens.mockResolvedValue(5001)],
  ])("sin «%s» no llama al modelo ni gasta", async (motivo, preparar) => {
    preparar();
    await expect(leer()).resolves.toEqual({ sinLeer: motivo });
    expect(m.callGemini).not.toHaveBeenCalled();
    expect(m.registrar).not.toHaveBeenCalled();
  });

  it("un PDF que no se va a leer no gasta un intento del cupo", async () => {
    for (const cuenta of ["rechazo", "plazo", 5001]) {
      m.contarTokens.mockResolvedValueOnce(cuenta);
      await leer();
    }
    expect(m.rateLimit).not.toHaveBeenCalled();
  });

  it.each([
    ["cupo", () => m.rateLimit.mockResolvedValue({ allowed: false })],
    ["archivo", () => m.contarTokens.mockResolvedValue("rechazo")],
    ["modelo", () => m.contarTokens.mockResolvedValue("plazo")],
    ["paginas", () => m.contarTokens.mockResolvedValue(5001)],
  ])("sin «%s» una prueba devuelve lo que reservó de su cupo diario", async (motivo, preparar) => {
    const reserva = { clave: "ia:prueba:t", ventanas: [123] };
    m.checkBudget.mockResolvedValue({ exceeded: false, reserva });
    preparar();

    await expect(leer()).resolves.toEqual({ sinLeer: motivo });

    expect(m.soltar).toHaveBeenCalledTimes(1);
    expect(m.soltar).toHaveBeenCalledWith(reserva);
  });

  it("si llama al modelo la reserva se gasta y no se devuelve", async () => {
    m.checkBudget.mockResolvedValue({ exceeded: false, reserva: { clave: "ia:prueba:t", ventanas: [123] } });

    await expect(leer()).resolves.toEqual({ ok: { total: 5 } });

    expect(m.soltar).not.toHaveBeenCalled();
  });

  it("una respuesta vacía, que no es JSON o que no valida, queda sin leer pero se anota", async () => {
    for (const [text, motivo] of [
      ["", "modelo"],
      ["no es json", "formato"],
      ['{"total": "cinco"}', "formato"],
    ] as const) {
      m.callGemini.mockResolvedValueOnce({ text, model: "gemini-2.5-flash", usage: { promptTokens: 1 } });
      await expect(leer()).resolves.toEqual({ sinLeer: motivo });
    }
    expect(m.registrar).toHaveBeenCalledTimes(3);
  });

  it("un error del modelo no tira y el log no lleva nada del documento", async () => {
    m.callGemini.mockRejectedValue(new Error("contenido secreto del PDF"));
    await expect(leer()).resolves.toEqual({ sinLeer: "modelo" });
    expect(JSON.stringify(m.warn.mock.calls)).not.toContain("secreto");
  });

  it("aplica la limpieza sobre lo validado", async () => {
    await expect(leer({ limpiar: (d) => ({ total: d.total * 2 }) })).resolves.toEqual({ ok: { total: 10 } });
  });

  it("una foto no se cuenta como PDF", async () => {
    await leer({ media: [{ mimeType: "image/jpeg", data: "x" }] });
    expect(m.contarTokens).not.toHaveBeenCalled();
  });
});
