/**
 * Los sobres de la WABA propia de un cliente. El App Secret va en el sobre
 * versionado `wa1` y atado a su espacio y a su App ID: copiado a la fila de otro
 * cliente, o abierto con otra app, no abre. Los sobres viejos (token y PIN, `iv.tag.ct`)
 * se siguen leyendo.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("server-only", () => ({}));

import { logger } from "@/lib/observability/logger";
import { cifrar } from "@/lib/security/cifrado";
import {
  aadDelPin,
  aadDelSecreto,
  aadDelToken,
  abrirSobre,
  cerrarSecreto,
} from "@/server/whatsapp/sobres-del-cliente";

const SAVED = { ...process.env };
const TENANT = "10000000-0000-0000-0000-000000000001";
const OTRO_TENANT = "10000000-0000-0000-0000-000000000002";
const APP_ID = "1234567890123";
const OTRA_APP = "1234567890124";
const SECRETO = "fake-client-app-secret";

beforeEach(() => {
  process.env.GMAIL_TOKEN_ENCRYPTION_KEY = "test-encryption-key";
  process.env.WHATSAPP_APP_SECRETS_KEY = "test-whatsapp-app-secrets-key";
  vi.spyOn(logger, "error").mockImplementation(() => {});
});

afterEach(() => {
  process.env = { ...SAVED };
  vi.restoreAllMocks();
});

describe("el AAD de cada sobre", () => {
  it("cada uso tiene su prefijo y ata el espacio y el id", () => {
    expect(aadDelToken(TENANT, "300000000000002")).toBe(`wa:${TENANT}:300000000000002`);
    expect(aadDelPin(TENANT, "300000000000002")).toBe(`wa-pin:${TENANT}:300000000000002`);
    expect(aadDelSecreto(TENANT, APP_ID)).toBe(`wa-secreto:${TENANT}:${APP_ID}`);
  });

  it("el del secreto no coincide con el del token ni con el del PIN aunque el id sea el mismo", () => {
    const aads = [aadDelToken(TENANT, APP_ID), aadDelPin(TENANT, APP_ID), aadDelSecreto(TENANT, APP_ID)];
    expect(new Set(aads).size).toBe(3);
  });
});

describe("cerrarSecreto y abrirSobre", () => {
  it("cierra en un sobre v2 con el kid wa1, sin el secreto a la vista", () => {
    const sobre = cerrarSecreto(SECRETO, TENANT, APP_ID);

    expect(sobre.split(".")).toHaveLength(5);
    expect(sobre.startsWith("v2.wa1.")).toBe(true);
    expect(sobre).not.toContain(SECRETO);
  });

  it("ida y vuelta con el mismo espacio y la misma app", () => {
    expect(abrirSobre(cerrarSecreto(SECRETO, TENANT, APP_ID), aadDelSecreto(TENANT, APP_ID))).toBe(SECRETO);
  });

  it("copiado al espacio de otro cliente no abre", () => {
    const sobre = cerrarSecreto(SECRETO, TENANT, APP_ID);

    expect(abrirSobre(sobre, aadDelSecreto(OTRO_TENANT, APP_ID))).toBeNull();
    expect(logger.error).toHaveBeenCalledWith(expect.anything(), "alta.waba_descifrado_fallo");
  });

  it("abierto con el App ID de otra app no abre", () => {
    expect(abrirSobre(cerrarSecreto(SECRETO, TENANT, APP_ID), aadDelSecreto(TENANT, OTRA_APP))).toBeNull();
  });

  it("abierto con el AAD del token o del PIN no abre", () => {
    const sobre = cerrarSecreto(SECRETO, TENANT, APP_ID);

    expect(abrirSobre(sobre, aadDelToken(TENANT, APP_ID))).toBeNull();
    expect(abrirSobre(sobre, aadDelPin(TENANT, APP_ID))).toBeNull();
  });

  it("no depende de la clave de Gmail: cambiarla no lo rompe", () => {
    const sobre = cerrarSecreto(SECRETO, TENANT, APP_ID);
    process.env.GMAIL_TOKEN_ENCRYPTION_KEY = "test-otra-clave-de-gmail";

    expect(abrirSobre(sobre, aadDelSecreto(TENANT, APP_ID))).toBe(SECRETO);
  });

  it("rotar WHATSAPP_APP_SECRETS_KEY lo deja sin abrir, como si no estuviera", () => {
    const sobre = cerrarSecreto(SECRETO, TENANT, APP_ID);
    process.env.WHATSAPP_APP_SECRETS_KEY = "test-otra-clave-de-secretos";

    expect(abrirSobre(sobre, aadDelSecreto(TENANT, APP_ID))).toBeNull();
  });

  it("sin WHATSAPP_APP_SECRETS_KEY no cierra ni abre", () => {
    const sobre = cerrarSecreto(SECRETO, TENANT, APP_ID);
    delete process.env.WHATSAPP_APP_SECRETS_KEY;

    expect(() => cerrarSecreto(SECRETO, TENANT, APP_ID)).toThrow("WHATSAPP_APP_SECRETS_KEY");
    expect(abrirSobre(sobre, aadDelSecreto(TENANT, APP_ID))).toBeNull();
  });

  it("un sobre ausente es null sin ruido en el log", () => {
    expect(abrirSobre(null, aadDelSecreto(TENANT, APP_ID))).toBeNull();
    expect(abrirSobre("", aadDelSecreto(TENANT, APP_ID))).toBeNull();
    expect(logger.error).not.toHaveBeenCalled();
  });

  it("el log del fallo no lleva el secreto ni el AAD", () => {
    abrirSobre(cerrarSecreto(SECRETO, TENANT, APP_ID), aadDelSecreto(OTRO_TENANT, APP_ID));

    const todo = JSON.stringify((logger.error as unknown as { mock: { calls: unknown[][] } }).mock.calls);
    expect(todo).not.toContain(SECRETO);
    expect(todo).not.toContain(TENANT);
  });
});

describe("los sobres viejos se siguen abriendo", () => {
  it("el token y el PIN (iv.tag.ct con AAD) abren con su AAD", () => {
    const token = cifrar("test-client-system-token-key", aadDelToken(TENANT, "300000000000002"));
    const pin = cifrar("123456", aadDelPin(TENANT, "300000000000002"));

    expect(abrirSobre(token, aadDelToken(TENANT, "300000000000002"))).toBe("test-client-system-token-key");
    expect(abrirSobre(pin, aadDelPin(TENANT, "300000000000002"))).toBe("123456");
  });

  it("el sobre viejo no abre con el AAD de otro espacio", () => {
    const token = cifrar("test-client-system-token-key", aadDelToken(TENANT, "300000000000002"));
    expect(abrirSobre(token, aadDelToken(OTRO_TENANT, "300000000000002"))).toBeNull();
  });
});
