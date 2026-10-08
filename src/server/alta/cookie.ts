/**
 * `cm_alta`: lo que escribió la persona en /registro hasta que vuelve de Google.
 *
 * El viaje a Google pierde el formulario, y la empresa y el WhatsApp no pueden ir
 * en la URL de vuelta. Se guardan en esta cookie, sellada con AES-256-GCM: la
 * persona no la lee ni la arma a su gusto, y una vencida o adulterada es una
 * cookie que no existe. La abre /alta, que además deja que la persona corrija
 * los datos antes de crear nada: la cookie precarga el formulario, no decide.
 *
 * La clave sale de BETTER_AUTH_SECRET por HKDF con su propio `info`, como el
 * token del formulario web: no agrega una variable que rotar.
 *
 * Dura una hora, y sólo viaja a /alta. No lleva ni al usuario ni la IP: es del
 * navegador, no de una cuenta. Por eso, en un navegador compartido, la podría
 * encontrar otra persona que entre a /alta antes de que termine la primera. Para
 * que no la tome por suya, lleva un número al azar (`v`) que también va en la URL
 * de vuelta de Google: `/alta` envía sola y tilda los términos sólo cuando llega
 * por el viaje que dejó la cookie, es decir, cuando coinciden.
 */

import "server-only";

import { randomBytes } from "node:crypto";

import { cookies } from "next/headers";

import type { Locale } from "@/lib/i18n";
import { DEFAULT_LOCALE, SUPPORTED_LOCALES } from "@/lib/i18n/locale-shared";
import { abrir, sellar } from "@/server/alta/sellado";
import { normalizarE164, validarEmpresa } from "@/server/alta/validar";

export const COOKIE_DE_ALTA = "cm_alta";
export const RUTA_DE_LA_COOKIE = "/alta";
export const DURACION_DE_LA_COOKIE_MS = 60 * 60 * 1000;
/** El parámetro de /alta que trae `v` de vuelta de Google. */
export const PARAMETRO_DE_VUELTA = "v";

const INFO = "cm_alta";
/** 16 bytes al azar en base64url. */
const FORMA_DE_V = /^[A-Za-z0-9_-]{22}$/;

export interface DatosDeAlta {
  empresa: string;
  numero: string;
  locale: Locale;
  origen: "google";
  /** Al azar por cookie: ata la cookie al viaje a Google que la dejó (ver arriba). */
  v: string;
  /** Epoch ms en que deja de valer. */
  exp: number;
}

/** El valor de la cookie: `v1.iv.tag.cifrado` en base64url. Lanza si falta BETTER_AUTH_SECRET. */
export function sellarAlta(datos: Omit<DatosDeAlta, "exp">, ahora = Date.now()): string {
  const completos: DatosDeAlta = { ...datos, exp: ahora + DURACION_DE_LA_COOKIE_MS };
  return sellar(INFO, completos);
}

/** Los datos, o null si falta, no abre, venció o no tiene la forma que sellamos. */
export function abrirAlta(valor: string | undefined, ahora = Date.now()): DatosDeAlta | null {
  const d = abrir(INFO, valor) as Partial<DatosDeAlta> | null;
  if (!d || typeof d !== "object") return null;
  if (typeof d.exp !== "number" || d.exp <= ahora) return null;
  if (d.origen !== "google" || typeof d.v !== "string" || !FORMA_DE_V.test(d.v)) return null;
  const empresa = validarEmpresa(d.empresa);
  if (!empresa.ok || typeof d.numero !== "string" || normalizarE164(d.numero) !== d.numero) return null;
  const locale = SUPPORTED_LOCALES.find((l) => l === d.locale) ?? DEFAULT_LOCALE;
  return { empresa: empresa.empresa, numero: d.numero, locale, origen: "google", v: d.v, exp: d.exp };
}

/**
 * La deja en el navegador y devuelve su `v`, que la URL de vuelta de Google tiene
 * que llevar. Sólo para una acción de servidor o una ruta: ahí se pueden escribir cookies.
 */
export async function ponerCookieDeAlta(datos: Omit<DatosDeAlta, "exp" | "v">): Promise<string> {
  const v = randomBytes(16).toString("base64url");
  (await cookies()).set(COOKIE_DE_ALTA, sellarAlta({ ...datos, v }), {
    httpOnly: true,
    secure: true,
    sameSite: "lax",
    path: RUTA_DE_LA_COOKIE,
    maxAge: DURACION_DE_LA_COOKIE_MS / 1000,
  });
  return v;
}

/** Lo que dejó /registro, o null. Una falla al abrirla (sin secreto, adulterada) es «no hay cookie». */
export async function leerCookieDeAlta(): Promise<DatosDeAlta | null> {
  return abrirAlta((await cookies()).get(COOKIE_DE_ALTA)?.value);
}

export async function borrarCookieDeAlta(): Promise<void> {
  (await cookies()).delete({ name: COOKIE_DE_ALTA, path: RUTA_DE_LA_COOKIE });
}
