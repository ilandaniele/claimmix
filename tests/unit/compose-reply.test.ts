/**
 * Letting the model write, without letting it decide.
 *
 * The orchestrator picks what to say; this only picks how. Everything here is
 * about the second half not quietly changing the first — a message that drops
 * one of the four fields we asked for, an escalation that asks for data after
 * promising nobody has to do anything, or a sentence that commits the insurer
 * to paying before anyone looked at the claim.
 *
 * When a check fails the claimant gets the template. Duller, always correct.
 */

vi.mock("@/server/ai/gemini-extractor", () => ({
  callGemini: vi.fn(),
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

describe("composeReply — when it works", () => {
  it("uses the written message over the template", async () => {
    replies(
      "Lamento lo del choque. Para seguir necesito el número de póliza y tu DNI, " +
        "cuando puedas me los pasás por acá."
    );

    const out = await composeReply(
      base({ fields: ["policy_number", "dni"], lastMessage: "Choqué en Alem" })
    );

    expect(out).toContain("póliza");
    expect(out).not.toBe(FALLBACK);
  });
});

describe("composeReply — what it refuses to send", () => {
  it("refuses a message that quietly drops a field we asked for", async () => {
    // The orchestrator asked for four things; the claimant would see three,
    // answer them, and be asked again for the fourth.
    replies("Necesito tu número de póliza y el DNI del titular para seguir.");

    const out = await composeReply(
      base({ fields: ["policy_number", "dni", "accident_date"] })
    );

    expect(out).toBe(FALLBACK);
  });

  it("refuses an escalation that turns around and asks for data", async () => {
    // The exact contradiction that reached a real chat: "no hace falta que
    // hagas nada" followed by a list of requests.
    replies(
      "Derivamos tu denuncia a un especialista. Mientras tanto necesitamos que nos envíes el DNI."
    );

    const out = await composeReply(base({ intent: "escalation" }));

    expect(out).toBe(FALLBACK);
  });

  it("refuses to promise anything about the money", async () => {
    for (const promise of [
      "El siniestro está cubierto, te vamos a pagar el arreglo.",
      "Tu reclamo fue aprobado y te depositamos 350000 pesos.",
      "Resolvemos esto en 48 horas.",
      "Te mandamos una grúa ahora mismo.",
    ]) {
      replies(promise + " Necesito tu número de póliza.");
      const out = await composeReply(base({ fields: ["policy_number"] }));
      expect(out, promise).toBe(FALLBACK);
    }
  });

  it("refuses a message too long to read on a phone", async () => {
    replies("Necesito tu número de póliza. " + "Detalle innecesario. ".repeat(60));

    const out = await composeReply(base({ fields: ["policy_number"] }));

    expect(out).toBe(FALLBACK);
  });

  it("allows the same length in an email", async () => {
    const long = "Necesito tu número de póliza. " + "Explicación útil. ".repeat(20);
    replies(long);

    const out = await composeReply(
      base({ channel: "email", fields: ["policy_number"] })
    );

    expect(out).toBe(long.trim());
  });
});

describe("composeReply — when it cannot", () => {
  it("falls back when the model returns nothing", async () => {
    mockCall.mockResolvedValue({ text: null, usage: {} });
    expect(await composeReply(base())).toBe(FALLBACK);
  });

  it("falls back on unparseable output", async () => {
    mockCall.mockResolvedValue({ text: "no soy json", usage: {} });
    expect(await composeReply(base())).toBe(FALLBACK);
  });

  it("falls back on an empty message field", async () => {
    replies("   ");
    expect(await composeReply(base())).toBe(FALLBACK);
  });

  it("falls back when the call throws — a claim must still get an answer", async () => {
    mockCall.mockRejectedValue(new Error("no API key"));
    expect(await composeReply(base())).toBe(FALLBACK);
  });

  it("can be turned off entirely without touching code", async () => {
    // A switch matters here: if composition starts misbehaving in production,
    // the templates are one env var away and nobody has to deploy.
    process.env.AGENT_COMPOSE_REPLIES = "off";
    replies("Un mensaje perfectamente bueno sobre tu número de póliza.");

    expect(await composeReply(base({ fields: ["policy_number"] }))).toBe(FALLBACK);
    expect(mockCall).not.toHaveBeenCalled();
  });
});

describe("composeReply — the brief it hands the model", () => {
  it("tells it exactly which fields to ask for, and their instructions", async () => {
    replies("Necesito el número de póliza y las fotos de los daños.");

    await composeReply(base({ fields: ["policy_number", "fotos_danos"] }));

    const prompt = mockCall.mock.calls[0][0] as string;
    expect(prompt).toContain("Número de póliza");
    expect(prompt).toContain("Fotos de los daños");
    // Documents and facts are distinguished, so it does not ask for a phone
    // number "como foto".
    expect(prompt).toContain("archivo o foto");
  });

  it("passes a value we already hold as something to correct, not request", async () => {
    replies("Confirmame la fecha del siniestro, entendimos el 16 de agosto.");

    await composeReply(
      base({ fields: ["accident_date"], knownValues: { accident_date: "16/08/2026" } })
    );

    const prompt = mockCall.mock.calls[0][0] as string;
    expect(prompt).toContain("16/08/2026");
    expect(prompt).toContain("pedir corrección");
  });

  it("says whether this is a first contact or a conversation already underway", async () => {
    replies("Ya tenemos todo lo necesario, tu denuncia pasa a análisis.");
    await composeReply(base({ intent: "closing", isFollowUp: true }));
    expect(mockCall.mock.calls[0][0] as string).toContain("Ya venimos conversando");

    vi.clearAllMocks();
    replies("Recibimos tu denuncia, ya quedó registrada.");
    await composeReply(base({ intent: "closing" }));
    expect(mockCall.mock.calls[0][0] as string).toContain("primer mensaje");
  });
});
