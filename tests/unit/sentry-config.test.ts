/**
 * Sentry no junta datos de personas.
 *
 * La v11 sacó `sendDefaultPii` y por defecto manda cuerpos, cabeceras, cookies,
 * variables locales, parámetros de consultas y prompts de IA. El scrub de
 * `beforeSend` no llega a los atributos de los spans, así que cada categoría
 * tiene que salir apagada desde `Sentry.init`.
 */

import { afterEach, describe, expect, it, vi } from "vitest";

const init = vi.hoisted(() => vi.fn());

vi.mock("@sentry/nextjs", () => ({ init }));

describe("sentry.server.config", () => {
  const DSN = process.env.SENTRY_DSN;

  afterEach(() => {
    if (DSN === undefined) delete process.env.SENTRY_DSN;
    else process.env.SENTRY_DSN = DSN;
    init.mockClear();
    vi.resetModules();
  });

  it("apaga toda la recolección y limpia errores y transacciones", async () => {
    process.env.SENTRY_DSN = "https://abc@o1.ingest.sentry.io/1";
    await import("../../sentry.server.config");

    expect(init).toHaveBeenCalledOnce();
    const opciones = init.mock.calls[0][0];
    expect(opciones).not.toHaveProperty("sendDefaultPii");
    expect(opciones.dataCollection).toEqual({
      userInfo: false,
      cookies: false,
      httpHeaders: false,
      httpBodies: [],
      urlQueryParams: false,
      graphQL: { document: false, variables: false },
      genAI: { inputs: false, outputs: false },
      databaseQueryData: false,
      queues: false,
      stackFrameVariables: false,
    });
    expect(opciones.traceLifecycle).toBe("static");
    expect(opciones.beforeSend).toBeTypeOf("function");
    expect(opciones.beforeSendTransaction).toBeTypeOf("function");
  });

  describe("entorno y release", () => {
    const VERCEL_ENV = process.env.VERCEL_ENV;
    const SHA = process.env.VERCEL_GIT_COMMIT_SHA;

    afterEach(() => {
      if (VERCEL_ENV === undefined) delete process.env.VERCEL_ENV;
      else process.env.VERCEL_ENV = VERCEL_ENV;
      if (SHA === undefined) delete process.env.VERCEL_GIT_COMMIT_SHA;
      else process.env.VERCEL_GIT_COMMIT_SHA = SHA;
    });

    it("en Vercel usa VERCEL_ENV (NODE_ENV vale production también en los previews) y el commit", async () => {
      process.env.SENTRY_DSN = "https://abc@o1.ingest.sentry.io/1";
      process.env.VERCEL_ENV = "preview";
      process.env.VERCEL_GIT_COMMIT_SHA = "da7e428f0000000000000000000000000000abcd";
      await import("../../sentry.server.config");

      expect(init.mock.calls[0][0].environment).toBe("preview");
      expect(init.mock.calls[0][0].release).toBe("da7e428f0000000000000000000000000000abcd");
    });

    it("fuera de Vercel cae a NODE_ENV y no inventa un release", async () => {
      process.env.SENTRY_DSN = "https://abc@o1.ingest.sentry.io/1";
      delete process.env.VERCEL_ENV;
      delete process.env.VERCEL_GIT_COMMIT_SHA;
      await import("../../sentry.server.config");

      expect(init.mock.calls[0][0].environment).toBe(process.env.NODE_ENV);
      expect(init.mock.calls[0][0].release).toBeUndefined();
    });
  });

  it("sin DSN no inicializa", async () => {
    delete process.env.SENTRY_DSN;
    await import("../../sentry.server.config");
    expect(init).not.toHaveBeenCalled();
  });
});
