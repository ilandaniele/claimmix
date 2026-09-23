/**
 * El worker le avisa al orquestador que quien escribe no es el titular.
 *
 * Lo sabe con lo que ya buscó: la póliza la encontró el padrón, y ni el
 * nombre ni el DNI que dio la persona son los del titular. Sin consultas
 * nuevas y con los mismos datos con los que buscó al cliente, así que lo que
 * llegó por el canal —el nombre del perfil de WhatsApp, el remitente— no
 * cuenta como algo que la persona dijo.
 */

import { describe, it, expect, vi, afterEach } from "vitest";

import { filaDeCaso, registrarMocks, type OpcionesDelExtractor } from "./worker-harness";

// Cada caso reimporta el grafo entero del worker: ver extract.overlay.test.ts.
vi.setConfig({ testTimeout: 30_000 });

const CASE_ID = "titular-test-0000-0000-000000000001";
const TENANT_ID = "titular-test-0000-0000-000000000002";

const ROBERTO = {
  customerId: "cust-003",
  matchType: "policy_number",
  confidence: 0.9,
  customerName: "Roberto Paz",
  conflictsWithExtracted: ["full_name", "dni"],
  storedValues: { full_name: "Roberto Paz", dni: "26880140" },
};

const CAMPO = (clave: string, valor: string, source = "ai") => ({
  field_key: clave,
  field_value: valor,
  confidence: 0.93,
  source,
});

const LUCIA: OpcionesDelExtractor = {
  fields: [CAMPO("full_name", "Lucía Paz"), CAMPO("dni", "41.207.663")],
  extracted_fields: { full_name: "Lucía Paz", dni: "41.207.663" },
};

afterEach(() => {
  vi.restoreAllMocks();
});

/** Corre el worker y devuelve lo que le pasó al orquestador en `titularAjeno`. */
async function titularAjeno(
  extractor: OpcionesDelExtractor,
  encontrados: unknown[],
  channel = "email"
): Promise<unknown> {
  vi.resetModules();

  const { espiaDeBusqueda } = registrarMocks({
    fila: filaDeCaso(CASE_ID, TENANT_ID, { channel }),
    espiaDeUpdate: vi.fn(),
    extractor,
  });
  espiaDeBusqueda.mockResolvedValue(encontrados);

  const { runEmailExtractionWorker } = await import("@/server/worker/extract");
  await runEmailExtractionWorker(CASE_ID, TENANT_ID, null);

  // Ni una búsqueda más: la señal sale de lo que ya se buscó.
  expect(espiaDeBusqueda).toHaveBeenCalledTimes(1);

  const { orchestratePostExtraction } = await import("@/server/confirmations/orchestrate");
  const llamadas = vi.mocked(orchestratePostExtraction).mock.calls;
  expect(llamadas).toHaveLength(1);
  return llamadas[0][2].titularAjeno;
}

describe("el worker ve que quien escribe no es el titular", () => {
  it.each(["email", "whatsapp"])("por %s, con la póliza de otro", async (channel) => {
    expect(await titularAjeno(LUCIA, [ROBERTO], channel)).toBe(true);
  });

  it("una coincidencia sólo por correo no vincula, y no cuenta", async () => {
    expect(await titularAjeno(LUCIA, [{ ...ROBERTO, matchType: "email" }])).toBe(false);
  });

  it("el titular que escribe con otro formato no es otra persona", async () => {
    const roberto = {
      fields: [CAMPO("full_name", "PAZ, Roberto"), CAMPO("dni", "26.880.140")],
      extracted_fields: { full_name: "PAZ, Roberto", dni: "26.880.140" },
    };
    expect(await titularAjeno(roberto, [ROBERTO])).toBe(false);
  });

  it("el nombre que llegó por el canal no es algo que la persona dijo", async () => {
    // Sin `full_name` en `extracted_fields`: si lo tuviera, lo volvería a poner.
    const delPerfil = {
      fields: [CAMPO("full_name", "Lucía Paz", "canal"), CAMPO("dni", "41.207.663")],
      extracted_fields: { dni: "41.207.663" },
    };
    expect(await titularAjeno(delPerfil, [ROBERTO])).toBe(false);
  });
});
