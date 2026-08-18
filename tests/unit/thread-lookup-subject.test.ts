/**
 * Recovering the case a reply belongs to.
 *
 * The failure this guards against is quiet and expensive: a claimant answers
 * the question the agent asked, and instead of the answer landing on their
 * case, a brand new case appears. The agent then asks the same question again.
 */

import { describe, it, expect } from "vitest";
import { caseIdFromSubject } from "@/server/email/thread-lookup";

const CASE = "151bf83d-a9c2-43fe-bd57-55ee0b5c3ed8";

describe("caseIdFromSubject", () => {
  it("finds the case in a reply to any of our templates", () => {
    for (const subject of [
      `Re: Recibimos tu reclamo - Caso #${CASE}`,
      `Re: Información adicional requerida - Caso #${CASE}`,
      `RE: Tu reclamo fue escalado a un especialista - Caso #${CASE}`,
      `Fwd: Confirmar datos de reclamo - Caso #${CASE}`,
    ]) {
      expect(caseIdFromSubject(subject), subject).toBe(CASE);
    }
  });

  it("survives the spacing and casing a person types", () => {
    expect(caseIdFromSubject(`re: caso #${CASE.toUpperCase()}`)).toBe(CASE);
    expect(caseIdFromSubject(`Re: CASO # ${CASE}`)).toBe(CASE);
  });

  it("returns null when there is no case number to find", () => {
    expect(caseIdFromSubject("consulta")).toBeNull();
    expect(caseIdFromSubject("Re: Caso #12345")).toBeNull();
    expect(caseIdFromSubject("")).toBeNull();
    expect(caseIdFromSubject(null)).toBeNull();
  });

  it("does not mistake a stray uuid for a case reference", () => {
    // Only the "Caso #" form counts — a bare uuid in a subject is not a claim
    // that the sender is talking about that case.
    expect(caseIdFromSubject(`Re: ${CASE}`)).toBeNull();
  });
});
