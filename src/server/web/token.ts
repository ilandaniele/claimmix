import "server-only";

import { createHmac, hkdfSync } from "node:crypto";

import { timingSafeStringEqual } from "@/lib/security/compare";

/*
 * El token que firma la página del formulario público.
 *
 * Sin CAPTCHA de terceros: un bot que postea directo a la ruta no pasó por la
 * página, así que no tiene token; uno que lo saca de la página y postea en el
 * acto se delata por la hora. La firma ata el token al enlace (`slug`) y a la
 * hora en que se pintó la página, sin guardar nada en la base.
 *
 * La clave sale de BETTER_AUTH_SECRET por HKDF con su propio `info`: sirve
 * sólo para esto y no agrega una variable de entorno que rotar. No frena a
 * quien reusa un token vigente (hasta 24 h); eso lo acota el tope por IP. El
 * plazo es largo a propósito: quien denuncia un siniestro puede dejar la página
 * abierta mientras junta datos, y un token vencido le haría perder el relato.
 */

const EDAD_MINIMA_MS = 4_000;
const EDAD_MAXIMA_MS = 24 * 60 * 60 * 1000;

export type ResultadoDelToken = "ok" | "invalido" | "muy_rapido" | "vencido";

function clave(): Buffer {
  const secreto = process.env.BETTER_AUTH_SECRET?.trim();
  if (!secreto) throw new Error("Falta BETTER_AUTH_SECRET");
  return Buffer.from(hkdfSync("sha256", secreto, "claimmix", "formulario-web-v1", 32));
}

const firmar = (slug: string, emitidoEn: number) =>
  createHmac("sha256", clave()).update(`${slug}.${emitidoEn}`).digest("hex");

export function firmarToken(slug: string, ahora = Date.now()): string {
  return `${ahora}.${firmar(slug, ahora)}`;
}

export function verificarToken(
  token: string | undefined,
  slug: string,
  ahora = Date.now()
): ResultadoDelToken {
  const partes = /^(\d{10,15})\.([0-9a-f]{64})$/.exec(token ?? "");
  if (!partes) return "invalido";
  const emitidoEn = Number(partes[1]);
  let esperada: string;
  try {
    esperada = firmar(slug, emitidoEn);
  } catch {
    return "invalido";
  }
  if (!timingSafeStringEqual(partes[2], esperada)) return "invalido";
  const edad = ahora - emitidoEn;
  if (edad < EDAD_MINIMA_MS) return "muy_rapido";
  if (edad > EDAD_MAXIMA_MS) return "vencido";
  return "ok";
}
