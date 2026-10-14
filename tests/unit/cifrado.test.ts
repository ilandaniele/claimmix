/**
 * El cifrado de lo guardado en la base. El AAD ata un sobre a su dueño (el token de
 * WhatsApp de un cliente no abre si se lo copia a la fila de otro); sin AAD el sobre
 * es el de siempre, y lo ya guardado se sigue leyendo.
 */

import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { createCipheriv, createDecipheriv, createHash, hkdfSync } from "node:crypto";

vi.mock("server-only", () => ({}));

import { cifrar, cifrarConClave, descifrar } from "@/lib/security/cifrado";

const SAVED = { ...process.env };
const CLAVE = "test-encryption-key";
const AAD = "wa:tenant-1:200000000000001";

beforeEach(() => {
  process.env.GMAIL_TOKEN_ENCRYPTION_KEY = CLAVE;
});

afterEach(() => {
  process.env = { ...SAVED };
});

/** El sobre como se armaba antes del AAD: la misma cuenta, escrita aparte para no depender del módulo. */
function sobreDeSiempre(texto: string): string {
  const clave = createHash("sha256").update(CLAVE).digest();
  const iv = Buffer.alloc(12, 7);
  const cipher = createCipheriv("aes-256-gcm", clave, iv, { authTagLength: 16 });
  const cifrado = Buffer.concat([cipher.update(texto, "utf8"), cipher.final()]);
  return [iv, cipher.getAuthTag(), cifrado].map((b) => b.toString("base64url")).join(".");
}

function abrirSinAad(sobre: string): string {
  const [iv, tag, ct] = sobre.split(".").map((p) => Buffer.from(p, "base64url"));
  const clave = createHash("sha256").update(CLAVE).digest();
  const decipher = createDecipheriv("aes-256-gcm", clave, iv, { authTagLength: 16 });
  decipher.setAuthTag(tag);
  return Buffer.concat([decipher.update(ct), decipher.final()]).toString("utf8");
}

describe("cifrar y descifrar con AAD", () => {
  it("ida y vuelta con el mismo AAD", () => {
    const sobre = cifrar("fake-wa-token", AAD);

    expect(sobre).not.toContain("fake-wa-token");
    expect(descifrar(sobre, undefined, AAD)).toBe("fake-wa-token");
  });

  it("con otro AAD no abre: ni el de otro inquilino ni el de otra WABA", () => {
    const sobre = cifrar("fake-wa-token", "wa:tenant-1:200000000000001");

    expect(() => descifrar(sobre, undefined, "wa:tenant-2:200000000000001")).toThrow();
    expect(() => descifrar(sobre, undefined, "wa:tenant-1:200000000000002")).toThrow();
    expect(() => descifrar(sobre, undefined, "wa-pin:tenant-1:200000000000001")).toThrow();
  });

  it("un sobre con AAD no abre sin AAD, y uno sin AAD no abre con él", () => {
    expect(() => descifrar(cifrar("fake-wa-token", AAD))).toThrow();
    expect(() => descifrar(cifrar("fake-wa-token"), undefined, AAD)).toThrow();
  });

  it("el AAD no va dentro del sobre", () => {
    expect(cifrar("fake-wa-token", AAD)).not.toContain(Buffer.from(AAD).toString("base64url"));
  });

  it("el mensaje de error propio sigue valiendo para un sobre mal formado, con AAD o sin él", () => {
    expect(() => descifrar("a.b", "token raro", AAD)).toThrow("token raro");
    expect(() => descifrar("a.b", "token raro")).toThrow("token raro");
  });

  it("una etiqueta de otro largo se rechaza antes de descifrar, también con AAD", () => {
    const [iv, , ct] = cifrar("fake-wa-token", AAD).split(".");
    const corta = [iv, Buffer.alloc(4).toString("base64url"), ct].join(".");

    expect(() => descifrar(corta, "token raro", AAD)).toThrow("token raro");
  });
});

