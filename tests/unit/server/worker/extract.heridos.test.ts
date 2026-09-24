/**
 * «No hubo personas lastimadas», dicho por nadie (ensayos del 23/09).
 *
 * El modelo leía el silencio sobre heridos como «none», el worker lo guardaba
 * y la pregunta salía como «¿Hubo personas lastimadas?: no». Si la persona no
 * nombró heridos, ese negativo no se guarda ni se propone: queda la pregunta
 * abierta, en los dos canales, y la gravedad no se toca.
 *
 * Y la respuesta a esa pregunta abierta se toma: el modelo no ve que se la
 * hicimos, así que un «No» suelto no le decía nada y el caso quedaba esperando.
 */

import { describe, it, expect, vi, afterEach } from "vitest";

import { filaDeCaso, registrarMocks, type Conversacion } from "./worker-harness";

// Cada caso reimporta el grafo entero del worker: ver extract.overlay.test.ts.
vi.setConfig({ testTimeout: 30_000 });

const CASE_ID = "heridos-test-0000-0000-000000000001";
const TENANT_ID = "heridos-test-0000-0000-000000000002";

const SIN_HERIDOS = { field_key: "hay_heridos", field_value: "none", confidence: 0.9, source: "ai" };

afterEach(() => {
  vi.restoreAllMocks();
});

const heridos = (field_value: string) =>
  expect.objectContaining({ field_key: "hay_heridos", field_value, confidence: 0.95 });

async function correr(
  channel: string,
  {
    cuerpo,
    pedido,
    modelo = [SIN_HERIDOS],
    propuestos,
    conversacion,
  }: { cuerpo?: string; pedido?: string[]; modelo?: Array<typeof SIN_HERIDOS> } & Conversacion = {}
) {
  vi.resetModules();

  const espiaDeUpdate = vi.fn();
  const { mockDb } = registrarMocks({
    fila: filaDeCaso(CASE_ID, TENANT_ID, { channel }),
    espiaDeUpdate,
    extractor: {
      fields: [
        { field_key: "claim_type", field_value: "choque", confidence: 0.88, source: "ai" },
        ...modelo,
      ],
      severity: "low",
    },
    cuerpo,
    pedido,
    propuestos,
    conversacion,
  });

  const { runEmailExtractionWorker } = await import("@/server/worker/extract");
  await runEmailExtractionWorker(CASE_ID, TENANT_ID, null);

  const { orchestratePostExtraction } = await import("@/server/confirmations/orchestrate");
  const { classifySeverity } = await import("@/server/ai/severity-classifier");
  const llamadas = vi.mocked(orchestratePostExtraction).mock.calls;
  expect(llamadas).toHaveLength(1);

  // Todo lo que se escribió con `.values(...)`, fila por fila.
  const escrito = vi
    .mocked(mockDb.insert)
    .mock.results.flatMap((r) => (r.value as { values: ReturnType<typeof vi.fn> }).values.mock.calls)
    .flatMap((c) => [c[0]].flat()) as Array<{ field_key?: string }>;

  return {
    claim: llamadas[0][2].extractedClaim,
    preguntadas: llamadas[0][2].preguntadas,
    escrito: escrito.map((f) => f.field_key),
    severidadDelModelo: vi.mocked(classifySeverity).mock.calls[0]?.[1],
    caso: Object.assign({}, ...espiaDeUpdate.mock.calls.map((c) => c[0])) as Record<string, unknown>,
  };
}

describe("el worker no inventa que no hubo heridos", () => {
  it.each(["email", "whatsapp"])("por %s, sin que la persona los nombre", async (channel) => {
    const { claim, escrito, severidadDelModelo } = await correr(channel);

    expect(claim.fields.map((f) => f.field_key)).not.toContain("hay_heridos");
    expect(escrito).not.toContain("hay_heridos");
    expect(claim.fields_pending_confirmation).toContain("hay_heridos");
    expect(claim.severity).toBe("low");
    expect(severidadDelModelo).toBe("low");
  });

  it.each(["email", "whatsapp"])("por %s, respeta el «no» que la persona dijo", async (channel) => {
    const { claim, escrito } = await correr(channel, { cuerpo: "Choqué ayer en Alem. No hubo heridos." });

    expect(claim.fields).toContainEqual(expect.objectContaining(SIN_HERIDOS));
    expect(escrito).toContain("hay_heridos");
    expect(claim.fields_pending_confirmation).not.toContain("hay_heridos");
  });
});

