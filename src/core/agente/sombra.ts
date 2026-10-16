/**
 * El modo sombra: qué decidiría el modelo frente a qué decide el código.
 *
 * El código sigue decidiendo. La sombra sólo anota, con lo que el modelo ya
 * devolvió en la vuelta, si coincidirían, y de ahí sale el porcentaje que
 * decide si una decisión puede pasar al modelo (`cumpleElUmbral`).
 *
 * Núcleo puro: sin entorno, base ni red. Lo que guarda es lo único que puede
 * viajar a `agent_runs.confidence_payload`: claves de campo, enums, booleanos
 * y categorías. Nunca texto libre.
 */

import type { QueHacer } from "@/core/case/reply-decision";
import { canonicalFieldKey } from "@/lib/labels/claim-fields";
import type { DecisionDeSombra } from "./entrenamiento-base";

export type Gravedad = "low" | "medium" | "high" | "critical";

export type Respuesta =
  | "pedir"
  | "contestar"
  | "cerrar"
  | "acusar"
  | "avisar"
  | "callar"
  | "derivar"
  | "sin_derivar";

/** Lo que decidiría el agente y lo que decidió el código; `null` es «sin opinión». */
export interface Opinion<T> {
  agente: T | null;
  codigo: T | null;
}

export interface SombraDeLaVuelta {
  v: 1;
  gravedad?: Opinion<Gravedad>;
  /** `piso`: heridos o gravedad crítica, lo que el código nunca suelta. */
  derivar?: Opinion<boolean> & { piso: boolean };
  /** `descartadas`: cuántas claves del agente quedaron fuera de lo pendiente. */
  pedir?: Opinion<string[]> & { descartadas: number };
  /** `rechazo`: la categoría por la que `validate` tiró el plan, si lo tiró. */
  responder?: Opinion<Respuesta> & { rechazo: string | null };
}

/** Lo que el orquestador anota después de la extracción. */
export type ParteDeSombra = Partial<Pick<SombraDeLaVuelta, "pedir" | "responder">>;

export const UMBRAL_DE_COINCIDENCIA = 0.95;
export const MINIMO_DE_COMPARACIONES = 100;

const DECISIONES: readonly DecisionDeSombra[] = ["gravedad", "derivar", "pedir", "responder"];
const GRAVEDADES: readonly string[] = ["low", "medium", "high", "critical"];
const CLAVE_SEGURA = /^[a-z0-9_]{1,40}$/;
const MAXIMO_DE_CLAVES = 10;

/** Sólo claves con forma de campo: un nombre o un DNI que se colara no se guarda. */
export function clavesSeguras(claves: readonly unknown[]): string[] {
  const seguras = claves.filter((c): c is string => typeof c === "string" && CLAVE_SEGURA.test(c));
  return [...new Set(seguras)].slice(0, MAXIMO_DE_CLAVES);
}

/** Las claves a la forma canónica, seguras y ordenadas, para comparar listas como conjuntos. */
export function normalizarFaltantes(claves: readonly unknown[]): string[] {
  const canonicas = claves.map((c) => (typeof c === "string" ? canonicalFieldKey(c) : c));
  return clavesSeguras(canonicas).sort();
}

export function gravedadSegura(v: unknown): Gravedad | null {
  return typeof v === "string" && GRAVEDADES.includes(v) ? (v as Gravedad) : null;
}

/**
 * Gravedad y derivación de la vuelta de extracción.
 *
 * `modelo` es lo crudo que devolvió el modelo, antes de que el código lo toque.
 */
export function sombraDeLaExtraccion(
  modelo: { severity: unknown; requires_specialist: unknown },
  codigo: { gravedad: unknown; deriva: boolean; piso: boolean }
): SombraDeLaVuelta {
  return {
    v: 1,
    gravedad: { agente: gravedadSegura(modelo.severity), codigo: gravedadSegura(codigo.gravedad) },
    derivar: {
      agente: typeof modelo.requires_specialist === "boolean" ? modelo.requires_specialist : null,
      codigo: codigo.deriva,
      piso: codigo.piso,
    },
  };
}

/** La intención del agente en el vocabulario de la sombra; lo que no conocemos, `null`. */
export function respuestaDelAgente(intent: string | null | undefined): Respuesta | null {
  switch (intent) {
    case "ask":
    case "answer_and_ask":
      return "pedir";
    case "answer":
      return "contestar";
    case "acknowledge":
      return "cerrar";
    case "escalate":
      return "derivar";
    case "wait":
      return "callar";
    default:
      return null;
  }
}

/**
 * Lo que decidió el código, en el mismo vocabulario.
 *
 * `callar` se reparte porque el agente distingue tres silencios que el árbol
 * junta. Aproximación documentada: no mira `checkConfirmationAlreadySent`.
 */
export function respuestaDelCodigo(
  q: QueHacer,
  s: { enEspera: boolean; nosPreguntoAlgo: boolean }
): Respuesta {
  switch (q) {
    case "pedir":
      return "pedir";
    case "acusar-recibo":
      return "acusar";
    case "avisar-que-no-entro":
      return "avisar";
    case "callar":
      if (s.enEspera) return "callar";
      return s.nosPreguntoAlgo ? "contestar" : "cerrar";
  }
}

