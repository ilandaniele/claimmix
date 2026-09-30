/**
 * ¿La póliza cubre este siniestro? Sólo para el equipo (B6).
 *
 * Compara contra el día del SINIESTRO, nunca contra hoy: una póliza vencida
 * ayer cubre un choque de la semana pasada. Ante un dato que falta la respuesta
 * es «dudoso», nunca «cubre». El veredicto no sale al asegurado.
 */

import { claveDeProvincia, esProvincia } from "@/core/geo/provincias";
import {
  AmbitoTerritorialSchema,
  CoberturaSchema,
  type CodigoDeCobertura,
  type Cobertura,
} from "@/core/poliza/condiciones";

import { dia } from "./contradicciones";
import type { MontoEstimado } from "./monto-estimado";
import { normalizarPatente } from "./patente";

export const MOTIVOS_DE_COBERTURA = [
  "sin_coberturas_cargadas",
  "poliza_no_activa",
  "sin_fecha",
  "fuera_de_vigencia",
  "sin_cobertura_para_el_tipo",
  "cobertura_segun_alcance",
  "fuera_del_ambito",
  "ambito_dudoso",
  "sin_lugar",
  "vehiculo_no_coincide",
  "bajo_franquicia",
  "supera_suma_asegurada",
] as const;

export type MotivoDeCobertura = (typeof MOTIVOS_DE_COBERTURA)[number];
export type Veredicto = "cubre" | "no_cubre" | "dudoso";

export interface PolizaParaCobertura {
  status: string;
  start_date: string | null;
  end_date: string | null;
  coberturas: unknown;
  ambito_territorial: unknown;
  patentes: readonly (string | null)[] | null;
}

export interface Cotejo {
  poliza: PolizaParaCobertura | null;
  tipo: string | null;
  /** `accident_date`, o `incident_date` si no hay: nunca la fecha de hoy. */
  fechaDelSiniestro: string | null;
  provincia: string | null;
  /** La patente del vehículo asegurado; la del tercero no dice nada de la póliza. */
  patente: string | null;
  monto: MontoEstimado | null;
}

export interface ResultadoDeCobertura {
  veredicto: Veredicto;
  motivos: MotivoDeCobertura[];
}

/**
 * Qué coberturas hacen falta para cubrir cada tipo de siniestro sea cual sea
 * su alcance. Un choque puede ser parcial o total y un robo, del auto o de
 * partes: con una sola de las dos decide el alcance, y eso lo mira una persona.
 */
const COBERTURAS_POR_TIPO: Record<string, readonly CodigoDeCobertura[]> = {
  choque: ["danio_parcial", "danio_total"],
  rc: ["rc"],
  robo: ["robo_total", "robo_parcial"],
  robo_contenido: ["robo_parcial"],
  granizo: ["granizo"],
  incendio: ["incendio"],
  cristales: ["cristales"],
  accidente_personal: ["rc"],
};

/** Las que responden por una parte del siniestro: la RC paga lo del tercero en un choque. */
const EN_PARTE: Record<string, readonly CodigoDeCobertura[]> = { choque: ["rc"] };

// La clave de un ramo propio es texto libre con formato: «constructor» indexado a secas devuelve una función.
const delTipo = (tabla: Record<string, readonly CodigoDeCobertura[]>, tipo: string) =>
  Object.hasOwn(tabla, tipo) ? tabla[tipo] : undefined;

// Capital y provincia se nombran de muchas formas; en una lista de ámbito son
// la misma entrada.
const MISMA_CAPITAL = new Set(["caba", "capital federal", "ciudad de buenos aires", "ciudad autonoma de buenos aires"]);
const provinciaComparable = (p: string) => {
  const c = claveDeProvincia(p);
  return MISMA_CAPITAL.has(c) ? "caba" : c;
};
// «Buenos Aires» se dice de la provincia y de la capital: entre las dos no se decide.
const SE_CONFUNDEN = new Set(["caba", "buenos aires"]);

