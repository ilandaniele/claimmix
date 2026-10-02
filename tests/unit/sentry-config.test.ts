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

  it("sin DSN no inicializa", async () => {
    delete process.env.SENTRY_DSN;
    await import("../../sentry.server.config");
    expect(init).not.toHaveBeenCalled();
  });
});
