import "server-only";

import { createHmac, hkdfSync } from "node:crypto";
import { Resolver } from "node:dns/promises";

import { normalizarDominio } from "@/core/sso";
import { timingSafeStringEqual } from "@/lib/security/compare";

/*
 * La prueba de que el inquilino controla el dominio: un TXT en
 * `_claimmix.<dominio>` con un token que sólo nosotros podemos calcular.
 *
 * Sin tabla de tokens: sale de BETTER_AUTH_SECRET por HKDF con su propio `info`
 * (como el del formulario público) y de HMAC-SHA256 sobre tenant y dominio. Ata
 * el token a los dos: copiar el de otro inquilino o el de otro dominio no sirve.
 * Rotar el secreto invalida los TXT ya publicados; el admin vuelve a verificar.
 */

function clave(): Buffer {
  const secreto = process.env.BETTER_AUTH_SECRET?.trim();
  if (!secreto) throw new Error("Falta BETTER_AUTH_SECRET");
  return Buffer.from(hkdfSync("sha256", secreto, "claimmix", "sso-dominio-v1", 32));
}

export function tokenDeVerificacion(tenantId: string, dominio: string): string {
  return createHmac("sha256", clave())
    .update(`${tenantId}.${normalizarDominio(dominio)}`)
    .digest("base64url");
}

export const PREFIJO_DEL_TXT = "claimmix-verificacion=";

/** El registro que el admin publica en su DNS. */
export function registroDeVerificacion(tenantId: string, dominio: string) {
  return {
    nombre: `_claimmix.${normalizarDominio(dominio)}`,
    valor: `${PREFIJO_DEL_TXT}${tokenDeVerificacion(tenantId, dominio)}`,
  };
}

/** `resolveTxt` parte un TXT largo en trozos: se unen antes de comparar. */
export function txtProbado(registros: string[][], tenantId: string, dominio: string): boolean {
  const esperado = registroDeVerificacion(tenantId, dominio).valor;
  return registros.some((trozos) => timingSafeStringEqual(trozos.join("").trim(), esperado));
}

const PLAZO_DNS_MS = 4_000;

export type RespuestaTxt =
  | { ok: true; registros: string[][] }
  | { ok: false; motivo: "sin_registro" | "sin_respuesta" };

/**
 * Los TXT de un nombre, con plazo y un solo intento: el pedido espera acá.
 * «No existe» (NXDOMAIN, sin TXT) y «el DNS no contestó» se distinguen: el
 * primero es un admin que todavía no publicó o no propagó el registro.
 */
export async function resolverTxt(nombre: string): Promise<RespuestaTxt> {
  const resolver = new Resolver({ timeout: PLAZO_DNS_MS, tries: 1 });
  try {
    return { ok: true, registros: await resolver.resolveTxt(nombre) };
  } catch (e) {
    const codigo = (e as { code?: string }).code;
    return { ok: false, motivo: codigo === "ENODATA" || codigo === "ENOTFOUND" ? "sin_registro" : "sin_respuesta" };
  }
}
