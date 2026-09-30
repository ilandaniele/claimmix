/**
 * Opinión PRELIMINAR de responsabilidad en un choque (B18), sólo para el
 * equipo. Es orientativa: la decide una persona, y el agente nunca le dice al
 * asegurado quién tiene la culpa.
 *
 * Sale de hechos cerrados (`Mecanica`) y de reglas de la Ley 24.449. Sin datos
 * suficientes la respuesta es «no determinable» y lista lo que falta: nunca un
 * responsable inventado. El motivo es una clave de traducción más parámetros,
 * nunca texto del modelo.
 */

import { z } from "zod";

import { CAMPOS_DE_MECANICA, PARTES, tieneMecanica, type Mecanica, type Parte } from "./mecanica";

export const REGLAS = ["ley24449_art44", "ley24449_art48g", "ley24449_art41"] as const;
export type Regla = (typeof REGLAS)[number];

export const CLAVES_DE_MOTIVO = [
  "semaforo_rojo",
  "alcance",
  "prioridad_derecha",
  "detenido",
  "compartida",
  "excepcion_prioridad",
  "sin_regla",
] as const;

const ResponsabilidadSchema = z.object({
  v: z.literal(1),
  responsable: z.enum([...PARTES, "compartida", "no_determinable"]),
  regla: z.enum(REGLAS).nullable(),
  motivo: z.object({ clave: z.enum(CLAVES_DE_MOTIVO), params: z.record(z.string(), z.string()) }),
  /** Las claves de lo que falta para decidir, traducibles. */
  faltantes: z.array(z.string()),
  /** El relato de la persona y los documentos cuentan cosas distintas. */
  difiere: z.boolean(),
});

/** Lo que se guarda en `cases.responsabilidad`. */
export type Responsabilidad = z.infer<typeof ResponsabilidadSchema>;
type Motivo = Responsabilidad["motivo"];

/** Lo guardado en la base como opinión, o `null` si no tiene la forma: mejor sin panel que con uno roto. */
export function leerResponsabilidad(valor: unknown): Responsabilidad | null {
  const r = ResponsabilidadSchema.safeParse(valor);
  return r.success ? r.data : null;
}

const EN_MARCHA = new Set(["avanzaba_recto", "giraba_izquierda", "giraba_derecha", "retrocedia", "cambiaba_carril"]);
const QUIETO = new Set(["estacionado", "detenido"]);
const CON_LUZ = new Set(["verde", "amarillo", "rojo"]);

/**
 * Cada hecho sale de los documentos; si dos documentos se contradicen queda
 * sin dato, y si el relato dice otra cosa que los documentos se avisa.
 */
function combinar(relato: Mecanica | null, documentos: Mecanica[]): { mecanica: Mecanica; difiere: boolean } {
  const mecanica: Record<string, unknown> = {};
  let difiere = false;
  for (const campo of CAMPOS_DE_MECANICA) {
    const dichos = new Set(documentos.map((d) => d[campo]).filter((v) => v !== null));
    const delRelato = relato?.[campo] ?? null;
    if (dichos.size > 1) {
      mecanica[campo] = null;
      difiere = true;
    } else if (dichos.size === 1) {
      const [dicho] = dichos;
      mecanica[campo] = dicho;
      if (delRelato !== null && delRelato !== dicho) difiere = true;
    } else mecanica[campo] = delRelato;
  }
  return { mecanica: mecanica as Mecanica, difiere };
}

interface Hallazgo {
  contra: Parte;
  regla: Regla | null;
  motivo: Motivo;
}

const cruceDerecho = (m: Mecanica) =>
  m.interseccion === true &&
  m.maniobra_asegurado === "avanzaba_recto" &&
  m.maniobra_tercero === "avanzaba_recto" &&
  m.semaforo_asegurado === "sin_semaforo" &&
  m.semaforo_tercero === "sin_semaforo" &&
  m.venia_por_la_derecha !== null;

