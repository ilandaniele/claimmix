/**
 * La opinión de responsabilidad (B18) y lo que reclama un tercero (B24) son
 * del equipo: nada de eso llega al asegurado.
 *
 * Las puertas por las que le llega algo al asegurado son la respuesta del
 * agente y su prompt, las plantillas y el aviso por mail. Acá se prueba en
 * ejecución lo que `la-cobertura-no-sale-al-asegurado.test.ts` prueba en el
 * grafo de imports: ni lo que se le pide al redactor ni lo que el redactor
 * puede devolver lleva la culpa, la ley de tránsito o los montos de una carta.
 */

vi.mock("@/server/ai/gemini-extractor", () => ({
  callGemini: vi.fn(),
  errMeta: (e: unknown) => ({ name: e instanceof Error ? e.name : "UnknownError", status: null, code: null }),
}));

import { describe, it, expect, vi, beforeEach } from "vitest";

import { composeReply, type ReplyIntent } from "@/server/ai/compose-reply";
import { callGemini } from "@/server/ai/gemini-extractor";
import { buildEmailClaimPrompt } from "@/server/ai/prompt";

const mockCall = callGemini as unknown as ReturnType<typeof vi.fn>;

const TENANT = "10000000-0000-0000-0000-000000000001";
const FALLBACK = "Texto de plantilla, siempre correcto.";

/** Lo que sólo sabe el equipo: la opinión, el artículo y los montos de la carta. */
const DEL_EQUIPO = /24\.?449|art48g|ley24449|\bculpa|1\.?234\.?567/i;

const RELATO =
  "Me chocaron de atrás en Rivadavia y Belgrano. El otro conductor dice que le reclamó $ 1.234.567 y que la culpa fue mía.";

const INTENCIONES: ReplyIntent[] = ["ask", "escalation", "closing", "conflict", "acknowledgement"];

beforeEach(() => {
  vi.clearAllMocks();
});

describe("lo que se le pide al redactor de respuestas", () => {
  it.each(INTENCIONES)("la intención %s no lleva la opinión ni los montos de una carta", async (intent) => {
    mockCall.mockResolvedValue({
      text: JSON.stringify({ message: "Gracias por avisarnos. Necesito tu número de póliza." }),
      usage: { promptTokens: 0, completionTokens: 0 },
    });

    await composeReply({
      intent,
      channel: "whatsapp",
      tenantId: TENANT,
      fields: ["policy_number"],
      claimTypeLabel: "choque",
      fallback: FALLBACK,
    });

    expect(mockCall).toHaveBeenCalled();
    for (const [prompt] of mockCall.mock.calls) expect(String(prompt)).not.toMatch(DEL_EQUIPO);
  });
});

describe("lo que el redactor puede devolver", () => {
  it.each([
    "Por lo que contás, el culpable es el otro conductor.",
    "Por la Ley 24.449 el que embiste desde atrás es responsable.",
    "Según el art. 48 inc. g, no tuviste responsabilidad.",
  ])("una respuesta que adelanta la culpa se descarta y sale la plantilla: %s", async (borrador) => {
    mockCall.mockResolvedValue({
      text: JSON.stringify({ message: `${borrador} Necesito tu número de póliza.` }),
      usage: { promptTokens: 0, completionTokens: 0 },
    });

    const salida = await composeReply({
      intent: "ask",
      channel: "whatsapp",
      tenantId: TENANT,
      fields: ["policy_number"],
      fallback: FALLBACK,
    });

    expect(salida).toBe(FALLBACK);
  });

  it("«responsabilidad civil» sigue siendo un nombre legítimo de siniestro y no se descarta", async () => {
    mockCall.mockResolvedValue({
      text: JSON.stringify({ message: "Tomamos tu denuncia por responsabilidad civil. Necesito tu número de póliza." }),
      usage: { promptTokens: 0, completionTokens: 0 },
    });

    const salida = await composeReply({
      intent: "ask",
      channel: "whatsapp",
      tenantId: TENANT,
      fields: ["policy_number"],
      claimTypeLabel: "responsabilidad civil",
      fallback: FALLBACK,
    });

    expect(salida).not.toBe(FALLBACK);
  });
});

describe("el prompt de la extracción", () => {
  it("le dice al modelo que la mecánica no se copia a lo que lee el asegurado y no le da ninguna opinión", () => {
    const prompt = buildEmailClaimPrompt("Choque", RELATO, [], [], "5492916426930", "", undefined, "whatsapp");

    expect(prompt).toContain("Never copy them into fields[], extracted_fields, summary or suggested_reply");
    // El relato de la persona sí está entre centinelas; lo del equipo no está en ningún lado.
    expect(prompt).not.toMatch(/24\.?449|art48g|ley24449/i);
    expect(prompt.replace(RELATO, "")).not.toMatch(DEL_EQUIPO);
  });
});
