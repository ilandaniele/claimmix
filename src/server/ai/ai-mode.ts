/**
 * Qué motor está usando este deploy, para el endpoint de salud.
 *
 * Vive acá y no adentro de la ruta por una razón concreta: el test lo tenía
 * COPIADO. `health-endpoint.test.ts` declaraba su propio `getAiMode` con la
 * nota «mirrors the logic in health/route.ts», y un espejo se deja de parecer
 * sin que nadie avise. Cuando OpenAI salió del producto, la ruta cambió y el
 * test siguió en verde probando su propia copia — con tres casos que
 * afirmaban que devolvía `"openai"`.
 *
 * ── Por qué no es «¿hay una API key?» ───────────────────────────────────────
 *
 * Vertex autentica con una cuenta de servicio, no con una API key. Leerlo como
 * «¿hay key?» es lo que mandó silenciosamente el extractor al mock una vez, y
 * acá haría que esta pantalla informe «mock» sobre un deploy que anda
 * perfectamente — que es peor, porque es la pantalla a la que uno va
 * justamente para saber si anda.
 */

/** Cómo se ve el motor desde afuera. `mock` no sirve para contestarle a nadie. */
export type AiMode = "mock" | "gemini";

export function resolverAiMode(entrada: {
  mockAi: string | undefined;
  aiMock: string | undefined;
  /** Ya resuelto por quien llama: Vertex configurado O una GEMINI_API_KEY. */
  geminiConfigurado: boolean;
}): AiMode {
  if (entrada.mockAi === "true" || entrada.aiMock === "true") return "mock";
  return entrada.geminiConfigurado ? "gemini" : "mock";
}
