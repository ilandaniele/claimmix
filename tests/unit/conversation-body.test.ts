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
