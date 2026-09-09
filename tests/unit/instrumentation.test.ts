/**
 * El arranque en frío no paga por lo que está apagado.
 *
 * `sentry.server.config.ts` importa `@sentry/nextjs` —veintidós paquetes— y
 * adentro no hace nada sin `SENTRY_DSN`, que no está puesta en ningún lado.
 * Se importaba igual, en cada arranque.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const importado = vi.hoisted(() => ({ veces: 0 }));

vi.mock("../../sentry.server.config", () => {
  importado.veces++;
  return {};
});

import { register } from "../../instrumentation";

describe("instrumentation.register", () => {
  const RUNTIME = process.env.NEXT_RUNTIME;
  const DSN = process.env.SENTRY_DSN;

  beforeEach(() => {
    importado.veces = 0;
    process.env.NEXT_RUNTIME = "nodejs";
  });

  afterEach(() => {
    if (RUNTIME === undefined) delete process.env.NEXT_RUNTIME;
    else process.env.NEXT_RUNTIME = RUNTIME;
    if (DSN === undefined) delete process.env.SENTRY_DSN;
    else process.env.SENTRY_DSN = DSN;
    vi.resetModules();
  });

  it("sin DSN no carga Sentry", async () => {
    delete process.env.SENTRY_DSN;
    await register();
    expect(importado.veces).toBe(0);
  });

  it("con DSN lo carga", async () => {
    process.env.SENTRY_DSN = "https://abc@o1.ingest.sentry.io/1";
    await register();
    expect(importado.veces).toBe(1);
  });

  it("fuera del runtime de node no carga nada", async () => {
    process.env.NEXT_RUNTIME = "edge";
    process.env.SENTRY_DSN = "https://abc@o1.ingest.sentry.io/1";
    await register();
    expect(importado.veces).toBe(0);
  });
});