function hallazgos(m: Mecanica): Hallazgo[] {
  const salida: Hallazgo[] = [];

  // Art. 44: un semáforo en rojo de un lado y luz del otro. Cruzó en rojo el que andaba:
  // uno quieto frente al rojo, o del que no se sabe la maniobra, no lo cruzó.
  const { semaforo_asegurado: sa, semaforo_tercero: st } = m;
  if (sa && st && CON_LUZ.has(sa) && CON_LUZ.has(st) && (sa === "rojo") !== (st === "rojo")) {
    const contra = sa === "rojo" ? "asegurado" : "tercero";
    const maniobra = m[`maniobra_${contra}`];
    if (maniobra && EN_MARCHA.has(maniobra)) {
      salida.push({ contra, regla: "ley24449_art44", motivo: { clave: "semaforo_rojo", params: { parte: contra } } });
    }
  }

  // Art. 48 inc. g: quien le pega desde atrás no guardó la distancia prudente.
  if (m.embistio_de_atras) {
    salida.push({
      contra: m.embistio_de_atras,
      regla: "ley24449_art48g",
      motivo: { clave: "alcance", params: { parte: m.embistio_de_atras } },
    });
  }

  // Art. 41: en un cruce sin semáforo y sin excepciones, pasa el que viene por la derecha.
  if (cruceDerecho(m) && m.excepcion_prioridad === false) {
    const contra = m.venia_por_la_derecha ? "tercero" : "asegurado";
    salida.push({ contra, regla: "ley24449_art41", motivo: { clave: "prioridad_derecha", params: { parte: contra } } });
  }

  // Un vehículo quieto y el otro en marcha: responde el que andaba. No hay artículo verificado que citar.
  const { maniobra_asegurado: ma, maniobra_tercero: mt } = m;
  if (ma && mt && QUIETO.has(ma) !== QUIETO.has(mt) && [ma, mt].every((x) => QUIETO.has(x) || EN_MARCHA.has(x))) {
    const contra = QUIETO.has(ma) ? "tercero" : "asegurado";
    salida.push({ contra, regla: null, motivo: { clave: "detenido", params: { parte: contra } } });
  }
  return salida;
}

function faltantesDe(m: Mecanica, hayDocumentos: boolean): string[] {
  const f: string[] = [];
  if (m.maniobra_asegurado === null) f.push("maniobra_asegurado");
  if (m.maniobra_tercero === null) f.push("maniobra_tercero");
  if (!(m.semaforo_asegurado === "sin_semaforo" && m.semaforo_tercero === "sin_semaforo")) {
    for (const p of ["asegurado", "tercero"] as const) {
      const s = m[`semaforo_${p}`];
      if (s === null || s === "no_dice") f.push(`semaforo_${p}`);
    }
  }
  if (m.interseccion === null) f.push("interseccion");
  if (m.interseccion !== false && m.venia_por_la_derecha === null) f.push("quien_venia_por_la_derecha");
  if (m.interseccion === true && m.excepcion_prioridad !== false) f.push("excepcion_prioridad");
  if (m.embistio_de_atras === null && m.interseccion !== true) f.push("embistio_de_atras");
  if (!hayDocumentos) f.push("parte_o_denuncia");
  return f;
}

/**
 * La opinión con lo que cuentan el relato y los documentos (parte amistoso,
 * denuncia). Con dos reglas que apuntan a partes distintas, es compartida.
 */
export function opinarResponsabilidad(relato: Mecanica | null, documentos: Mecanica[]): Responsabilidad {
  const { mecanica, difiere } = combinar(relato, documentos);
  const encontrados = hallazgos(mecanica);
  const partes = new Set(encontrados.map((h) => h.contra));

  if (partes.size === 1) {
    const [primero] = encontrados;
    return { v: 1, responsable: primero!.contra, regla: primero!.regla, motivo: primero!.motivo, faltantes: [], difiere };
  }
  if (partes.size > 1) {
    const reglas = encontrados.map((h) => h.regla).filter((r): r is Regla => r !== null);
    return {
      v: 1,
      responsable: "compartida",
      regla: null,
      motivo: { clave: "compartida", params: { reglas: reglas.join(",") } },
      faltantes: [],
      difiere,
    };
  }
  // La excepción a la prioridad de paso no se decide con estos datos: queda para la persona.
  const conExcepcion = cruceDerecho(mecanica) && mecanica.excepcion_prioridad === true;
  return {
    v: 1,
    responsable: "no_determinable",
    regla: null,
    motivo: { clave: conExcepcion ? "excepcion_prioridad" : "sin_regla", params: {} },
    faltantes: faltantesDe(mecanica, documentos.length > 0),
    difiere,
  };
}

/** Los tipos de siniestro que son un choque: el asegurado que responde ante un tercero (`rc`) también lo es. */
const TIPOS_DE_CHOQUE = new Set(["choque", "rc"]);
export const esChoque = (tipo: string | null | undefined): boolean => !!tipo && TIPOS_DE_CHOQUE.has(tipo);

/**
 * Lo que hay que escribir en `cases.responsabilidad`: la opinión, `null` para
 * borrar una vieja cuando el caso ya no es un choque, o `undefined` si no hay
 * nada que escribir (ninguna fuente dice algo de la mecánica).
 */
export function responsabilidadDelCaso(
  tipo: string | null | undefined,
  relato: Mecanica | null | undefined,
  documentos: Array<Mecanica | null | undefined>
): Responsabilidad | null | undefined {
  if (!esChoque(tipo)) return null;
  const delRelato = tieneMecanica(relato) ? relato : null;
  const conDatos = documentos.filter(tieneMecanica);
  if (!delRelato && conDatos.length === 0) return undefined;
  return opinarResponsabilidad(delRelato, conDatos);
}
