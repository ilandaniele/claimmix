/**
 * Reading the whole conversation, not just the last thing said.
 *
 * A claimant wrote "tuve un problema con el auto anteayer", the agent asked
 * what kind of claim it was, they answered "fue un choque" — and the agent
 * then asked for the date of the accident. The date was in the first message,
 * which re-extraction was no longer reading. Asking twice is worse than not
 * asking: they answered, and it reads as though nobody looked.
 */

import { describe, it, expect } from "vitest";
import { stripQuotedReply } from "@/server/worker/extract";

describe("stripQuotedReply", () => {
  it("drops the copy of our own email that a reply quotes back", () => {
    const body = [
      "Fue un choque. Venía por Av. Alem al 2300.",
      "",
      "El lun, 18 ago 2026 a las 21:31, ClaimMix <a@b.com> escribió:",
      "> Información adicional requerida",
      "> Necesitamos que nos proporciones la siguiente información:",
    ].join("\n");

    const out = stripQuotedReply(body);

    expect(out).toBe("Fue un choque. Venía por Av. Alem al 2300.");
    expect(out).not.toContain("Información adicional requerida");
  });

  it("handles the English attribution line too", () => {
    const body = "It was a crash.\n\nOn Mon, Aug 18, 2026 at 9:31 PM Someone wrote:\n> quoted";
    expect(stripQuotedReply(body)).toBe("It was a crash.");
  });

  it("handles the Outlook separator", () => {
    const body = "Fue un choque.\n\n----- Mensaje original -----\nDe: ClaimMix";
    expect(stripQuotedReply(body)).toBe("Fue un choque.");
  });

  it("drops stray quoted lines even without an attribution line", () => {
    expect(stripQuotedReply("Mi respuesta\n> algo citado\nmás texto")).toBe(
      "Mi respuesta\nmás texto"
    );
  });

  it("leaves an ordinary message untouched", () => {
    const body = "Hola, tuve un problema con el auto anteayer y quería saber cómo sigo.";
    expect(stripQuotedReply(body)).toBe(body);
  });

  it("does not eat a line that merely starts with 'on' or 'el'", () => {
    // "El auto quedó..." must survive — only the attribution form ends in
    // "escribió:" / "wrote:".
    const body = "El auto quedó abollado del lado derecho.\nOn the way home.";
    expect(stripQuotedReply(body)).toBe(body);
  });

  it("returns empty for a message that was nothing but a quote", () => {
    expect(stripQuotedReply("> sólo texto citado")).toBe("");
  });
});

// ── The conversation loader ──────────────────────────────────────────────────

vi.mock("@/lib/db", () => ({
  db: { select: vi.fn() },
}));

import { vi, beforeEach } from "vitest";
import { loadInboundConversation } from "@/server/worker/extract";
import { db } from "@/lib/db";

function inboundRows(rows: unknown) {
  (db.select as ReturnType<typeof vi.fn>).mockReturnValue({
    from: () => ({ where: () => ({ orderBy: () => Promise.resolve(rows) }) }),
  });
}

describe("loadInboundConversation", () => {
  beforeEach(() => vi.clearAllMocks());

  it("reads every inbound message, not only the newest", async () => {
    // WhatsApp writes to raw_messages as well as claim_messages, so it silently
    // took the raw path — one message, no context. A photo arrived on a nearly
    // complete crash report, the extractor read "[Imagen adjunta sin texto]"
    // alone, decided it was not a claim, and killed the case.
    inboundRows([
      {
        id: "m1",
        provider_message_id: "wamid.1",
        body_text: "Choqué en Bahía Blanca, soy Martín Sosa",
        subject: "WhatsApp",
        from_addr: "59899413456",
        received_at: "2026-08-19T23:09:44Z",
      },
      {
        id: "m2",
        provider_message_id: "wamid.2",
        body_text: "[Imagen adjunta sin texto]",
        subject: "WhatsApp",
        from_addr: "59899413456",
        received_at: "2026-08-19T23:17:19Z",
      },
    ]);

    const out = await loadInboundConversation("case-1", "tenant-1");

    expect(out?.body).toContain("Choqué en Bahía Blanca");
    expect(out?.body).toContain("[Imagen adjunta sin texto]");
    // Identity comes from the newest message: it is the one being answered.
    expect(out?.claimMessageId).toBe("m2");
    expect(out?.latestText).toBe("[Imagen adjunta sin texto]");
  });

  it("returns null when the case has no inbound messages", async () => {
    inboundRows([]);
    expect(await loadInboundConversation("case-1", "tenant-1")).toBeNull();
  });

  it("returns null rather than guessing when the read gives back nonsense", async () => {
    inboundRows({ notAnArray: true });
    expect(await loadInboundConversation("case-1", "tenant-1")).toBeNull();
  });
});
