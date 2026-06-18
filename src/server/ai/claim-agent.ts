/**
 * Claim agent facade.
 *
 * The worker talks to this module. Provider adapters (OpenAI, Gemini, mock)
 * remain implementation details, and every provider returns the same validated
 * ExtractedClaim contract for deterministic DB writes.
 */

import "server-only";
import type { ClaimType } from "@/lib/schemas/cases";
import type { ExtractedClaim } from "@/lib/schemas/extracted-claim";
import { runMockExtractor, extractEmailClaimMock } from "@/server/ai/mock-extractor";
import {
  runOpenAIExtractor,
  extractEmailClaim,
  OpenAIExtractionError,
  type EmailClaimPayload,
} from "@/server/ai/openai-extractor";
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
    if (engine === "gemini") {
      return runGeminiExtractor(
        params.rawText,
        params.claimType,
        params.caseId,
        params.tenantId,
        params.userId
      );
    }
    return runOpenAIExtractor(
      params.rawText,
      params.claimType,
      params.caseId,
      params.tenantId
    );
  } catch (e) {
    if (e instanceof OpenAIExtractionError || e instanceof GeminiExtractionError) {
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
  if (engine === "gemini") {
    return extractEmailClaimGemini(
      params.payload,
      params.tenantId,
      params.caseId,
      params.userId
    );
  }
  return extractEmailClaim(params.payload, params.tenantId, params.caseId);
}
