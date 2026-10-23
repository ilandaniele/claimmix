/**
 * Peak — el lunes a la mañana.
 *
 * No es el estrés ni la ola: es el momento más cargado que este producto tiene
 * de verdad, todas las semanas. Los siniestros del fin de semana entraron por
 * WhatsApp y por mail mientras no había nadie, y el lunes a las nueve la mesa
 * entera abre la bandeja con el doble de casos y muchos pidiendo datos.
 *
 * Dos cosas lo distinguen de `load`, y son las dos que fue a medir:
 *
 *   · La carga es tres veces la normal —150 analistas— y sostenida media hora,
 *     no cinco minutos.
 *   · La mezcla es OTRA. El lunes nadie busca por texto ni mira el padrón:
 *     abren la bandeja filtrada por los casos con información faltante (no
 *     hay filtro de «sin leer»), entran a un caso, vuelven. Ese ida y vuelta
 *     es el que tiene que entrar en el presupuesto, y es el que `load` diluye
 *     entre seis rutas.
 *
 * Cada VU abre un caso distinto —se rotan los de la bandeja—: 150 analistas
 * sobre una sola fila medirían una fila caliente en caché.
 *
 * El umbral es el mismo presupuesto de siempre: un pico conocido y recurrente
 * no es una excusa para que el tablero se sienta lento. Si acá no entra, la
 * capacidad no alcanza — que es la pregunta que este perfil contesta.
 */

import http from "k6/http";
import { check, fail, sleep } from "k6";
import { Trend } from "k6/metrics";

import {
  BASE_URL,
  PERCENTILES,
  PRESUPUESTO_P95_MS,
  RUTAS,
  RUTAS_DE_CASO,
  exigirDestinoSeguro,
  umbrales,
} from "../config/base.js";
import { comoAnalista, esRechazoDeCupo, iniciarSesiones } from "../helpers/auth.js";
import { guardar } from "../helpers/reporte.js";

exigirDestinoSeguro("peak");

/** El ida y vuelta completo: abrir la bandeja filtrada y entrar a un caso. */
const vueltaCompleta = new Trend("peak_bandeja_mas_detalle_ms", true);

export const options = {
  stages: [
    { duration: "3m", target: 150 },
    { duration: "30m", target: 150 },
    { duration: "2m", target: 0 },
  ],
  summaryTrendStats: PERCENTILES,
  // Un 302 al login no se sigue como si fuera la respuesta.
  maxRedirects: 0,
  thresholds: umbrales({
    // Lo propio de este perfil: el ida y vuelta que hace el analista el lunes.
    peak_bandeja_mas_detalle_ms: [`p(95)<${PRESUPUESTO_P95_MS * 2}`],
  }),
};

export function setup() {
  // 15 vueltas por minuto y VU: la bandeja, el detalle y los mensajes tienen cada uno su balde.
  const sesion = iniciarSesiones(150, 60 / 4);

  /*
   * Un caso de verdad para abrir, tomado de la bandeja.
   *
   * Inventar un UUID mediría el 404, que es la ruta rápida: no toca los
   * mensajes, ni los campos extraídos, ni los documentos. Un perfil que mide
   * 404s dice que todo anda bárbaro.
   */
  const res = http.get(`${BASE_URL}${RUTAS.bandeja}`, comoAnalista(sesion));
  /*
   * Sin casos, este perfil NO corre.
   *
   * Saltear el detalle y los mensajes en silencio sacaba dos tercios del
   * trabajo: el p95 mejoraba porque se salteaba justo el tramo caro, y el
   * reporte seguía afirmando «bandeja → caso → mensajes». Se dispara con un
   * inquilino sin casos, con el filtro sin filas, o con la bandeja contestando
   * 401/429/500 con cuerpo JSON.
   */
  if (res.status !== 200) {
    fail(`La bandeja contestó ${res.status} en el setup. Sin ella no hay caso que abrir.`);
  }
  const cuerpo = res.json();
  const caseIds = ((cuerpo && cuerpo.data) || []).map((caso) => caso.id);
  if (caseIds.length === 0) {
    fail(
      "La bandeja no devolvió ningún caso. Sin uno, este perfil mide un tercio " +
        "del trabajo y sale verde por haberse salteado lo caro."
    );
  }

  return { ...sesion, caseIds };
}

export default function (sesion) {
  const t0 = Date.now();
  // Cada VU abre un caso distinto por vuelta, no el mismo los 150.
  const caseId = sesion.caseIds[(__VU + __ITER) % sesion.caseIds.length];

  const lista = http.get(`${BASE_URL}${RUTAS.bandejaFiltrada}`, comoAnalista(sesion));
  esRechazoDeCupo(lista);
  check(lista, { "bandeja 200": (r) => r.status === 200 });

  const detalle = http.get(`${BASE_URL}${RUTAS_DE_CASO.detalle(caseId)}`, comoAnalista(sesion));
  esRechazoDeCupo(detalle);
  check(detalle, { "detalle 200": (r) => r.status === 200 });

  const mensajes = http.get(`${BASE_URL}${RUTAS_DE_CASO.mensajes(caseId)}`, comoAnalista(sesion));
  esRechazoDeCupo(mensajes);
  check(mensajes, { "mensajes 200": (r) => r.status === 200 });

  vueltaCompleta.add(Date.now() - t0);
  sleep(4);
}

export function handleSummary(datos) {
  const v = datos.metrics.peak_bandeja_mas_detalle_ms;
  // Los VUs de la corrida, no los del archivo: k6 deja pisarlos con `--stage`.
  const vus = datos.metrics.vus_max ? datos.metrics.vus_max.values.max : "?";
  return guardar(datos, "peak", {
    "qué mide": "si el pico conocido y recurrente entra en el presupuesto",
    "modelo": `lunes a las nueve: ${vus} analistas, bandeja con info faltante → caso → mensajes`,
    "p95 del ida y vuelta": v ? `${Math.round(v.values["p(95)"])} ms` : "—",
    "en qué se diferencia de load": "3× la carga, sostenida 30 min, y otra mezcla de rutas",
  });
}
