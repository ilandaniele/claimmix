/**
 * E16: en modo MOCK_AI, `runEmailClaimAgent` no inventa ninguna denuncia.
 *
 * Antes devolvía la denuncia fija de `extractEmailClaimMock` (Juan Pérez,
 * POL-1234, un choque en Av. Cabildo) como si un asegurado real la hubiera
 * mandado. Ahora usa `denunciaSimuladaVacia`: el caso queda derivado a un
 * especialista, sin ningún dato puesto en boca de nadie.
 *
 * `mock-extractor.ts` no se mockea acá: es lo que se está probando.
 * `gemini-extractor.ts` sí, porque no se necesita — y para no arrastrar
 * `@/server/gcp/credenciales` ni `@/server/ai/budget` (que pide `@/lib/db`).
 */

import { describe, it, expect, vi, beforeEach } from "vitest";

vi.mock("@/server/ai/provider", () => ({
  resolveExtractionEngine: vi.fn().mockResolvedValue("mock"),
}));

vi.mock("@/server/ai/gemini-extractor", () => ({
  extractEmailClaimGemini: vi.fn(),
  runGeminiExtractor: vi.fn(),
  GeminiExtractionError: class GeminiExtractionError extends Error {},
}));

import { runEmailClaimAgent } from "@/server/ai/claim-agent";

const TENANT_ID = "10000000-0000-0000-0000-000000000001";
const CASE_ID = "10000000-0000-0000-0000-000000000002";

beforeEach(() => {
  vi.clearAllMocks();
});

describe("runEmailClaimAgent en modo mock", () => {
  it("deriva a especialista sin inventar ningún dato", async () => {
    const { resolveExtractionEngine } = await import("@/server/ai/provider");
    vi.mocked(resolveExtractionEngine).mockResolvedValue("mock");

    const result = await runEmailClaimAgent({
      payload: { subject: "asunto", body: "cuerpo", memoryHints: [], knownPatterns: [] },
      tenantId: TENANT_ID,
      caseId: CASE_ID,
      userId: null,
    });

    expect(result.requires_specialist).toBe(true);
    expect(result.fields).toHaveLength(0);
    expect(result.confidence).toBe(0);
    expect(JSON.stringify(result)).not.toContain("Juan Pérez");
    expect(JSON.stringify(result)).not.toContain("POL-1234");
  });
});
