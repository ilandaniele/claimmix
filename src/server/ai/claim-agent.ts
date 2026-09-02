/**
 * Claim agent facade.
 *
 * El worker le habla a este modulo y no a un extractor. Quedan dos motores
 * —Gemini y el mock— y los dos devuelven el mismo `ExtractedClaim` validado,
 * que es lo que hace que la escritura a la base sea igual venga de donde venga.
 *
 * La fachada sigue existiendo con un solo proveedor real a proposito: es el
 * lugar donde `resolveExtractionEngine` decide, y el unico punto donde habria
 * que tocar si mañana entra otro.
 */

import "server-only";
import type { ClaimType } from "@/lib/schemas/cases";
import type { ExtractedClaim } from "@/lib/schemas/extracted-claim";
import { runMockExtractor, extractEmailClaimMock } from "@/server/ai/mock-extractor";
import type { EmailClaimPayload } from "@/server/ai/model-response";
import {
  runGeminiExtractor,
  extractEmailClaimGemini,
  GeminiExtractionError,
} from "@/server/ai/gemini-extractor";
import { resolveExtractionEngine } from "@/server/ai/provider";

export class ClaimAgentError extends Error {
  constructor(message: string, public readonly cause?: unknown) {
    super(message);
    this.name = "ClaimAgentError";
  }
}

export async function runClaimTextAgent(params: {
  rawText: string;
  claimType: ClaimType;
  caseId: string;
  tenantId: string;
  userId: string | null;
}): Promise<ExtractedClaim> {
  const engine = await resolveExtractionEngine(params.tenantId, params.userId);

  try {
    if (engine === "mock") {
      return runMockExtractor(params.rawText, params.claimType);
    }
    return runGeminiExtractor(
      params.rawText,
      params.claimType,
      params.caseId,
      params.tenantId,
      params.userId
    );
  } catch (e) {
    if (e instanceof GeminiExtractionError) {
      throw new ClaimAgentError("agent_output_invalid", e);
    }
    throw e;
  }
}

export async function runEmailClaimAgent(params: {
  payload: EmailClaimPayload;
  tenantId: string;
  caseId: string;
  userId: string | null;
}): Promise<ExtractedClaim> {
  const engine = await resolveExtractionEngine(params.tenantId, params.userId);
  if (engine === "mock") return extractEmailClaimMock();
  return extractEmailClaimGemini(
    params.payload,
    params.tenantId,
    params.caseId,
    params.userId
  );
}
