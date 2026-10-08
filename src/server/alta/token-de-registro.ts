/**
 * El enlace de «Activar tu cuenta»: lo que escribió la persona en /registro hasta
 * que abre el mail.
 *
 * No hay cuenta hasta que vuelve del enlace: el pedido no escribe ninguna fila,
 * así que quien tipea direcciones ajenas no deja cuentas sin dueño ni perfiles
 * huérfanos que barrer. Todo lo que hace falta para crearla viaja en el enlace.
 *
 * Va SELLADO con AES-256-GCM y no sólo firmado: lleva el correo y el teléfono, y
 * el enlace pasa por historiales, proxies y reenvíos. La clave sale de
 * BETTER_AUTH_SECRET por HKDF con su propio `info` (ver sellado.ts).
 *
 * Sin estado: abrirlo dos veces da los mismos datos. Que el segundo uso no cree
 * nada lo resuelve la cuenta, que ya existe (`crearCuentaDesdeCorreo`).
 *
 * Dura una hora, como el enlace de restablecer.
 */

import "server-only";

import type { Locale } from "@/lib/i18n";
import { DEFAULT_LOCALE, SUPPORTED_LOCALES } from "@/lib/i18n/locale-shared";
import { SignUpSchema } from "@/lib/schemas/auth";
import { abrir, sellar } from "@/server/alta/sellado";
import { normalizarE164, validarEmpresa } from "@/server/alta/validar";

export const DURACION_DEL_TOKEN_MS = 60 * 60 * 1000;

const INFO = "alta-correo";

export interface DatosDelToken {
  /** El correo, ya en minúsculas. */
  e: string;
  empresa: string;
  numero: string;
  nombre: string;
  locale: Locale;
  /** Epoch ms en que deja de valer. */
  exp: number;
}

/** El valor del parámetro `t`: `v1.iv.tag.cifrado` en base64url. Lanza si falta BETTER_AUTH_SECRET. */
export function sellarToken(datos: Omit<DatosDelToken, "exp">, ahora = Date.now()): string {
  const completos: DatosDelToken = { ...datos, exp: ahora + DURACION_DEL_TOKEN_MS };
  return sellar(INFO, completos);
}

/** Los datos, o null si falta, no abre, venció o no tiene la forma que sellamos. */
export function abrirToken(valor: unknown, ahora = Date.now()): DatosDelToken | null {
  if (typeof valor !== "string") return null;
  const d = abrir(INFO, valor) as Partial<DatosDelToken> | null;
  if (!d || typeof d !== "object") return null;
  if (typeof d.exp !== "number" || d.exp <= ahora) return null;

  const cuenta = SignUpSchema.safeParse({ full_name: d.nombre, email: d.e });
  const empresa = validarEmpresa(d.empresa);
  if (!cuenta.success || !empresa.ok) return null;
  if (typeof d.numero !== "string" || normalizarE164(d.numero) !== d.numero) return null;

  const locale = SUPPORTED_LOCALES.find((l) => l === d.locale) ?? DEFAULT_LOCALE;
  return {
    e: cuenta.data.email,
    empresa: empresa.empresa,
    numero: d.numero,
    nombre: cuenta.data.full_name,
    locale,
    exp: d.exp,
  };
}
