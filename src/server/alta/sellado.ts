/**
 * Sellar un valor con AES-256-GCM: lo que viaja en una cookie o en un enlace y la
 * persona no tiene que poder leer ni armar a su gusto.
 *
 * La clave sale de BETTER_AUTH_SECRET por HKDF con un `info` propio de cada uso,
 * así que un valor sellado para un fin no abre en otro y no se agrega ninguna
 * variable que rotar. Lo comparten `cm_alta` (cookie.ts) y el enlace de alta por
 * correo (token-de-registro.ts); cada uno revisa la forma de lo que abre.
 */

import "server-only";

import { createCipheriv, createDecipheriv, createHmac, hkdfSync, randomBytes } from "node:crypto";

const ALGORITMO = "aes-256-gcm";
/** El largo de la etiqueta se declara a mano en los dos lados, como en `cifrado.ts`. */
const TAG_BYTES = 16;
const VERSION = "v1";

function clave(info: string): Buffer {
  const secreto = process.env.BETTER_AUTH_SECRET?.trim();
  if (!secreto) throw new Error("Falta BETTER_AUTH_SECRET");
  return Buffer.from(hkdfSync("sha256", secreto, "claimmix", info, 32));
}

/** `v1.iv.tag.cifrado` en base64url. Lanza si falta BETTER_AUTH_SECRET. */
export function sellar(info: string, datos: unknown): string {
  const iv = randomBytes(12);
  const cipher = createCipheriv(ALGORITMO, clave(info), iv, { authTagLength: TAG_BYTES });
  const cifrado = Buffer.concat([cipher.update(JSON.stringify(datos), "utf8"), cipher.final()]);
  return [VERSION, ...[iv, cipher.getAuthTag(), cifrado].map((b) => b.toString("base64url"))].join(".");
}

/**
 * Una marca que sólo este servidor sabe armar para ese `dato`: HMAC-SHA256 con la clave del `info`,
 * en base64url. Se recalcula cada vez, no se guarda; cambia si se rota BETTER_AUTH_SECRET.
 * Lanza si falta BETTER_AUTH_SECRET.
 */
export function derivar(info: string, dato: string): string {
  return createHmac("sha256", clave(info)).update(dato, "utf8").digest("base64url");
}

/** Lo que se selló con ese `info`, sin revisar su forma; null si falta, no abre o falta el secreto. */
export function abrir(info: string, valor: string | undefined): unknown {
  const [version, ivCrudo, tagCrudo, cifradoCrudo, sobra] = (valor ?? "").split(".");
  if (version !== VERSION || !ivCrudo || !tagCrudo || !cifradoCrudo || sobra !== undefined) return null;

  try {
    const tag = Buffer.from(tagCrudo, "base64url");
    if (tag.length !== TAG_BYTES) return null;
    const decipher = createDecipheriv(ALGORITMO, clave(info), Buffer.from(ivCrudo, "base64url"), {
      authTagLength: TAG_BYTES,
    });
    decipher.setAuthTag(tag);
    const claro = Buffer.concat([
      decipher.update(Buffer.from(cifradoCrudo, "base64url")),
      decipher.final(),
    ]).toString("utf8");
    return JSON.parse(claro);
  } catch {
    return null;
  }
}
