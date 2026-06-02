/**
 * OpenAI-based claim extractor.
 *
 * LLM01: System prompt uses XML sentinel delimiters (<claim_text>).
 * LLM02: response_format with json_schema strict=true.
 * LLM06: Logs only case_id and token counts — NEVER raw_intake_text or PII.
 * LLM07: Service role client used server-side; service role key never in prompt.
 * LLM08: Model cannot set case.status (FSM enforced in worker).
 *
 * Retry policy: one retry with a stricter prompt on invalid JSON.
 * After retry failure → throws OpenAIExtractionError (worker escalates the case).
 *
 * AC17: AI output validated against ExtractedClaimSchema before any DB write.
 */

import "server-only";
import OpenAI from "openai";
import { ExtractedClaimSchema, OPENAI_JSON_SCHEMA } from "@/lib/schemas/extracted-claim";
import type { ExtractedClaim } from "@/lib/schemas/extracted-claim";
import type { ClaimType } from "@/lib/schemas/cases";
import { buildSystemPrompt, buildUserMessage } from "./prompt";
import { computeCostUsd } from "./budget";

/** Custom error for unrecoverable AI extraction failures. */
export class OpenAIExtractionError extends Error {
  constructor(message: string, public readonly cause?: unknown) {
    super(message);
    this.name = "OpenAIExtractionError";
  }
}

let _client: OpenAI | null = null;

function getClient(): OpenAI {
  if (!_client) {
    const apiKey = process.env.OPENAI_API_KEY;
    if (!apiKey) {
      throw new OpenAIExtractionError(
        "OPENAI_API_KEY is not set. Set MOCK_AI=true to use the mock extractor."
      );
    }
    _client = new OpenAI({ apiKey });
  }
  return _client;
}

/**
 * Parse and validate the OpenAI response content as an ExtractedClaim.
 * Returns null if parsing or validation fails.
 */
function parseResponse(content: string | null, claimType: ClaimType): ExtractedClaim | null {
  if (!content) return null;
  try {
    const raw = JSON.parse(content);
    // Inject the model name if the model didn't fill it (strict schema should have it).
    if (!raw.extraction_model) raw.extraction_model = "gpt-4o-mini";
    const parsed = ExtractedClaimSchema.safeParse(raw);
    if (!parsed.success) {
      console.error("[openai-extractor] Schema validation failed:", parsed.error.issues.length, "issues");
      return null;
    }
    return parsed.data;
  } catch {
    return null;
  }
}

/**
 * Run the OpenAI extractor for a single claim text.
 *
 * @param rawText   - Raw email body (full claim text).
 * @param claimType - Determines which fields to extract.
 * @param caseId    - Used for structured logging (never logged is the text itself).
 * @returns         - Validated ExtractedClaim with token usage and cost.
 * @throws          - OpenAIExtractionError if extraction fails after retry.
 */
export async function runOpenAIExtractor(
  rawText: string,
  claimType: ClaimType,
  caseId: string
): Promise<ExtractedClaim> {
  const client = getClient();
  const systemPrompt = buildSystemPrompt(claimType);
  const userMessage = buildUserMessage(rawText);

  // ── Attempt 1 ─────────────────────────────────────────────────────────────
  let result: ExtractedClaim | null = null;
  let totalPromptTokens = 0;
  let totalCompletionTokens = 0;

  try {
    const response = await client.chat.completions.create({
      model: "gpt-4o-mini",
      response_format: OPENAI_JSON_SCHEMA,
      messages: [
        { role: "system", content: systemPrompt },
        { role: "user", content: userMessage },
      ],
      temperature: 0,
      max_tokens: 2048,
    });

    // LLM06: Log only case_id + token counts, NEVER the raw text.
    const usage = response.usage;
    totalPromptTokens = usage?.prompt_tokens ?? 0;
    totalCompletionTokens = usage?.completion_tokens ?? 0;
    console.info(
      JSON.stringify({
        level: "info",
        service: "claimmix",
        msg: "ai.extraction.attempt1",
        case_id: caseId,
        model: "gpt-4o-mini",
        prompt_tokens: totalPromptTokens,
        completion_tokens: totalCompletionTokens,
      })
    );

    result = parseResponse(response.choices[0]?.message?.content ?? null, claimType);
  } catch (e) {
    const name = e instanceof Error ? e.name : "UnknownError";
    console.error(
      JSON.stringify({
        level: "error",
        service: "claimmix",
        msg: "ai.extraction.attempt1.error",
        case_id: caseId,
        error_name: name,
      })
    );
    // Fall through to retry.
  }

  if (result) {
    return {
      ...result,
      extraction_model: "gpt-4o-mini",
      prompt_tokens: totalPromptTokens,
      completion_tokens: totalCompletionTokens,
      cost_usd: computeCostUsd(totalPromptTokens, totalCompletionTokens),
    };
  }

  // ── Attempt 2 (retry with stricter prompt) ───────────────────────────────
  const stricterSystem =
    systemPrompt +
    "\n\nIMPORTANT: Your previous response was invalid JSON. Return ONLY valid JSON matching the schema exactly. No markdown, no code blocks, no extra text.";

  try {
    const retryResponse = await client.chat.completions.create({
      model: "gpt-4o-mini",
      response_format: OPENAI_JSON_SCHEMA,
      messages: [
        { role: "system", content: stricterSystem },
        { role: "user", content: userMessage },
      ],
      temperature: 0,
      max_tokens: 2048,
    });

    const retryUsage = retryResponse.usage;
    const retryPromptTokens = retryUsage?.prompt_tokens ?? 0;
    const retryCompletionTokens = retryUsage?.completion_tokens ?? 0;
    totalPromptTokens += retryPromptTokens;
    totalCompletionTokens += retryCompletionTokens;

    console.info(
      JSON.stringify({
        level: "info",
        service: "claimmix",
        msg: "ai.extraction.attempt2",
        case_id: caseId,
        model: "gpt-4o-mini",
        prompt_tokens: retryPromptTokens,
        completion_tokens: retryCompletionTokens,
      })
    );

    result = parseResponse(retryResponse.choices[0]?.message?.content ?? null, claimType);
  } catch (e) {
    const name = e instanceof Error ? e.name : "UnknownError";
    console.error(
      JSON.stringify({
        level: "error",
        service: "claimmix",
        msg: "ai.extraction.attempt2.error",
        case_id: caseId,
        error_name: name,
      })
    );
  }

  if (result) {
    return {
      ...result,
      extraction_model: "gpt-4o-mini",
      prompt_tokens: totalPromptTokens,
      completion_tokens: totalCompletionTokens,
      cost_usd: computeCostUsd(totalPromptTokens, totalCompletionTokens),
    };
  }

  // Both attempts failed — worker will escalate the case.
  throw new OpenAIExtractionError(
    `AI extraction failed after 2 attempts for case ${caseId}`
  );
}
