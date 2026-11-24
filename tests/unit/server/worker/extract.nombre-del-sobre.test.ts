/**
 * El nombre del perfil de WhatsApp no pisa el que el caso ya tiene con más confianza.
 *
 * Un siniestro nuevo hereda el nombre del caso de antes (entre 0.85 y 0.95) y su
 * primera extracción sólo ve los mensajes que se mudaron. Si ahí la persona no se
 * nombra, el parser cae al nombre del perfil, a 0.70: sin esta guarda lo
 * guardaba encima del heredado y lo proponía como confirmación de confianza
 * media, y el agente volvía a preguntar el nombre. La corrida se queda con el
 * nombre guardado, no sin nombre: de ahí sale el saludo (`claimantName`).
 */

import { describe, it, expect, vi, afterEach } from "vitest";

import { filaDeCaso, registrarMocks } from "./worker-harness";

vi.setConfig({ testTimeout: 30_000 });

const CASE_ID = "sobre-test-0000-0000-000000000001";
const TENANT_ID = "sobre-test-0000-0000-000000000002";

afterEach(() => {
  vi.restoreAllMocks();
});

async function correr(confianzasGuardadas?: Record<string, { valor: string; confianza: number }>) {
  vi.resetModules();

  const { mockDb } = registrarMocks({
    fila: filaDeCaso(CASE_ID, TENANT_ID, { channel: "whatsapp" }),
    espiaDeUpdate: vi.fn(),
    extractor: {
      fields: [{ field_key: "claim_type", field_value: "choque", confidence: 0.88, source: "ai" }],
      extracted_fields: { claim_type: "choque" },
    },
    conversacion: {
      enviado: "2026-09-20T10:00:00Z",
      mensajes: [["Otra cosa: me chocaron de atrás en Punta Alta.", "2026-09-20T10:05:00Z"]],
      nombreDePerfil: "Paulo Ortiz Gómez",
    },
    confianzasGuardadas,
  });

  const { runEmailExtractionWorker } = await import("@/server/worker/extract");
  await runEmailExtractionWorker(CASE_ID, TENANT_ID, null);

  const { orchestratePostExtraction } = await import("@/server/confirmations/orchestrate");
  const llamadas = vi.mocked(orchestratePostExtraction).mock.calls;
  expect(llamadas).toHaveLength(1);

  const escrito = vi
    .mocked(mockDb.insert)
    .mock.results.flatMap((r) => (r.value as { values: ReturnType<typeof vi.fn> }).values.mock.calls)
    .flatMap((c) => [c[0]].flat()) as Array<{ field_key?: string; field_value?: string }>;

  const campos = llamadas[0][2].extractedClaim.fields;
  // Como lo toma orchestrate para saludar: el nombre que trae la corrida.
  const nombreParaSaludar = campos.find((f) => f.field_key === "full_name")?.field_value ?? null;

  return { campos, escrito, nombreParaSaludar };
}

describe("el nombre que trae el sobre", () => {
  it("sin nombre guardado entra a 0.70, como siempre", async () => {
    const { campos, escrito } = await correr();

    expect(campos).toContainEqual(
      expect.objectContaining({ field_key: "full_name", field_value: "Paulo Ortiz Gómez", confidence: 0.7, source: "canal" })
    );
    expect(escrito.map((f) => f.field_key)).toContain("full_name");
  });

  it("con un nombre guardado a 0.92 (el heredado) la corrida lo conserva, con su valor y su confianza, y el perfil no se escribe", async () => {
    const { campos, escrito } = await correr({ full_name: { valor: "Pablo Ortiz", confianza: 0.92 } });

    expect(campos).toContainEqual(
      expect.objectContaining({ field_key: "full_name", field_value: "Pablo Ortiz", confidence: 0.92, source: "canal" })
    );
    expect(campos.map((f) => f.field_value)).not.toContain("Paulo Ortiz Gómez");
    expect(escrito.map((f) => f.field_value)).not.toContain("Paulo Ortiz Gómez");
  });

  it("el agente saluda por el nombre guardado aunque esta vez no se lo escribió", async () => {
    const { nombreParaSaludar } = await correr({ full_name: { valor: "Pablo Ortiz", confianza: 0.95 } });

    expect(nombreParaSaludar).toBe("Pablo Ortiz");
  });

  it("con uno guardado a la misma confianza, sigue como antes", async () => {
    const { campos } = await correr({ full_name: { valor: "Pablo Ortiz", confianza: 0.7 } });

    expect(campos).toContainEqual(
      expect.objectContaining({ field_key: "full_name", field_value: "Paulo Ortiz Gómez", confidence: 0.7, source: "canal" })
    );
  });
});