describe("sin AAD el sobre es el de siempre", () => {
  it("lo que cifrar escribe lo abre un descifrado hecho a mano, sin AAD", () => {
    expect(abrirSinAad(cifrar("fake-gmail-refresh"))).toBe("fake-gmail-refresh");
  });

  it("lo que ya estaba guardado se sigue leyendo", () => {
    expect(descifrar(sobreDeSiempre("fake-gmail-refresh"))).toBe("fake-gmail-refresh");
  });

  it("cada cifrado usa su propio iv", () => {
    expect(cifrar("fake-gmail-refresh")).not.toBe(cifrar("fake-gmail-refresh"));
  });

  it("sin la clave del entorno no cifra ni con AAD", () => {
    delete process.env.GMAIL_TOKEN_ENCRYPTION_KEY;

    expect(() => cifrar("fake-wa-token", AAD)).toThrow("GMAIL_TOKEN_ENCRYPTION_KEY");
  });
});

describe("el sobre versionado v2", () => {
  const AAD_V2 = "wa-secreto:tenant-1:1234567890123";
  const CLAVE_WA = "test-whatsapp-app-secrets-key";

  beforeEach(() => {
    process.env.WHATSAPP_APP_SECRETS_KEY = CLAVE_WA;
  });

  /** Lo mismo que hace el módulo, escrito aparte: la clave sale de HKDF con el kid como info. */
  function abrirV2ADedo(sobre: string, aad: string, secreto = CLAVE_WA): string {
    const [, kid, iv, tag, ct] = sobre.split(".");
    const clave = Buffer.from(hkdfSync("sha256", secreto, "claimmix", kid, 32));
    const decipher = createDecipheriv("aes-256-gcm", clave, Buffer.from(iv, "base64url"), { authTagLength: 16 });
    decipher.setAAD(Buffer.from(aad, "utf8"));
    decipher.setAuthTag(Buffer.from(tag, "base64url"));
    return Buffer.concat([decipher.update(Buffer.from(ct, "base64url")), decipher.final()]).toString("utf8");
  }

  it("tiene la forma v2.<kid>.<iv>.<tag>.<ct>, con el kid a la vista y el secreto no", () => {
    const sobre = cifrarConClave("wa1", "fake-client-app-secret", AAD_V2);

    const partes = sobre.split(".");
    expect(partes).toHaveLength(5);
    expect(partes.slice(0, 2)).toEqual(["v2", "wa1"]);
    expect(sobre).not.toContain("fake-client-app-secret");
    expect(Buffer.from(partes[3], "base64url")).toHaveLength(16);
  });

  it("ida y vuelta con el kid y el AAD", () => {
    expect(descifrar(cifrarConClave("wa1", "fake-client-app-secret", AAD_V2), undefined, AAD_V2)).toBe("fake-client-app-secret");
  });

  it("un descifrado hecho a mano con HKDF(WHATSAPP_APP_SECRETS_KEY, claimmix, wa1) lo abre: el formato es ese", () => {
    expect(abrirV2ADedo(cifrarConClave("wa1", "fake-client-app-secret", AAD_V2), AAD_V2)).toBe("fake-client-app-secret");
  });

  it("no usa la clave de Gmail: cambiarla no lo rompe, y con ella sola no abre", () => {
    const sobre = cifrarConClave("wa1", "fake-client-app-secret", AAD_V2);

    process.env.GMAIL_TOKEN_ENCRYPTION_KEY = "test-otra-clave-de-gmail";
    expect(descifrar(sobre, undefined, AAD_V2)).toBe("fake-client-app-secret");
    expect(() => abrirV2ADedo(sobre, AAD_V2, "test-otra-clave-de-gmail")).toThrow();
  });

  it("cada cifrado usa su propio iv", () => {
    expect(cifrarConClave("wa1", "fake-client-app-secret", AAD_V2)).not.toBe(cifrarConClave("wa1", "fake-client-app-secret", AAD_V2));
  });

  it("con otro AAD no abre: otro inquilino, otra app, otro uso", () => {
    const sobre = cifrarConClave("wa1", "fake-client-app-secret", AAD_V2);

    expect(() => descifrar(sobre, undefined, "wa-secreto:tenant-2:1234567890123")).toThrow();
    expect(() => descifrar(sobre, undefined, "wa-secreto:tenant-1:1234567890124")).toThrow();
    expect(() => descifrar(sobre, undefined, "wa:tenant-1:1234567890123")).toThrow();
  });

  it("sin AAD no abre, y el AAD no es opcional al cifrar", () => {
    expect(() => descifrar(cifrarConClave("wa1", "fake-client-app-secret", AAD_V2))).toThrow();
    expect(() => descifrar(cifrarConClave("wa1", "fake-client-app-secret", AAD_V2), undefined, "")).toThrow();
    expect(() => cifrarConClave("wa1", "fake-client-app-secret", "")).toThrow("AAD");
  });

  it("un kid desconocido no abre, aunque el resto esté bien", () => {
    const [v, , iv, tag, ct] = cifrarConClave("wa1", "fake-client-app-secret", AAD_V2).split(".");

    expect(() => descifrar([v, "wa2", iv, tag, ct].join("."), "sobre raro", AAD_V2)).toThrow("sobre raro");
    expect(() => descifrar([v, "", iv, tag, ct].join("."), "sobre raro", AAD_V2)).toThrow("sobre raro");
  });

  it("el kid va atado a la clave: cambiar el kid del sobre no abre otra cosa", () => {
    const [v, , iv, tag, ct] = cifrarConClave("wa1", "fake-client-app-secret", AAD_V2).split(".");

    expect(() => descifrar([v, "GMAIL", iv, tag, ct].join("."), "sobre raro", AAD_V2)).toThrow("sobre raro");
  });

  it("sin WHATSAPP_APP_SECRETS_KEY no cifra ni abre, y nombra la variable al cifrar", () => {
    const sobre = cifrarConClave("wa1", "fake-client-app-secret", AAD_V2);
    delete process.env.WHATSAPP_APP_SECRETS_KEY;

    expect(() => cifrarConClave("wa1", "fake-client-app-secret", AAD_V2)).toThrow("WHATSAPP_APP_SECRETS_KEY");
    expect(() => descifrar(sobre, "sobre raro", AAD_V2)).toThrow("sobre raro");
  });

  it("con otra WHATSAPP_APP_SECRETS_KEY no abre", () => {
    const sobre = cifrarConClave("wa1", "fake-client-app-secret", AAD_V2);
    process.env.WHATSAPP_APP_SECRETS_KEY = "test-otra-clave-de-secretos";

    expect(() => descifrar(sobre, "sobre raro", AAD_V2)).toThrow();
  });

  it.each([
    ["con una parte de menos", (p: string[]) => p.slice(0, 4)],
    ["con una parte de más", (p: string[]) => [...p, "x"]],
    ["sin iv", (p: string[]) => [p[0], p[1], "", p[3], p[4]]],
    ["sin etiqueta", (p: string[]) => [p[0], p[1], p[2], "", p[4]]],
    ["sin texto cifrado", (p: string[]) => [p[0], p[1], p[2], p[3], ""]],
    ["con una etiqueta de 4 bytes", (p: string[]) => [p[0], p[1], p[2], Buffer.alloc(4).toString("base64url"), p[4]]],
  ])("un sobre v2 %s da el mensaje de error propio", (_caso, torcer) => {
    const partes = cifrarConClave("wa1", "fake-client-app-secret", AAD_V2).split(".");

    expect(() => descifrar(torcer(partes).join("."), "sobre raro", AAD_V2)).toThrow("sobre raro");
  });

  it("un byte cambiado en el texto cifrado no abre", () => {
    const partes = cifrarConClave("wa1", "fake-client-app-secret", AAD_V2).split(".");
    partes[4] = (partes[4][0] === "A" ? "B" : "A") + partes[4].slice(1);

    expect(() => descifrar(partes.join("."), "sobre raro", AAD_V2)).toThrow();
  });

  it("los sobres de siempre siguen abriendo al lado de los v2, y no se confunden", () => {
    const viejo = cifrar("fake-wa-token", AAD);
    const nuevo = cifrarConClave("wa1", "fake-client-app-secret", AAD_V2);

    expect(descifrar(viejo, undefined, AAD)).toBe("fake-wa-token");
    expect(descifrar(sobreDeSiempre("fake-gmail-refresh"))).toBe("fake-gmail-refresh");
    expect(descifrar(nuevo, undefined, AAD_V2)).toBe("fake-client-app-secret");
    expect(nuevo.split(".")).toHaveLength(5);
    expect(viejo.split(".")).toHaveLength(3);
  });

  it("un sobre viejo con la forma de un v2 no se cuela por la clave de Gmail", () => {
    const [iv, tag, ct] = cifrar("fake-wa-token", AAD).split(".");

    expect(() => descifrar(["v2", "wa1", iv, tag, ct].join("."), "sobre raro", AAD)).toThrow();
  });
});
