/**
 * El prompt pide patente, provincia y hora por ramo (P6).
 *
 * `prompt.test.ts` (P2) es de otro tema — no lo toca este archivo.
 */

import { describe, it, expect } from "vitest";
import { buildEmailClaimPrompt } from "@/server/ai/prompt";

const SUBJECT = "Siniestro Zurich - NICOLAS JASPER";
const BODY = "Buenos días. Me comunico por el Siniestro 91520998-2 de ZURICH.";

const PROMPT = buildEmailClaimPrompt(SUBJECT, BODY, [], [], "n10jasper@gmail.com");

describe("buildEmailClaimPrompt — datos requeridos por ramo (P6)", () => {
  it("contiene la sección REQUIRED DATA BY CLAIM TYPE", () => {
    expect(PROMPT).toContain("REQUIRED DATA BY CLAIM TYPE");
  });

  it("pide las tres claves", () => {
    expect(PROMPT).toContain("patente_vehiculo");
    expect(PROMPT).toContain("provincia_siniestro");
    expect(PROMPT).toContain("hora_siniestro");
  });

  it("no deriva la provincia de una calle sola", () => {
    expect(PROMPT).toContain("Never derive it from a street alone");
  });
});
