/**
 * El arranque en frío no paga por lo que está apagado.
 *
 * `sentry.server.config.ts` importa `@sentry/nextjs` —veintidós paquetes— y
 * adentro no hace nada sin `SENTRY_DSN`, que no está puesta en ningún lado.
 * Se importaba igual, en cada arranque.
 *
 * Y cuando el DSN sí está, Sentry tiene que cargarse antes que el resto
 * (`@/lib/auth`) para envolverlo, y los errores que Next atrapa por su cuenta
 * le llegan por `onRequestError`.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const estado = vi.hoisted(() => ({
  veces: 0,
  vecesSentry: 0,
  orden: [] as string[],
  captureRequestError: vi.fn(),
}));

// `vi.mock` evalúa la fábrica una sola vez por archivo aunque se resetee el
// registro, y acá cada prueba necesita ver si el módulo se cargó DE NUEVO.
function mockear() {
  vi.doMock("../../sentry.server.config", () => {
    estado.veces++;
    estado.orden.push("sentry");
    return {};
  });
  vi.doMock("@sentry/nextjs", () => {
    estado.vecesSentry++;
    return { captureRequestError: estado.captureRequestError };
  });
  vi.doMock("@/lib/auth", () => {
    estado.orden.push("auth cargado");
    return {
      exigirSecretoDeSesion: () => {
        estado.orden.push("secreto");
      },
    };
  });
}

async function instrumentacion() {
  return import("../../instrumentation");
}

const RUNTIME = process.env.NEXT_RUNTIME;
const DSN = process.env.SENTRY_DSN;
const URL_DSN = "https://abc@o1.ingest.sentry.io/1";

beforeEach(() => {
  estado.veces = 0;
  estado.vecesSentry = 0;
  estado.orden = [];
  estado.captureRequestError.mockClear();
  process.env.NEXT_RUNTIME = "nodejs";
  vi.resetModules();
  mockear();
});

afterEach(() => {
  if (RUNTIME === undefined) delete process.env.NEXT_RUNTIME;
  else process.env.NEXT_RUNTIME = RUNTIME;
  if (DSN === undefined) delete process.env.SENTRY_DSN;
  else process.env.SENTRY_DSN = DSN;
  vi.resetModules();
});

describe("instrumentation.register", () => {
  it("sin DSN no carga Sentry", async () => {
    delete process.env.SENTRY_DSN;
    await (await instrumentacion()).register();
    expect(estado.veces).toBe(0);
  });

  it("con DSN lo carga", async () => {
    process.env.SENTRY_DSN = URL_DSN;
    await (await instrumentacion()).register();
    expect(estado.veces).toBe(1);
  });

  it("fuera del runtime de node no carga nada", async () => {
    process.env.NEXT_RUNTIME = "edge";
    process.env.SENTRY_DSN = URL_DSN;
    await (await instrumentacion()).register();
    expect(estado.veces).toBe(0);
    expect(estado.orden).toEqual([]);
  });

  it("Sentry se carga antes que auth, y el secreto se exige igual", async () => {
    process.env.SENTRY_DSN = URL_DSN;
    await (await instrumentacion()).register();
    expect(estado.orden).toEqual(["sentry", "auth cargado", "secreto"]);
  });

  it("sin DSN el secreto se exige igual", async () => {
    delete process.env.SENTRY_DSN;
    await (await instrumentacion()).register();
    expect(estado.orden).toEqual(["auth cargado", "secreto"]);
  });
});

describe("instrumentation.onRequestError", () => {
  const error = new Error("reventó");
  const pedido = { path: "/api/casos", method: "POST", headers: { host: "x" } };
  const contexto = {
    routerKind: "App Router",
    routePath: "/api/casos",
    routeType: "route",
    renderSource: undefined,
    revalidateReason: undefined,
    renderType: undefined,
  } as const;

  it("con DSN se lo pasa a Sentry tal cual", async () => {
    process.env.SENTRY_DSN = URL_DSN;
    await (await instrumentacion()).onRequestError(error, pedido, contexto);
    expect(estado.captureRequestError).toHaveBeenCalledOnce();
    expect(estado.captureRequestError).toHaveBeenCalledWith(error, pedido, contexto);
  });

  it("sin DSN no importa el paquete ni hace nada", async () => {
    delete process.env.SENTRY_DSN;
    await (await instrumentacion()).onRequestError(error, pedido, contexto);
    expect(estado.vecesSentry).toBe(0);
    expect(estado.captureRequestError).not.toHaveBeenCalled();
  });

  it("fuera del runtime de node no hace nada", async () => {
    process.env.NEXT_RUNTIME = "edge";
    process.env.SENTRY_DSN = URL_DSN;
    await (await instrumentacion()).onRequestError(error, pedido, contexto);
    expect(estado.vecesSentry).toBe(0);
    expect(estado.captureRequestError).not.toHaveBeenCalled();
  });
});
