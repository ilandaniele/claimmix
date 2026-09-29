/**
 * Lo que dicen los adjuntos contra lo que dice el reclamo.
 *
 * El modelo lee cada documento y copia sus datos; la comparación se hace acá,
 * en código, porque un modelo que compara fechas se equivoca con confianza y
 * esto se tiene que poder explicar. Cada regla marca sólo cuando tiene con qué
 * comparar: un dato que falta no es una contradicción.
 *
 * Los indicios van al panel del analista y a ningún otro lado: ni a la
 * respuesta, ni al resumen, ni al orquestador. Las descripciones son fijas y
 * sin datos de nadie, para que el panel no filtre lo que el documento decía; se
 * guardan en castellano y la ficha las traduce por `clave`.
 */

import { diaArgentino } from "@/core/fecha/dia-argentino";
import { puedeSerDe } from "@/core/geo/provincias";
import { MINIMO_DNI, normalizarDni, sirveParaBuscar } from "@/core/matching/normalizar";
import { esAR } from "@/lib/i18n/es-AR";
import type { DocumentoLeido, ExtractedClaim } from "@/lib/schemas/extracted-claim";

import { mismaPersona, nombresCompatibles, normalizarPatente } from "./patente";

type Indicio = ExtractedClaim["fraud_indicators"][number];
type Nivel = ExtractedClaim["fraud_risk_level"];

export const CLAVES_DE_DERIVADO = [
  "documento_fecha",
  "documento_patente",
  "documento_dni",
  "documento_nombre",
  "foto_antes",
  "foto_futura",
  "foto_fuera_del_pais",
  "foto_fuera_de_provincia",
] as const;
export type ClaveDeDerivado = (typeof CLAVES_DE_DERIVADO)[number];

export type IndicioDerivado = Indicio & { origen: "documentos"; clave: ClaveDeDerivado };

export interface FotoCruzable {
  tomadaEn?: string;
  lat?: number;
  lon?: number;
}

export interface ReclamoCruzable {
  fecha: string | null;
  provincia: string | null;
  /** La del asegurado y la del tercero: un parte de choque puede traer cualquiera. */
  patentes: string[];
  dni: string | null;
  nombre: string | null;
}

export interface PolizaCruzable {
  patentes: string[];
  dni: string | null;
  titular: string | null;
}

const DIA_MS = 86_400_000;
const DE_EVENTO = /denuncia|constancia|parte|acta|exposici/i;
const DE_IDENTIDAD = /dni|documento|licencia|registro|c[eé]dula|p[oó]liza|carnet/i;

/** `AAAA-MM-DD` o `dd/mm/aaaa`; cualquier otra cosa no se compara. */
export function dia(valor: string | null | undefined): number | null {
  if (!valor) return null;
  const iso = /^(\d{4})-(\d{2})-(\d{2})/.exec(valor.trim());
  const ar = /^(\d{1,2})[/.-](\d{1,2})[/.-](\d{4})$/.exec(valor.trim());
  const [a, m, d] = iso ? [+iso[1]!, +iso[2]!, +iso[3]!] : ar ? [+ar[3]!, +ar[2]!, +ar[1]!] : [];
  if (!a || !m || !d) return null;
  const t = Date.UTC(a, m - 1, d);
  const f = new Date(t);
  return f.getUTCFullYear() === a && f.getUTCMonth() === m - 1 && f.getUTCDate() === d ? t : null;
}

const dniQueSirve = (d: string | null | undefined) => {
  const n = normalizarDni(d ?? "");
  return sirveParaBuscar(n, MINIMO_DNI) ? n : "";
};

/**
 * Los indicios que salen de cruzar los documentos y las fotos del caso contra
 * el reclamo y la póliza. `ahora` es la hora de la corrida: una foto fechada
 * después es un reloj mal puesto o una fecha tocada.
 */
