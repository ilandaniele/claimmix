/**
 * Cómo se lee y se valida cada dato del padrón (B16).
 *
 * Los usan la importación por CSV y el alta y la edición a mano, así que una
 * persona y una planilla pasan por las mismas reglas. Cada `a…` devuelve el
 * valor ya normalizado, o `null` si no sirve; el mensaje de un rechazo es el
 * código que el servidor traduce (`padron.error.<codigo>`).
 */

import { z } from "zod";

import {
  MINIMO_DNI,
  MINIMO_TELEFONO,
  normalizarDni,
  normalizarEmail,
  normalizarNumeroPoliza,
  normalizarTelefono,
} from "@/core/matching/normalizar";
import { sinControl } from "@/core/text/sin-control";

export const RAMOS_DE_POLIZA = ["auto", "home", "life", "business", "other"] as const;
export const ESTADOS_DE_POLIZA = ["active", "expired", "cancelled"] as const;
export type RamoDePoliza = (typeof RAMOS_DE_POLIZA)[number];
export type EstadoDePoliza = (typeof ESTADOS_DE_POLIZA)[number];

const sinAcentos = (s: string) =>
  s
    .normalize("NFD")
    .replace(/\p{M}/gu, "")
    .toLowerCase()
    .trim();

function texto(s: string, min: number, max: number): string | null {
  if (!sinControl(s)) return null;
  const limpio = s.replace(/\s+/g, " ").trim();
  return limpio.length >= min && limpio.length <= max ? limpio : null;
}

export const aDni = (s: string): string | null => {
  if (!/^[\d.\s-]+$/.test(s)) return null;
  const dni = normalizarDni(s);
  return dni.length >= MINIMO_DNI && dni.length <= 9 ? dni : null;
};

export const aNombre = (s: string): string | null => texto(s, 2, 200);

export const aDireccion = (s: string): string | null => texto(s, 1, 300);

export const aEmail = (s: string): string | null =>
  s.length <= 254 && z.string().email().safeParse(s).success ? normalizarEmail(s) : null;

export const aTelefono = (s: string): string | null => {
  if (s.length > 30 || !/^[\d\s()+.-]+$/.test(s)) return null;
  const digitos = normalizarTelefono(s).length;
  return digitos >= MINIMO_TELEFONO && digitos <= 15 ? s.trim() : null;
};

/** `2025-03-31` o `31/03/2025`; devuelve `2025-03-31` y sólo si el día existe. */
export const aFecha = (s: string): string | null => {
  const m = /^(\d{4})-(\d{1,2})-(\d{1,2})$/.exec(s) ?? /^(\d{1,2})\/(\d{1,2})\/(\d{4})$/.exec(s);
  if (!m) return null;
  const [anio, mes, dia] = s.includes("/") ? [m[3]!, m[2]!, m[1]!] : [m[1]!, m[2]!, m[3]!];
  const fecha = new Date(Date.UTC(Number(anio), Number(mes) - 1, Number(dia)));
  if (fecha.getUTCFullYear() !== Number(anio) || fecha.getUTCMonth() !== Number(mes) - 1 || fecha.getUTCDate() !== Number(dia)) {
    return null;
  }
  return fecha.toISOString().slice(0, 10);
};

/** Una fecha de nacimiento no es del futuro ni de antes de 1900. */
export const aNacimiento = (s: string): string | null => {
  const fecha = aFecha(s);
  return fecha && fecha >= "1900-01-01" && fecha <= new Date().toISOString().slice(0, 10) ? fecha : null;
};

export const aNumeroPoliza = (s: string): string | null => {
  const numero = normalizarNumeroPoliza(s);
  return numero.length <= 60 && /^[A-Z0-9][A-Z0-9._/-]*$/.test(numero) ? numero : null;
};

const RAMOS: Record<string, RamoDePoliza> = {
  auto: "auto",
  automotor: "auto",
  automovil: "auto",
  vehiculo: "auto",
  home: "home",
  hogar: "home",
  casa: "home",
  vivienda: "home",
  life: "life",
  vida: "life",
  business: "business",
  comercio: "business",
  comercial: "business",
  empresa: "business",
  other: "other",
  otro: "other",
  otros: "other",
};

const ESTADOS: Record<string, EstadoDePoliza> = {
  active: "active",
  activa: "active",
  activo: "active",
  vigente: "active",
  expired: "expired",
  vencida: "expired",
  vencido: "expired",
  expirada: "expired",
  cancelled: "cancelled",
  canceled: "cancelled",
  cancelada: "cancelled",
  cancelado: "cancelled",
  anulada: "cancelled",
  anulado: "cancelled",
};

export const aRamo = (s: string): RamoDePoliza | null => RAMOS[sinAcentos(s)] ?? null;
export const aEstado = (s: string): EstadoDePoliza | null => ESTADOS[sinAcentos(s)] ?? null;

/**
 * `1234.56`, `1234,56`, `1.234,56` y `1,234.56` son la misma prima. El último
 * separador es decimal si lo siguen uno o dos dígitos; si no, es de miles.
 */
export const aPrima = (s: string): string | null => {
  const m = /^(\d[\d.,]*?)(?:[.,](\d{1,2}))?$/.exec(s.replace(/[\s$]/g, ""));
  if (!m) return null;
  const entero = m[1]!;
  if (!/^\d+$/.test(entero) && !/^\d{1,3}([.,]\d{3})+$/.test(entero)) return null;
  const digitos = entero.replace(/\D/g, "");
  if (digitos.length > 10) return null;
  return `${Number(digitos)}.${(m[2] ?? "").padEnd(2, "0")}`;
};

type Convertidor<T> = (s: string) => T | null;

/** Un campo de texto que se rechaza con `codigo`, a un valor ya normalizado. */
export const campo = <T>(codigo: string, convertir: Convertidor<T>) =>
  z.string().transform((s, ctx) => {
    const valor = convertir(s.trim());
    if (valor === null) {
      ctx.addIssue({ code: z.ZodIssueCode.custom, message: codigo });
      return z.NEVER;
    }
    return valor;
  });

const esVacio = (v: unknown) => v === undefined || v === null || (typeof v === "string" && v.trim() === "");

/** Vacío es «no vino»: en el alta se omite y en una importación deja el dato como está. */
export const opcional = <T>(c: z.ZodType<T, string>) =>
  z.preprocess((v) => (esVacio(v) ? undefined : v), c.optional());

/** Vacío es «borrar»: en una edición a mano, `null` limpia el campo y omitirlo lo deja igual. */
export const anulable = <T>(c: z.ZodType<T, string>) =>
  z.preprocess((v) => (v === undefined ? undefined : esVacio(v) ? null : v), c.nullable().optional());
