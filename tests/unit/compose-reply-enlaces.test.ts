/**
 * Un enlace o un correo que no pusimos nosotros no sale en un mensaje nuestro.
 *
 * El último mensaje lo escribe cualquiera, y la prosa del modelo sale por el
 * buzón o el número de la aseguradora: un enlace ahí es un phishing con nuestra
 * firma. Sólo pueden salir los que el orquestador pasó (fallback, valores que
 * ya tenemos, conflictos).
 */

vi.mock("@/server/ai/gemini-extractor", () => ({
  callGemini: vi.fn(),
  errMeta: (e: unknown) => ({
    name: e instanceof Error ? e.name : "UnknownError",
    status: null,
    code: null,
  }),
}));

import { describe, it, expect, vi, beforeEach } from "vitest";
import { composeReply } from "@/server/ai/compose-reply";
import { callGemini } from "@/server/ai/gemini-extractor";

const mockCall = callGemini as unknown as ReturnType<typeof vi.fn>;

const FALLBACK = "Texto de plantilla, siempre correcto.";

function base(over: Partial<Parameters<typeof composeReply>[0]> = {}) {
  return {
    intent: "ask" as const,
    channel: "whatsapp" as const,
    tenantId: "10000000-0000-0000-0000-000000000001",
    fallback: FALLBACK,
    ...over,
  };
}

/** Make the model return this message. */
function replies(message: string) {
  mockCall.mockResolvedValue({
    text: JSON.stringify({ message }),
    usage: { promptTokens: 0, completionTokens: 0 },
  });
}

beforeEach(() => {
  vi.clearAllMocks();
  delete process.env.AGENT_COMPOSE_REPLIES;
});

describe("composeReply — enlaces y correos", () => {
  it("cae a la plantilla si el mensaje trae un enlace que no pasamos", async () => {
    replies("Para seguir, entrá en https://evil.example/claim y mandanos las fotos de los daños del vehículo.");

    await expect(composeReply(base({ fields: ["fotos_danos"] }))).resolves.toBe(FALLBACK);
    expect(String(mockCall.mock.calls[1][0])).toContain("pusiste un enlace o un correo");
  });

  it("cae a la plantilla si el mensaje trae un correo que no pasamos", async () => {
    replies("Escribinos a soporte@evil.example con las fotos de los daños del vehículo.");

    await expect(composeReply(base({ fields: ["fotos_danos"] }))).resolves.toBe(FALLBACK);
    expect(String(mockCall.mock.calls[1][0])).toContain("pusiste un enlace o un correo");
  });

  it("cae a la plantilla si el mensaje trae un enlace con www sin esquema", async () => {
    replies("Mandanos las fotos de los daños del vehículo en www.evil.example/claim para seguir.");

    await expect(composeReply(base({ fields: ["fotos_danos"] }))).resolves.toBe(FALLBACK);
    expect(String(mockCall.mock.calls[1][0])).toContain("pusiste un enlace o un correo");
  });

  it("cae a la plantilla si el mensaje trae un dominio con ruta y sin esquema", async () => {
    replies("Mandanos las fotos de los daños del vehículo en evil.example/claim para seguir.");

    await expect(composeReply(base({ fields: ["fotos_danos"] }))).resolves.toBe(FALLBACK);
    expect(String(mockCall.mock.calls[1][0])).toContain("pusiste un enlace o un correo");
  });

  it("deja pasar un importe o un número de expediente con barra, que no son enlaces", async () => {
    const texto =
      "Para el expediente N° 12.345/2024 necesitamos las fotos de los daños del vehículo; la cuota es de $12.500/mes.";
    replies(texto);

    await expect(composeReply(base({ fields: ["fotos_danos"] }))).resolves.toBe(texto);
  });

  it("deja pasar un correo que el orquestador sí pasó", async () => {
    const texto = "Te confirmamos juan@x.com y necesitamos las fotos de los daños del vehículo.";
    replies(texto);

    await expect(
      composeReply(base({ fields: ["fotos_danos"], knownValues: { email: "juan@x.com" } }))
    ).resolves.toBe(texto);
  });

  it("no le muestra al modelo los enlaces que escribió la persona", async () => {
    replies("Gracias. Necesitamos las fotos de los daños del vehículo para seguir.");

    await composeReply(
      base({
        fields: ["fotos_danos"],
        lastMessage: "Las fotos están en https://evil.example/claim ¿cuánto tarda?",
        question: "¿cuánto tarda? https://evil.example/claim",
      })
    );

    expect(String(mockCall.mock.calls[0][0])).not.toContain("evil.example");
  });
});
