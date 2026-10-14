/**
 * La ficha muestra «Enviar al Core» con `hayClienteDeCoreSync` y la ruta pide
 * `getCoreSyncClient`. Si no coinciden, el botón recibe 501 siempre y la ficha
 * esconde la pista a «Entregado por fuera». Desde B5 los dos leen la fila de
 * `core_sync_settings` del tenant; CORE_SYNC_MODE sólo cuenta si es `mock`.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { cifrar } from "@/lib/security/cifrado";
import {
  CoreSyncSinConfigurar,
  getCoreSyncClient,
  hayClienteDeCoreSync,
  type FilaDeCoreSync,
} from "@/server/core-sync/client";
import { MockCoreSyncClient } from "@/server/core-sync/mock";
import { RealCoreSyncClient } from "@/server/core-sync/real";

const URL_CORE = "https://core.example.com/webhook";

beforeEach(() => {
  vi.stubEnv("CORE_SYNC_MODE", "");
  vi.stubEnv("GMAIL_TOKEN_ENCRYPTION_KEY", "test-core-encryption-key");
});

afterEach(() => {
  vi.unstubAllEnvs();
});

function activa(extra: Partial<FilaDeCoreSync> = {}): FilaDeCoreSync {
  return { enabled: true, webhook_url: URL_CORE, signing_secret_enc: cifrar("test-core-signing-secret"), ...extra };
}

function modoDe(fila: FilaDeCoreSync | null | undefined) {
  try {
    return getCoreSyncClient(fila);
  } catch (e) {
    return e;
  }
}

describe("hayClienteDeCoreSync coincide con getCoreSyncClient", () => {
  const filas: Array<[string, () => FilaDeCoreSync | null | undefined]> = [
    ["sin fila", () => undefined],
    ["fila nula", () => null],
    ["apagada", () => activa({ enabled: false })],
    ["activa", () => activa()],
  ];

  it.each(["", "mock", "real", "otra"])("CORE_SYNC_MODE=%j", (modo) => {
    vi.stubEnv("CORE_SYNC_MODE", modo);
    for (const [, fila] of filas) {
      const f = fila();
      expect(hayClienteDeCoreSync(f)).toBe(!(modoDe(f) instanceof Error));
    }
  });
});

describe("getCoreSyncClient", () => {
  it.each([
    ["sin fila", undefined],
    ["fila nula", null],
    ["apagada", { enabled: false, webhook_url: URL_CORE, signing_secret_enc: "x.y.z" }],
  ])("%s es sin_configurar", (_, fila) => {
    const e = modoDe(fila);
    expect(e).toBeInstanceOf(CoreSyncSinConfigurar);
    expect((e as CoreSyncSinConfigurar).modo).toBe("sin_configurar");
  });

  it("CORE_SYNC_MODE=real ya no significa nada: sin fila, no hay cliente", () => {
    vi.stubEnv("CORE_SYNC_MODE", "real");
    expect(hayClienteDeCoreSync()).toBe(false);
    expect(modoDe(undefined)).toBeInstanceOf(CoreSyncSinConfigurar);
  });

  it("CORE_SYNC_MODE=mock da el mock aunque no haya fila", () => {
    vi.stubEnv("CORE_SYNC_MODE", "mock");
    expect(getCoreSyncClient()).toBeInstanceOf(MockCoreSyncClient);
  });

  it("una fila activa con secreto que se descifra da el cliente real", () => {
    expect(getCoreSyncClient(activa())).toBeInstanceOf(RealCoreSyncClient);
  });

  it.each([
    ["sin URL", { webhook_url: null }],
    ["sin secreto", { signing_secret_enc: null }],
  ])("activa pero %s no tiene cliente", (_, extra) => {
    const e = modoDe(activa(extra));
    expect(e).toBeInstanceOf(CoreSyncSinConfigurar);
    expect((e as CoreSyncSinConfigurar).modo).toBe("real");
  });

  it("un secreto que ya no se descifra (se rotó la clave) no tiene cliente", () => {
    const fila = activa();
    vi.stubEnv("GMAIL_TOKEN_ENCRYPTION_KEY", "test-other-encryption-key");
    const e = modoDe(fila);
    expect(e).toBeInstanceOf(CoreSyncSinConfigurar);
    expect((e as CoreSyncSinConfigurar).modo).toBe("real");
    expect((e as Error).message).not.toContain("test-core-signing-secret");
  });
});