function coberturasLeidas(valor: unknown): Cobertura[] {
  if (!Array.isArray(valor)) return [];
  return valor.flatMap((c) => {
    const r = CoberturaSchema.safeParse(c);
    return r.success ? [r.data] : [];
  });
}

export function evaluarCobertura(c: Cotejo): ResultadoDeCobertura {
  const graves = new Set<MotivoDeCobertura>();
  const dudas = new Set<MotivoDeCobertura>();
  const p = c.poliza;
  if (!p) return { veredicto: "dudoso", motivos: ["sin_coberturas_cargadas"] };

  // El estado es el de hoy: una póliza dada de baja pudo estar activa el día
  // del siniestro, así que marca la duda y no decide.
  if (p.status !== "active") dudas.add("poliza_no_activa");

  const fecha = dia(c.fechaDelSiniestro);
  if (fecha === null) dudas.add("sin_fecha");
  else {
    const desde = dia(p.start_date);
    const hasta = dia(p.end_date);
    if ((desde !== null && fecha < desde) || (hasta !== null && fecha > hasta)) graves.add("fuera_de_vigencia");
  }

  const coberturas = coberturasLeidas(p.coberturas);
  const tipo = c.tipo ?? "";
  const hacenFalta = delTipo(COBERTURAS_POR_TIPO, tipo);
  const aplicadas = hacenFalta ? coberturas.filter((x) => hacenFalta.includes(x.codigo)) : [];
  if (coberturas.length === 0) dudas.add("sin_coberturas_cargadas");
  else if (!hacenFalta?.every((codigo) => aplicadas.some((x) => x.codigo === codigo))) {
    const enParte = aplicadas.length > 0 || coberturas.some((x) => delTipo(EN_PARTE, tipo)?.includes(x.codigo));
    if (hacenFalta && enParte) dudas.add("cobertura_segun_alcance");
    else {
      // Sin tipo, o con una cobertura que el modelo no supo nombrar, puede
      // cubrir igual: lo decide una persona.
      const puedeSer = !hacenFalta || coberturas.some((x) => x.codigo === "otro");
      (puedeSer ? dudas : graves).add("sin_cobertura_para_el_tipo");
    }
  }

  const ambito = AmbitoTerritorialSchema.safeParse(p.ambito_territorial);
  if (ambito.success && ambito.data.tipo === "provincias") {
    const lugar = provinciaComparable(c.provincia ?? "");
    const permitidas = [...new Set(ambito.data.provincias.map(provinciaComparable))];
    if (!esProvincia(lugar)) dudas.add("sin_lugar");
    else if (!permitidas.includes(lugar)) {
      // Una lista vacía o con un nombre que no se reconoce es una lectura que
      // falló, no una provincia que la póliza deja afuera.
      const dudosa =
        permitidas.length === 0 ||
        permitidas.some((x) => !esProvincia(x) || (SE_CONFUNDEN.has(x) && SE_CONFUNDEN.has(lugar)));
      if (dudosa) dudas.add("ambito_dudoso");
      else graves.add("fuera_del_ambito");
    }
  }

  const patentes = new Set((p.patentes ?? []).filter((x): x is string => !!x).map(normalizarPatente).filter(Boolean));
  const patente = c.patente ? normalizarPatente(c.patente) : "";
  // Una patente mal tipeada no es otro auto: se marca, no se decide.
  if (patentes.size > 0 && patente && !patentes.has(patente)) dudas.add("vehiculo_no_coincide");

  // Con dos coberturas que alcanzan no se sabe cuál aplica: marca la que sea.
  if (c.monto) {
    const { minimo, maximo } = c.monto;
    for (const a of aplicadas) {
      if (a.franquicia !== null && maximo < a.franquicia) dudas.add("bajo_franquicia");
      if (a.suma_asegurada !== null && minimo > a.suma_asegurada) dudas.add("supera_suma_asegurada");
    }
  }

  const motivos = MOTIVOS_DE_COBERTURA.filter((m) => graves.has(m) || dudas.has(m));
  const veredicto: Veredicto = graves.size > 0 ? "no_cubre" : dudas.size > 0 ? "dudoso" : "cubre";
  return { veredicto, motivos };
}