export function cruzarDocumentos(entrada: {
  documentos: DocumentoLeido[];
  fotos: FotoCruzable[];
  reclamo: ReclamoCruzable;
  poliza: PolizaCruzable | null;
  ahora: Date;
}): IndicioDerivado[] {
  const { documentos, fotos, reclamo, poliza, ahora } = entrada;
  const salida = new Map<string, IndicioDerivado>();
  const marcar = (type: Indicio["type"], clave: ClaveDeDerivado) =>
    salida.set(clave, { type, description: esAR[`fraude.derivado.${clave}`], origen: "documentos", clave });

  const evento = dia(reclamo.fecha);
  const patentes = new Set([...reclamo.patentes, ...(poliza?.patentes ?? [])].map(normalizarPatente).filter(Boolean));
  const personas = [
    { dni: dniQueSirve(reclamo.dni), nombre: reclamo.nombre?.trim() ?? "" },
    { dni: dniQueSirve(poliza?.dni), nombre: poliza?.titular?.trim() ?? "" },
  ];

  for (const doc of documentos) {
    const tipo = doc.tipo ?? "";
    const fecha = dia(doc.fecha);
    if (evento !== null && fecha !== null && DE_EVENTO.test(tipo) && Math.abs(fecha - evento) > DIA_MS) {
      marcar("timeline_inconsistency", "documento_fecha");
    }
    const patente = doc.patente ? normalizarPatente(doc.patente) : "";
    if (patente && patentes.size > 0 && !patentes.has(patente)) {
      marcar("documentation_gap", "documento_patente");
    }
    if (!DE_IDENTIDAD.test(tipo)) continue;
    // La licencia del tercero, o la de un conductor que no es el titular, no
    // contradice nada: marca sólo el documento que por un dato es de alguien
    // del caso y por el otro no.
    const dni = dniQueSirve(doc.dni);
    const nombre = doc.nombre?.trim() ?? "";
    for (const p of personas) {
      if (dni && p.dni && p.dni !== dni && nombre && mismaPersona(p.nombre, nombre)) {
        marcar("documentation_gap", "documento_dni");
      }
      if (dni && p.dni === dni && nombre && p.nombre && !nombresCompatibles(p.nombre, nombre)) {
        marcar("documentation_gap", "documento_nombre");
      }
    }
  }

  for (const foto of fotos) {
    const instante = foto.tomadaEn ? Date.parse(foto.tomadaEn) : NaN;
    if (Number.isFinite(instante)) {
      const tomada = dia(diaArgentino(new Date(instante)));
      if (evento !== null && tomada !== null && evento - tomada > DIA_MS) {
        marcar("timeline_inconsistency", "foto_antes");
      }
      if (instante - ahora.getTime() > DIA_MS) {
        marcar("timeline_inconsistency", "foto_futura");
      }
    }
    if (foto.lat === undefined || foto.lon === undefined) continue;
    if (!puedeSerDe(foto.lat, foto.lon, null)) {
      marcar("location_inconsistency", "foto_fuera_del_pais");
    } else if (!puedeSerDe(foto.lat, foto.lon, reclamo.provincia)) {
      marcar("location_inconsistency", "foto_fuera_de_provincia");
    }
  }

  return [...salida.values()];
}

const ORDEN: Nivel[] = ["none", "low", "medium", "high"];
const nivelDe = (v: unknown): Nivel => (ORDEN.includes(v as Nivel) ? (v as Nivel) : "none");
const mayor = (...ns: Nivel[]): Nivel => ORDEN[Math.max(...ns.map((n) => ORDEN.indexOf(n)))]!;
const porCantidad = (n: number): Nivel => (n >= 2 ? "medium" : n === 1 ? "low" : "none");

const esIndicio = (v: unknown): v is Indicio & { origen?: string } =>
  !!v && typeof (v as Indicio).type === "string" && typeof (v as Indicio).description === "string";

/**
 * Lo que queda en el caso después de esta corrida.
 *
 * Los derivados se recalculan enteros cada vez, así que reemplazan a los de
 * antes. Los del modelo reemplazan a los suyos sólo si trajo alguno; si no,
 * quedan los que había. El nivel no baja de lo que había puesto el modelo, lo
 * que subían los derivados se va con ellos, y nunca es `none` con indicios.
 * `null` = no hay nada que escribir.
 */
export function fusionarIndicadores(entrada: {
  modelo: { nivel: Nivel; indicios: Indicio[] };
  existentes: { nivel: unknown; indicios: unknown };
  derivados: IndicioDerivado[];
}): { nivel: Nivel; indicios: Array<Indicio | IndicioDerivado> } | null {
  const { modelo, existentes, derivados } = entrada;
  const previos = Array.isArray(existentes.indicios) ? existentes.indicios.filter(esIndicio) : [];
  const derivadosPrevios = previos.filter((i) => i.origen === "documentos").length;
  const base = modelo.indicios.length > 0 ? modelo.indicios : previos.filter((i) => i.origen !== "documentos");
  const indicios = [...base.map(({ type, description }) => ({ type, description })), ...derivados];
  // El nivel de antes es piso sólo si pasa lo que ya ponían sus derivados.
  const previo = nivelDe(existentes.nivel);
  const piso = ORDEN.indexOf(previo) > ORDEN.indexOf(porCantidad(derivadosPrevios)) ? previo : "none";
  let nivel = mayor(modelo.nivel, piso, porCantidad(derivados.length));
  if (nivel === "none" && indicios.length > 0) nivel = "low";
  // Sin nada, igual se escribe si había derivados: si no, quedan en la ficha.
  if (nivel === "none" && derivadosPrevios === 0) return null;
  return { nivel, indicios };
}