function mismoConjunto(a: readonly string[], b: readonly string[]): boolean {
  const conjuntoA = new Set(a);
  const conjuntoB = new Set(b);
  return conjuntoA.size === conjuntoB.size && [...conjuntoA].every((x) => conjuntoB.has(x));
}

/**
 * ¿Coinciden el agente y el código en esta decisión? `null` si no se puede comparar:
 * falta una opinión, o el código dice `avisar`, que el agente no tiene.
 */
export function coincide(s: SombraDeLaVuelta, d: DecisionDeSombra): boolean | null {
  if (d === "pedir") {
    const o = s.pedir;
    if (!o || o.agente === null || o.codigo === null) return null;
    return mismoConjunto(o.agente, o.codigo);
  }
  const o = s[d];
  if (!o || o.agente === null || o.codigo === null) return null;
  if (d === "responder" && o.codigo === "avisar") return null;
  return o.agente === o.codigo;
}

/** El agente soltaría lo que el código nunca suelta. Una diferencia de gravedad sola no cuenta. */
export function bajaElPiso(s: SombraDeLaVuelta): boolean {
  return s.derivar?.piso === true && s.derivar.agente === false;
}

function mostrar(v: boolean | string | readonly string[]): string {
  if (typeof v === "boolean") return v ? "sí" : "no";
  if (typeof v === "string") return v;
  return v.length > 0 ? v.join(", ") : "—";
}

function tramo(
  nombre: DecisionDeSombra,
  o: Opinion<boolean | string | string[]>,
  igual: boolean | null
): string {
  if (igual === null || o.agente === null || o.codigo === null) return `${nombre} ?`;
  if (igual) return `${nombre} =`;
  return `${nombre} ≠ (agente: ${mostrar(o.agente)} · código: ${mostrar(o.codigo)})`;
}

/** Una línea para el ensayo: qué decisiones coinciden, cuáles no, y si la vuelta baja el piso. */
export function lineaDeSombra(s: SombraDeLaVuelta): string {
  const tramos: string[] = [];
  for (const d of DECISIONES) {
    const o = s[d];
    if (!o) continue;
    let linea = tramo(d, o, coincide(s, d));
    if (d === "responder" && s.responder?.rechazo) linea += ` [rechazo: ${s.responder.rechazo}]`;
    tramos.push(linea);
  }
  if (bajaElPiso(s)) tramos.push("BAJA EL PISO");
  return tramos.join(" · ");
}

export interface ConteoDeSombra {
  vueltas: number;
  bajaElPiso: number;
  porDecision: Record<DecisionDeSombra, { iguales: number; distintas: number; sinOpinion: number }>;
}

export function conteoVacio(): ConteoDeSombra {
  const cero = () => ({ iguales: 0, distintas: 0, sinOpinion: 0 });
  return {
    vueltas: 0,
    bajaElPiso: 0,
    porDecision: { gravedad: cero(), derivar: cero(), pedir: cero(), responder: cero() },
  };
}

/**
 * Suma una vuelta al conteo y devuelve uno nuevo. Cada decisión suma una sola vez
 * por vuelta: la que no se anotó cuenta como sin opinión.
 */
export function sumarSombra(c: ConteoDeSombra, s: SombraDeLaVuelta): ConteoDeSombra {
  const porDecision = { ...c.porDecision };
  for (const d of DECISIONES) {
    const igual = coincide(s, d);
    const antes = c.porDecision[d];
    porDecision[d] =
      igual === null
        ? { ...antes, sinOpinion: antes.sinOpinion + 1 }
        : igual
          ? { ...antes, iguales: antes.iguales + 1 }
          : { ...antes, distintas: antes.distintas + 1 };
  }
  return {
    vueltas: c.vueltas + 1,
    bajaElPiso: c.bajaElPiso + (bajaElPiso(s) ? 1 : 0),
    porDecision,
  };
}

/** El resumen del ensayo y de la evaluación: coincidencia por decisión, sin opinión y piso. */
export function resumenDeSombra(c: ConteoDeSombra): string {
  const porDecision = DECISIONES.map((d) => {
    const { iguales, distintas } = c.porDecision[d];
    const total = iguales + distintas;
    const porcentaje = total === 0 ? "—" : String(Math.round((iguales / total) * 100));
    return `${d} ${iguales}/${total} (${porcentaje} %)`;
  });
  const sinOpinion = DECISIONES.reduce((n, d) => n + c.porDecision[d].sinOpinion, 0);
  return [
    "Sombra (no cuenta para el resultado): " + porDecision.join(" · "),
    `sin opinión: ${sinOpinion}`,
    `baja el piso: ${c.bajaElPiso}`,
    `umbral ${Math.round(UMBRAL_DE_COINCIDENCIA * 100)} % con ${MINIMO_DE_COMPARACIONES} comparaciones`,
  ].join(" · ");
}

/** ¿Esta decisión alcanza el umbral para ser candidata a pasar al modelo? */
export function cumpleElUmbral(c: ConteoDeSombra, d: DecisionDeSombra): boolean {
  const { iguales, distintas } = c.porDecision[d];
  const total = iguales + distintas;
  return (
    total >= MINIMO_DE_COMPARACIONES &&
    iguales / total >= UMBRAL_DE_COINCIDENCIA &&
    c.bajaElPiso === 0
  );
}
