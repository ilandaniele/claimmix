/**
 * La ficha muestra «Enviar al Core» con `hayClienteDeCoreSync` y la ruta pide
 * `getCoreSyncClient`. Si no coinciden, el botón recibe 501 siempre y la ficha
 * esconde la pista a «Entregado por fuera»: pasaba con `CORE_SYNC_MODE=real`.
 */

import { afterEach, describe, expect, it, vi } from "vitest";
import { getCoreSyncClient, hayClienteDeCoreSync } from "@/server/core-sync/client";

describe("hayClienteDeCoreSync", () => {
  afterEach(() => {
    vi.unstubAllEnvs();
  });

  it.each(["", "mock", "real", "otra"])("CORE_SYNC_MODE=%j coincide con getCoreSyncClient", (modo) => {
    vi.stubEnv("CORE_SYNC_MODE", modo);
    let hay = true;
    try {
      getCoreSyncClient();
    } catch {
      hay = false;
    }
    expect(hayClienteDeCoreSync()).toBe(hay);
  });

  it("real todavía no tiene cliente", () => {
    vi.stubEnv("CORE_SYNC_MODE", "real");
    expect(hayClienteDeCoreSync()).toBe(false);
  });
});
