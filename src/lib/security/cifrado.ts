/**
 * El cifrado de lo que se guarda en la base: tokens de Gmail, claves de IA y
 * el secreto de firma del webhook al Core.
 *
 * AES-256-GCM con la clave derivada de `GMAIL_TOKEN_ENCRYPTION_KEY`, y el sobre
 * `iv.tag.ct` en base64url. Era el mismo código copiado en dos módulos; el
 * formato es byte a byte el de siempre, así que lo ya guardado se sigue leyendo
 * sin volver a cifrar nada.
 */

import "server-only";
import { createCipheriv, createDecipheriv, createHash, randomBytes } from "node:crypto";

const ALGORITMO = "aes-256-gcm";

/*
 * El largo de la etiqueta se fija a mano, y no es cosmético.
 *
 * En GCM la etiqueta de autenticación es lo único que distingue un texto
 * cifrado legítimo de uno fabricado. Node, si no se le dice el largo, acepta
 * al descifrar etiquetas de 4, 8, 12, 13, 14, 15 o 16 bytes: quien pueda
 * escribir el texto cifrado guardado puede mandar una de 4 bytes y bajar el
 * costo de falsificarla de 2^128 a 2^32, que es un rato de CPU.
 *
 * Acá adentro viajan el token de Gmail —el permiso permanente para leer y
 * escribir en la casilla— y el secreto con el que el Core confía en lo que le
 * llega, así que el largo se declara en los dos lados y una etiqueta de otro
 * tamaño se rechaza antes de intentar descifrar.
 *
 * Compatible con lo ya guardado: `getAuthTag()` viene devolviendo 16 bytes,
 * que es el valor por omisión. Esto no cambia lo que se escribe; cierra lo
 * que se acepta.
 */
const TAG_BYTES = 16;

function clave(): Buffer {
  const secreto = process.env.GMAIL_TOKEN_ENCRYPTION_KEY;
  if (!secreto) throw new Error("GMAIL_TOKEN_ENCRYPTION_KEY must be set to store encrypted secrets");
  return createHash("sha256").update(secreto).digest();
}

export function cifrar(texto: string): string {
  const iv = randomBytes(12);
  const cipher = createCipheriv(ALGORITMO, clave(), iv, { authTagLength: TAG_BYTES });
  const cifrado = Buffer.concat([cipher.update(texto, "utf8"), cipher.final()]);
  return [iv, cipher.getAuthTag(), cifrado].map((b) => b.toString("base64url")).join(".");
}

/** @param mensajeDeError el de cada llamador, que ya tiene tests y logs que lo nombran. */
export function descifrar(sobre: string, mensajeDeError = "Invalid encrypted payload"): string {
  const [ivRaw, tagRaw, cifradoRaw] = sobre.split(".");
  if (!ivRaw || !tagRaw || !cifradoRaw) throw new Error(mensajeDeError);
  const tag = Buffer.from(tagRaw, "base64url");
  if (tag.length !== TAG_BYTES) throw new Error(mensajeDeError);
  const decipher = createDecipheriv(ALGORITMO, clave(), Buffer.from(ivRaw, "base64url"), {
    authTagLength: TAG_BYTES,
  });
  decipher.setAuthTag(tag);
  return Buffer.concat([
    decipher.update(Buffer.from(cifradoRaw, "base64url")),
    decipher.final(),
  ]).toString("utf8");
}