describe("la respuesta a «¿Hubo personas lastimadas?» abierta", () => {
  const canales = (respuestas: string[]) =>
    respuestas.flatMap((r) => (["email", "whatsapp"] as const).map((c) => [r, c] as const));

  it.each(canales(["No", "Nadie", "Ninguno", "Estamos todos bien", "no, solo el auto"]))(
    "«%s» por %s cierra la pregunta con un no",
    async (cuerpo, channel) => {
      const { claim, escrito, preguntadas, caso } = await correr(channel, {
        cuerpo,
        pedido: ["hay_heridos"],
      });

      expect(claim.fields).toContainEqual(heridos("no"));
      expect(escrito).toContain("hay_heridos");
      expect(claim.fields_pending_confirmation).not.toContain("hay_heridos");
      expect(caso.injury_severity).toBe("none");
      expect(claim.severity).toBe("low");
      // El orquestador no la vuelve a leer.
      expect(preguntadas).toEqual(["hay_heridos"]);
    }
  );

  it.each(canales(["Sí", "si"]))("«%s» por %s la cierra con un sí y deriva", async (cuerpo, channel) => {
    const { claim, escrito, severidadDelModelo } = await correr(channel, {
      cuerpo,
      pedido: ["hay_heridos"],
      modelo: [],
    });

    expect(claim.fields).toContainEqual(heridos("sí"));
    expect(escrito).toContain("hay_heridos");
    expect(claim.fields_pending_confirmation).not.toContain("hay_heridos");
    expect(claim.severity).toBe("high");
    expect(claim.requires_specialist).toBe(true);
    expect(severidadDelModelo).toBe("high");
  });

  it.each(canales(["No sé", "ok"]))("«%s» por %s la deja abierta", async (cuerpo, channel) => {
    const { claim, escrito } = await correr(channel, { cuerpo, pedido: ["hay_heridos"] });

    expect(escrito).not.toContain("hay_heridos");
    expect(claim.fields_pending_confirmation).toContain("hay_heridos");
    expect(claim.severity).toBe("low");
  });

  it("un «No» a una lista de varias cosas no dice que no hubo heridos", async () => {
    const { claim, escrito } = await correr("whatsapp", { cuerpo: "No", pedido: ["dni", "hay_heridos"] });

    expect(escrito).not.toContain("hay_heridos");
    expect(claim.fields_pending_confirmation).toContain("hay_heridos");
  });
});

/*
 * Con un valor adentro de la pregunta —«¿Es correcto que no hubo personas
 * lastimadas?»— el «Sí» es «sí, nadie» y el «No» es «sí hubo». Leerlos como
 * respuesta a la pregunta abierta derivaba por heridos a quien dijo que no los
 * había, y cerraba en «no» a quien dijo que sí. Pasa con los casos en vuelo que
 * tienen el «none» de antes del arreglo pendiente.
 */
describe("la respuesta a una confirmación de heridos con valor", () => {
  const canales = ["email", "whatsapp"] as const;

  it.each(canales)("un «Sí» por %s no deriva ni escribe heridos", async (channel) => {
    const { claim, escrito, severidadDelModelo, caso } = await correr(channel, {
      cuerpo: "Sí",
      pedido: ["hay_heridos"],
      propuestos: { hay_heridos: "none" },
      modelo: [],
    });

    expect(claim.fields.map((f) => f.field_key)).not.toContain("hay_heridos");
    expect(escrito).not.toContain("hay_heridos");
    expect(claim.severity).toBe("low");
    expect(claim.requires_specialist).toBe(false);
    expect(severidadDelModelo).toBe("low");
    expect(caso.requires_specialist).not.toBe(true);
  });

  it.each(canales)("un «No» por %s no lo cierra en «no hubo»", async (channel) => {
    const { claim, escrito, caso } = await correr(channel, {
      cuerpo: "No",
      pedido: ["hay_heridos"],
      propuestos: { hay_heridos: "none" },
    });

    expect(claim.fields).not.toContainEqual(expect.objectContaining({ field_key: "hay_heridos" }));
    expect(escrito).not.toContain("hay_heridos");
    expect(claim.fields_pending_confirmation).toContain("hay_heridos");
    expect(caso.injury_severity).not.toBe("none");
  });
});

/*
 * Lo que escribió desde el pedido, y no sólo el último mensaje: un «No» con un
 * «gracias» o una foto atrás llegaba como «gracias» y la pregunta quedaba abierta.
 */
describe("la respuesta repartida en varios mensajes", () => {
  const ANTES = "2026-09-23 12:00:00+00";
  const PEDIDO = "2026-09-23 12:05:00.123+00";
  const DESPUES = (s: number) => `2026-09-23 12:06:${String(s).padStart(2, "0")}+00`;

  it.each([
    ["email", ["No\nJuan Pérez\nTel 291 555-1234"]],
    ["whatsapp", ["No", "gracias"]],
    ["whatsapp", ["Nadie", "[Imagen adjunta sin texto]"]],
  ] as const)("por %s, %j cierra la pregunta con un no", async (channel, respuesta) => {
    const { claim, caso } = await correr(channel, {
      cuerpo: respuesta[respuesta.length - 1],
      pedido: ["hay_heridos"],
      conversacion: {
        enviado: PEDIDO,
        mensajes: [["Choqué ayer en Alem.", ANTES], ...respuesta.map((t, i) => [t, DESPUES(i)] as [string, string])],
      },
    });

    expect(claim.fields).toContainEqual(heridos("no"));
    expect(caso.injury_severity).toBe("none");
  });

  it("lo que escribió antes del pedido no lo contesta", async () => {
    const { claim, escrito } = await correr("whatsapp", {
      cuerpo: "No",
      pedido: ["hay_heridos"],
      conversacion: { enviado: PEDIDO, mensajes: [["No", ANTES]] },
    });

    expect(escrito).not.toContain("hay_heridos");
    expect(claim.fields_pending_confirmation).toContain("hay_heridos");
  });
});
