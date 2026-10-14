/**
 * El cifrado de lo que se guarda en la base: tokens de Gmail, claves de IA y
 * el secreto de firma del webhook al Core.
 *
 * AES-256-GCM con la clave derivada de `GMAIL_TOKEN_ENCRYPTION_KEY`, y el sobre
 * `iv.tag.ct` en base64url. Era el mismo código copiado en dos módulos; el
 * formato es byte a byte el de siempre, así que lo ya guardado se sigue leyendo
 * sin volver a cifrar nada. El App Secret de un cliente usa el sobre versionado
 * de más abajo.
 */

import "server-only";
import { createCipheriv, createDecipheriv, createHash, hkdfSync, randomBytes } from "node:crypto";

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

/*
 * `aad` ata el sobre a su dueño: el texto cifrado de un inquilino no descifra
 * si se lo copia a la fila de otro. Sin `aad` el sobre es el de siempre, byte a
 * byte; con él, hay que dar el mismo valor para abrirlo.
 */
export function cifrar(texto: string, aad?: string): string {
  const iv = randomBytes(12);
  const cipher = createCipheriv(ALGORITMO, clave(), iv, { authTagLength: TAG_BYTES });
  if (aad !== undefined) cipher.setAAD(Buffer.from(aad, "utf8"));
  const cifrado = Buffer.concat([cipher.update(texto, "utf8"), cipher.final()]);
  return [iv, cipher.getAuthTag(), cifrado].map((b) => b.toString("base64url")).join(".");
}

/*
 * El sobre versionado `v2.<kid>.<iv>.<tag>.<ct>`: la clave sale de una variable
 * propia en vez de `GMAIL_TOKEN_ENCRYPTION_KEY`, así que el App Secret de un
 * cliente no queda atado a la clave de los tokens de Gmail y se puede rotar
 * sumando un `kid` nuevo. El AAD es obligatorio: un secreto sin dueño no se guarda.
 */
export type IdDeClave = "wa1";

const VARIABLE_DE_CLAVE: ReadonlyMap<string, string> = new Map([["wa1", "WHATSAPP_APP_SECRETS_KEY"]]);
const VERSION_V2 = "v2";

/** La clave del `kid`, o null si ese `kid` no existe o su variable no está cargada. */
function claveDelId(kid: string): Buffer | null {
  const variable = VARIABLE_DE_CLAVE.get(kid);
  const secreto = variable ? process.env[variable] : undefined;
  return secreto ? Buffer.from(hkdfSync("sha256", secreto, "claimmix", kid, 32)) : null;
}

export function cifrarConClave(kid: IdDeClave, texto: string, aad: string): string {
  const clave = claveDelId(kid);
  if (!clave) throw new Error(`${VARIABLE_DE_CLAVE.get(kid)} must be set to store encrypted secrets`);
  if (!aad) throw new Error("AAD is required for versioned envelopes");
  const iv = randomBytes(12);
  const cipher = createCipheriv(ALGORITMO, clave, iv, { authTagLength: TAG_BYTES });
  cipher.setAAD(Buffer.from(aad, "utf8"));
  const cifrado = Buffer.concat([cipher.update(texto, "utf8"), cipher.final()]);
  return [VERSION_V2, kid, ...[iv, cipher.getAuthTag(), cifrado].map((b) => b.toString("base64url"))].join(".");
}

function abrir(
  claveDelSobre: () => Buffer,
  [ivRaw, tagRaw, cifradoRaw]: string[],
  mensajeDeError: string,
  aad?: string
): string {
  if (!ivRaw || !tagRaw || !cifradoRaw) throw new Error(mensajeDeError);
  const tag = Buffer.from(tagRaw, "base64url");
  if (tag.length !== TAG_BYTES) throw new Error(mensajeDeError);
  const decipher = createDecipheriv(ALGORITMO, claveDelSobre(), Buffer.from(ivRaw, "base64url"), {
    authTagLength: TAG_BYTES,
  });
  if (aad !== undefined) decipher.setAAD(Buffer.from(aad, "utf8"));
  decipher.setAuthTag(tag);
  return Buffer.concat([
    decipher.update(Buffer.from(cifradoRaw, "base64url")),
    decipher.final(),
  ]).toString("utf8");
}

/**
 * Abre los dos formatos: `iv.tag.ct` con la clave de siempre y `v2.<kid>.iv.tag.ct` con la del `kid`.
 * @param mensajeDeError el de cada llamador, que ya tiene tests y logs que lo nombran.
 */
export function descifrar(sobre: string, mensajeDeError = "Invalid encrypted payload", aad?: string): string {
  const partes = sobre.split(".");
  if (partes[0] !== VERSION_V2) return abrir(clave, partes, mensajeDeError, aad);

  const [, kid, ...resto] = partes;
  const claveV2 = kid ? claveDelId(kid) : null;
  if (partes.length !== 5 || !claveV2 || !aad) throw new Error(mensajeDeError);
  return abrir(() => claveV2, resto, mensajeDeError, aad);
}
