/**
 * Lo que ya entendimos, dicho como lo diría una persona.
 *
 * El ensayo del 22/09 mandó «¿fue el 2026-09-22?», «no hubo personas
 * lastimadas (null)» y «(false)»: el valor de la base viajaba crudo a la
 * pregunta. Esto lo traduce una sola vez, en `buildAskList`; la base no cambia.
 * `null` quiere decir que no sabemos nada que mostrar: el campo se pide, no se
 * confirma.
 */

import { canonicalFieldKey, displayFieldValue } from "@/lib/labels/claim-fields";

const ISO = /^(\d{4})-(\d{2})-(\d{2})(?:[T ].*)?$/;

// Un Map y no un objeto: `{}["constructor"]` devuelve una función.
const SI_NO = new Map([
  ["true", "sí"],
  ["si", "sí"],
  ["sí", "sí"],
  ["yes", "sí"],
  ["false", "no"],
  ["no", "no"],
]);
const GRAVEDAD = new Map([
  ["none", "no"],
  ["minor", "sí"],
  ["severe", "sí"],
  ["fatal", "sí"],
]);

/** Un valor que el extractor escribió como texto sin decir nada. */
export function esValorVacio(valor: string | null | undefined): boolean {
  const v = (valor ?? "").trim().toLowerCase();
  return v === "" || v === "null" || v === "undefined";
}

// Se arma y se formatea en UTC: `new Date("2026-09-22")` mostrado en hora
// argentina es el 21. Y se valida ida y vuelta, porque `Date.UTC` convierte el
// 31 de febrero en 3 de marzo sin avisar.
function fechaDicha(anio: number, mes: number, dia: number, hoy: string): string | null {
  const fecha = new Date(Date.UTC(anio, mes - 1, dia));
  if (
    fecha.getUTCFullYear() !== anio ||
    fecha.getUTCMonth() !== mes - 1 ||
    fecha.getUTCDate() !== dia
  ) {
    return null;
  }
  return fecha.toLocaleDateString("es-AR", {
    timeZone: "UTC",
    day: "numeric",
    month: "long",
    year: String(anio) !== hoy.slice(0, 4) ? "numeric" : undefined,
  });
}

/**
 * @param hoy El día argentino, `AAAA-MM-DD`: el núcleo no tiene reloj.
 *
 * Para `claim_type` no es idempotente —«choque de vehículo» no es un tipo y da
 * `null`—, así que se aplica una sola vez.
 */
export function valorLegible(
  clave: string,
  valor: string | null | undefined,
  hoy: string
): string | null {
  if (esValorVacio(valor)) return null;
  const v = (valor ?? "").trim();
  const canon = canonicalFieldKey(clave);

  if (canon === "claim_type") return displayFieldValue(canon, v);

  if (canon === "accident_date") {
    const iso = ISO.exec(v);
    return iso ? fechaDicha(Number(iso[1]), Number(iso[2]), Number(iso[3]), hoy) : v;
  }

  const llave = v.toLowerCase();
  return (
    SI_NO.get(llave) ?? (canon === "hay_heridos" ? GRAVEDAD.get(llave) : undefined) ?? v
  );
}
