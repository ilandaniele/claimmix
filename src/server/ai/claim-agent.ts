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
import type { ExtractedClaim } from "@/lib/schemas/extracted-claim";
import { denunciaSimuladaVacia } from "@/server/ai/mock-extractor";
import type { EmailClaimPayload } from "@/server/ai/model-response";
import { extractEmailClaimGemini } from "@/server/ai/gemini-extractor";
import { resolveExtractionEngine, type ExtractionEngine } from "@/server/ai/provider";

export async function runEmailClaimAgent(params: {
  payload: EmailClaimPayload;
  tenantId: string;
  caseId: string;
  userId: string | null;
  /** El que ya resolvió quien llama, para no volver a la base. */
  engine?: ExtractionEngine;
}): Promise<ExtractedClaim> {
  const engine = params.engine ?? (await resolveExtractionEngine(params.tenantId, params.userId));
  if (engine === "mock") return denunciaSimuladaVacia();
  return extractEmailClaimGemini(
    params.payload,
    params.tenantId,
    params.caseId,
    params.userId
  );
}
