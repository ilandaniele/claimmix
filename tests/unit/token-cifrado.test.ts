/**
 * El sobre que guarda el token de Gmail.
 *
 * Adentro va el permiso permanente para leer y escribir en la casilla de una
 * aseguradora. Se guarda cifrado con AES-256-GCM, y en GCM la etiqueta de
 * autenticación es lo único que separa un texto cifrado legítimo de uno
 * fabricado.
 *
 * Node, si no se le dice el largo, acepta al descifrar etiquetas de 4, 8, 12,
 * 13, 14, 15 o 16 bytes. Quien pudiera escribir la columna podía entonces
 * mandar una de 4 bytes y bajar el costo de falsificarla de 2^128 a 2^32 — un
 * rato de CPU. Lo marcó Semgrep como `gcm-no-tag-length` durante meses; el job
 * estaba en verde porque el paso terminaba en `|| true`.
 *
 * Estos tests existen para que el largo no se vuelva a soltar sin que alguien
 * lo note, y —la otra mitad, que importa igual— para que apretar la guarda no
 * deje afuera los sobres que ya están guardados.
 */
import { describe, it, expect, beforeAll } from "vitest";

let encryptRefreshToken: (t: string) => string;
let decryptRefreshToken: (t: string) => string;

beforeAll(async () => {
  process.env.GMAIL_TOKEN_ENCRYPTION_KEY ||= "clave-de-prueba-para-los-tests";
  const mod = await import("@/server/email/gmail/accounts");
  encryptRefreshToken = mod.encryptRefreshToken;
  decryptRefreshToken = mod.decryptRefreshToken;
});

/** Las tres partes del sobre: iv, etiqueta, texto cifrado. */
function partes(sobre: string) {
  const [iv, tag, ct] = sobre.split(".");
  return { iv: iv!, tag: tag!, ct: ct! };
}

function conEtiquetaDe(sobre: string, bytes: number) {
  const p = partes(sobre);
  const corta = Buffer.from(p.tag, "base64url").subarray(0, bytes).toString("base64url");
  return [p.iv, corta, p.ct].join(".");
}

const TOKEN = "1//0aBcDeFgHiJkLmNoPqRsTuVwXyZ-token-de-refresco-de-ejemplo";

describe("el sobre del token", () => {
  it("cifra y descifra el mismo valor", () => {
    expect(decryptRefreshToken(encryptRefreshToken(TOKEN))).toBe(TOKEN);
  });

  it("escribe una etiqueta de 16 bytes", () => {
    // Lo que ya está guardado en producción tiene este largo. Si esto cambiara,
    // los sobres viejos dejarían de abrir y la casilla se caería en silencio.
    const { tag } = partes(encryptRefreshToken(TOKEN));
    expect(Buffer.from(tag, "base64url")).toHaveLength(16);
  });

  it("dos cifrados del mismo token no dan el mismo sobre", () => {
    // El iv es aleatorio. Sin esto, dos aseguradoras con el mismo token se
    // reconocerían entre sí mirando la columna.
    expect(encryptRefreshToken(TOKEN)).not.toBe(encryptRefreshToken(TOKEN));
  });
});

describe("etiquetas que no miden 16 bytes", () => {
  // Los largos que Node aceptaba de más. Cada uno es una rebaja del costo de
  // falsificar: con 4 bytes son 2^32 intentos.
  for (const bytes of [4, 8, 12, 13, 14, 15]) {
    it(`rechaza una de ${bytes} bytes`, () => {
      const sobre = encryptRefreshToken(TOKEN);
      expect(() => decryptRefreshToken(conEtiquetaDe(sobre, bytes))).toThrow();
    });
  }

  it("y sigue rechazando una de 16 que no corresponde", () => {
    // La guarda del largo no reemplaza a la verificación: una etiqueta del
    // tamaño correcto pero de otro mensaje tiene que fallar igual.
    const a = encryptRefreshToken(TOKEN);
    const b = encryptRefreshToken("otro-token-completamente-distinto");
    const mezclado = [partes(a).iv, partes(b).tag, partes(a).ct].join(".");
    expect(() => decryptRefreshToken(mezclado)).toThrow();
  });

  it("un sobre con partes faltantes no explota con un error de crypto", () => {
    expect(() => decryptRefreshToken("solo-una-parte")).toThrow(/Invalid Gmail token payload/);
  });
});
