/**
 * Las reglas del equipo, vistas desde el orquestador (H14).
 *
 * Con la bandera `AGENTE_APRENDIDO_EN_CONVERSACION` prendida, el worker les pasa
 * a `deliberate` y a `compose` lo que las reglas activas dicen sobre decidir y
 * sobre redactar, con las mismas reglas que lee la extracción y sin una
 * consulta más. Apagada, el objeto que recibe el orquestador es el de siempre.
 */

import { describe, it, expect, vi, afterEach } from "vitest";

import { filaDeCaso, registrarMocks } from "./worker-harness";

// Cada caso reimporta el grafo entero del worker: ver extract.overlay.test.ts.
vi.setConfig({ testTimeout: 30_000 });

const CASE_ID = "indicaciones-test-0000-0000-000000000001";
const TENANT_ID = "indicaciones-test-0000-0000-000000000002";

const PEDIR_EL_DNI = "- [missing_fields] Pedí primero el DNI: si faltan varios datos, empezá por el DNI.";
const CERCANIA = "- [reply_style] Cercanía: escribí corto y sin vueltas.";

const REGLAS = [
  {
    id: "regla-1",
    title: "Pedí primero el DNI",
    rule_text: "si faltan varios datos, empezá por el DNI.",
    rule_type: "missing_fields",
  },
  { id: "regla-2", title: "Cercanía", rule_text: "escribí corto y sin vueltas.", rule_type: "reply_style" },
  {
    id: "regla-3",
    title: "Sitio",
    rule_text: "mandalo a www.x.com para ver el estado.",
    rule_type: "reply_style",
  },
];

afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllEnvs();
});

async function correr() {
  vi.resetModules();

  const { mockDb } = registrarMocks({ fila: filaDeCaso(CASE_ID, TENANT_ID), espiaDeUpdate: vi.fn() });

  // El lote falla y el worker vuelve a cargar las reglas de a una: ahí entran las de la prueba.
  vi.doMock("@/server/training/prompt-rules", async (importOriginal) => ({
    ...(await importOriginal<typeof import("@/server/training/prompt-rules")>()),
    consultaPromptRules: () => {
      throw new Error("sin lote");
    },
    loadActivePromptRules: vi.fn(async () => REGLAS),
  }));

  const { runEmailExtractionWorker } = await import("@/server/worker/extract");
  await runEmailExtractionWorker(CASE_ID, TENANT_ID, null);

  const { orchestratePostExtraction } = await import("@/server/confirmations/orchestrate");
  const llamadas = vi.mocked(orchestratePostExtraction).mock.calls;
  expect(llamadas).toHaveLength(1);

  return { salida: llamadas[0][2], consultas: vi.mocked(mockDb.select).mock.calls.length };
}

describe("el worker le pasa al orquestador lo que dicen las reglas del equipo", () => {
  it("con la bandera apagada el objeto no tiene la clave", async () => {
    vi.stubEnv("AGENTE_APRENDIDO_EN_CONVERSACION", undefined);

    const { salida } = await correr();

    expect(Object.keys(salida)).not.toContain("aprendido");
  });

  it("con la bandera en 0 tampoco", async () => {
    vi.stubEnv("AGENTE_APRENDIDO_EN_CONVERSACION", "0");

    const { salida } = await correr();

    expect(Object.keys(salida)).not.toContain("aprendido");
  });

  it("con la bandera prendida, decidir trae la regla de missing_fields", async () => {
    vi.stubEnv("AGENTE_APRENDIDO_EN_CONVERSACION", "1");

    const { salida } = await correr();

    expect(salida.aprendido?.decidir).toBe(PEDIR_EL_DNI);
  });

  it("y redactar trae sólo la reply_style limpia: la del enlace no entra", async () => {
    vi.stubEnv("AGENTE_APRENDIDO_EN_CONVERSACION", "1");

    const { salida } = await correr();

    expect(salida.aprendido?.redactar).toBe(CERCANIA);
    expect(salida.aprendido?.redactar).not.toContain("www.");
    expect(salida.aprendido?.decidir).not.toContain("www.");
  });

  it("no suma consultas: las reglas son las que ya cargó el prompt", async () => {
    vi.stubEnv("AGENTE_APRENDIDO_EN_CONVERSACION", undefined);
    const apagada = await correr();
    vi.unstubAllEnvs();

    vi.stubEnv("AGENTE_APRENDIDO_EN_CONVERSACION", "1");
    const prendida = await correr();

    expect(prendida.consultas).toBe(apagada.consultas);
  });
});
