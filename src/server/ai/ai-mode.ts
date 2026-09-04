export type AiMode = "mock" | "gemini";

// Caller resolves `geminiConfigurado` (Vertex OR API key): Vertex uses a
// service account, so "is there a key?" is the wrong question.
export function resolverAiMode(entrada: {
  mockAi: string | undefined;
  aiMock: string | undefined;
  geminiConfigurado: boolean;
}): AiMode {
  if (entrada.mockAi === "true" || entrada.aiMock === "true") return "mock";
  return entrada.geminiConfigurado ? "gemini" : "mock";
}
