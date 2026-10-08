/**
 * Los ramos: los que trae el código y los que crea cada aseguradora.
 *
 * `claim_type` dejó de ser una lista cerrada en la base (0044): sólo se exige
 * el formato de la clave. Acá vive la lista de los ramos NATIVOS, de la que
 * sale `ClaimTypeSchema`, y cómo saber si una clave es nativa, propia o
 * desconocida sin tirar nunca por una que no se conoce.
 * Es un módulo puro: sin base, sin `process.env`.
 */

/**
 * Los ramos que el código conoce: documentos, datos, textos y extractor propios.
 * `other` va al final porque es un cajón, no un tipo de siniestro.
 */
export const RAMOS_NATIVOS = [
  "choque",
  "robo",
  "granizo",
  "incendio",
  "cristales", // vidrio del parabrisas o de las ventanillas
  "rc", // responsabilidad civil: daños a un tercero
  "robo_contenido", // robo de pertenencias de adentro del vehículo
  "accidente_personal", // lesiones (ocupante, peatón)
  "art", // accidente de trabajo o enfermedad profesional
  "vida", // fallecimiento o invalidez del asegurado
  "integral_comercio", // daños o robo en un local o comercio
  "consorcio", // daños en las partes comunes de un edificio
  "other",
] as const;

export type RamoNativo = (typeof RAMOS_NATIVOS)[number];

/**
 * Los ramos con pocos casos reales: tienen reglas, pero todavía no hay base para
 * fiarse de la extracción y de los pasos sin mirarlos. Sólo avisa en el detalle;
 * no cambia qué se pide ni quién lo ve.
 */
export const RAMOS_EN_CALIBRACION = ["cristales", "rc", "robo_contenido", "accidente_personal"] as const;

export function esRamoEnCalibracion(clave: string | null): boolean {
  return clave !== null && (RAMOS_EN_CALIBRACION as readonly string[]).includes(clave);
}

/** El mismo formato que el CHECK de `cases.claim_type` (0044). */
// Sin zod: este módulo lo importa código que viaja al navegador. El esquema vive en `lib/schemas/cases.ts`.
export const FORMATO_DE_CLAVE_DE_RAMO = /^[a-z][a-z0-9_]{1,39}$/;

/** El tope de tipos propios por inquilino: la lista viaja entera al prompt. */
export const TOPE_DE_RAMOS_PROPIOS = 30;

/** Un ramo propio del inquilino, tal como lo guarda `tenant_claim_types`. */
export interface RamoDelInquilino {
  clave: string;
  nombre_es: string;
  nombre_en: string;
  documentos: readonly string[];
  datos: readonly string[];
}

export function esRamoNativo(clave: unknown): clave is RamoNativo {
  return typeof clave === "string" && (RAMOS_NATIVOS as readonly string[]).includes(clave);
}

/**
 * ¿La clave es un ramo que este inquilino admite? Nativo o propio.
 * Lo usa la extracción antes de dejar pasar el `claim_type` del modelo.
 */
export function esRamoAdmitido(
  clave: string | null | undefined,
  ramosDelInquilino: readonly RamoDelInquilino[]
): boolean {
  if (!clave || !FORMATO_DE_CLAVE_DE_RAMO.test(clave)) return false;
  return esRamoNativo(clave) || ramosDelInquilino.some((r) => r.clave === clave);
}

/** `mi_ramo_raro` → `Mi ramo raro`. Último recurso, cuando no hay nombre. */
export function humanizarClaveDeRamo(clave: string): string {
  const frase = clave.split("_").filter(Boolean).join(" ");
  return frase.charAt(0).toUpperCase() + frase.slice(1);
}

/**
 * El nombre de un ramo NO nativo en el idioma pedido: el del inquilino, o la
 * clave humanizada si el ramo ya no existe. Los nativos se nombran con
 * `type.<clave>` del diccionario, no acá.
 */
export function nombreDeRamoPropio(
  clave: string,
  ramosDelInquilino: readonly RamoDelInquilino[],
  idioma: "es-AR" | "en-US"
): string {
  const propio = ramosDelInquilino.find((r) => r.clave === clave);
  if (!propio) return humanizarClaveDeRamo(clave);
  return idioma === "en-US" ? propio.nombre_en : propio.nombre_es;
}

/**
 * El `policy_type` de una póliza que cubre este ramo. Lo usa el ensayo de
 * conversaciones para sembrar la póliza del caso; `policies.policy_type` es
 * texto libre.
 */
export function policyTypeDeRamo(clave: string | null | undefined): string {
  switch (clave) {
    case "vida":
      return "life";
    case "integral_comercio":
      return "business";
    case "art":
    case "consorcio":
      return "other";
    default:
      return "auto";
  }
}
