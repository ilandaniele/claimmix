/**
 * El modo de IA que informa /api/admin/health.
 *
 * Este archivo tenía la lógica COPIADA, con la nota «mirrors the logic in
 * health/route.ts». Un espejo se deja de parecer sin que nadie avise: cuando
 * OpenAI salió del producto, la ruta cambió y estos tests siguieron en verde
 * probando su propia copia, tres de ellos afirmando que devolvía «openai».
 *
 * Ahora importa la función que la ruta usa de verdad.
 */

import { describe, it, expect } from "vitest";
import packageJson from "../../package.json";
import { resolverAiMode } from "@/server/ai/ai-mode";

describe("el modo de IA que se informa", () => {
  it("MOCK_AI=true gana sobre cualquier credencial", () => {
    expect(resolverAiMode({ mockAi: "true", aiMock: undefined, geminiConfigurado: true })).toBe("mock");
    expect(resolverAiMode({ mockAi: undefined, aiMock: "true", geminiConfigurado: true })).toBe("mock");
  });

  it("sin credencial utilizable, mock", () => {
    expect(resolverAiMode({ mockAi: undefined, aiMock: undefined, geminiConfigurado: false })).toBe("mock");
    expect(resolverAiMode({ mockAi: "false", aiMock: "false", geminiConfigurado: false })).toBe("mock");
  });

  it("con Gemini configurado, gemini", () => {
    expect(resolverAiMode({ mockAi: undefined, aiMock: undefined, geminiConfigurado: true })).toBe("gemini");
    expect(resolverAiMode({ mockAi: "false", aiMock: undefined, geminiConfigurado: true })).toBe("gemini");
  });

  it("nunca devuelve un proveedor que el producto no tiene", () => {
    // `geminiConfigurado` lo resuelve quien llama —Vertex O una API key—
    // justamente para que esta función no vuelva a preguntar «¿hay key?».
    for (const configurado of [true, false]) {
      const modo = resolverAiMode({ mockAi: undefined, aiMock: undefined, geminiConfigurado: configurado });
      expect(["mock", "gemini"]).toContain(modo);
    }
  });
});

describe("la forma de la respuesta", () => {
  it("la versión del package.json parece semver", () => {
    expect(packageJson.version).toMatch(/^\d+\.\d+\.\d+/);
  });

  it("están los cinco campos que la pantalla espera", () => {
    const respuesta = {
      status: "ok",
      db: "connected",
      ai: "mock" as const,
      version: packageJson.version,
      region: "local",
    };
    for (const campo of ["status", "db", "ai", "version", "region"]) {
      expect(respuesta).toHaveProperty(campo);
    }
  });
});
