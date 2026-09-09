/**
 * Spike — el granizo.
 *
 * Cae una tormenta y en dos minutos toda la mesa abre la bandeja a la vez: de
 * veinte analistas a trescientos, y a los tres minutos vuelve a veinte.
 *
 * Lo que este perfil mide, y ninguno de los otros, es la RECUPERACIÓN. Que
 * durante el pico la latencia se vaya al techo es esperable y no es la
 * pregunta. La pregunta es qué pasa después: si a los treinta segundos de que
 * bajó la ola la aplicación volvió a su latencia normal, aguantó. Si sigue
 * lenta, algo quedó saturado —una cola, un pool, una función congelándose— y
 * eso no se ve en ningún otro escenario.
 *
 * Por eso la medición está partida en tres etiquetas de tiempo, y el umbral
 * sólo aplica a la de después.
 */

import http from "k6/http";
import { check, sleep } from "k6";
import { Counter, Trend } from "k6/metrics";

import {
  BASE_URL,
  PERCENTILES,
  PRESUPUESTO_P95_MS,
  RUTAS,
  cabecerasDeVercel,
  exigirDestinoSeguro,
} from "../config/base.js";
import { comoAnalista, esRechazoDeCupo, iniciarSesiones } from "../helpers/auth.js";
import { guardar } from "../helpers/reporte.js";

exigirDestinoSeguro("spike");

const antes = new Trend("spike_antes_ms", true);
/** Cuántas muestras cayó en cada fase. Ver el umbral, abajo. */
const muestrasAntes = new Counter("spike_muestras_antes");
const muestrasDespues = new Counter("spike_muestras_despues");
const durante = new Trend("spike_durante_ms", true);
const despues = new Trend("spike_despues_ms", true);

/*
 * Los tramos, en segundos, y de acá salen DOS cosas: los escalones de k6 y los
 * límites de las tres fases.
 *
 * Estaban por duplicado —los escalones acá, los cortes 60 y 210 escritos a mano
 * más abajo— y con eso basta con pisar los escalones desde la línea de comandos
 * para que la fase «después» no se llene nunca. El umbral que la mira pasaría
 * igual: en k6, un umbral sobre una métrica sin muestras no falla.
 */
const BASE_S = Number(__ENV.SPIKE_BASE_S || 60);
const SUBIDA_S = 30;
const OLA_S = Number(__ENV.SPIKE_OLA_S || 120);
const BAJADA_S = 30;
const VUELTA_S = Number(__ENV.SPIKE_VUELTA_S || 180);

/** Cuándo termina el «antes» y cuándo empieza el «después», en segundos. */
const FIN_ANTES_S = BASE_S;
const FIN_DURANTE_S = BASE_S + SUBIDA_S + OLA_S + BAJADA_S;

export const options = {
  stages: [
    { duration: `${BASE_S}s`, target: 20 },    // línea de base
    { duration: `${SUBIDA_S}s`, target: 300 }, // la ola
    { duration: `${OLA_S}s`, target: 300 },
    { duration: `${BAJADA_S}s`, target: 20 },  // se va
    { duration: `${VUELTA_S}s`, target: 20 },  // ¿volvió?
  ],
  summaryTrendStats: PERCENTILES,
  thresholds: {
    /*
     * El umbral va sobre el DESPUÉS, no sobre el total.
     *
     * Sobre el total, el pico —que es lo que este perfil fue a provocar— tira
     * el p95 y la corrida sale roja siempre, midiendo lo esperado en vez de lo
     * que se pregunta.
     */
    /*
     * `min>0` además del p95: en k6 un umbral sobre una métrica SIN MUESTRAS
     * pasa —un Trend vacío da p(95)=0— así que una fase que nunca se llenó
     * salía verde. Con muestras la latencia siempre es mayor que cero.
     */
    /*
     * Un contador aparte, y no `min>0` sobre el Trend.
     *
     * En k6, un umbral sobre una métrica SIN MUESTRAS pasa: un Trend vacío da
     * p(95)=0 y nadie se queja. Así que una fase que nunca se llenó salía
     * verde, que es el peor de los verdes.
     *
     * `min>0` parecía la guarda barata y no lo es: contra un servidor local
     * una respuesta puede tardar menos de un milisegundo, `min` da 0, y el
     * umbral rompe con las fases perfectamente llenas. Lo comprobé.
     *
     * Un contador no tiene esa ambigüedad: o hubo muestras o no hubo.
     */
    spike_despues_ms: [`p(95)<${PRESUPUESTO_P95_MS}`],
    spike_muestras_antes: ["count>0"],
    spike_muestras_despues: ["count>0"],
    // Durante el pico se admite perder pedidos; después, no.
    "http_req_failed{fase:despues}": ["rate<0.01"],
  },
};

export function setup() {
  return { ...iniciarSesiones(300, 30), arranque: Date.now() };
}

/** En qué momento de la ola estamos, por reloj de la corrida. */
function fase(sesion) {
  const s = (Date.now() - sesion.arranque) / 1000;
  if (s < FIN_ANTES_S) return "antes";
  if (s < FIN_DURANTE_S) return "durante";
  return "despues";
}

export default function (sesion) {
  const enQue = fase(sesion);
  const res = http.get(
    `${BASE_URL}${RUTAS.bandeja}`,
    comoAnalista(sesion, "lectura", { fase: enQue })
  );
  esRechazoDeCupo(res);
  check(res, { "200": (r) => r.status === 200 });

  const d = res.timings.duration;
  if (enQue === "antes") {
    antes.add(d);
    muestrasAntes.add(1);
  } else if (enQue === "durante") {
    durante.add(d);
  } else {
    despues.add(d);
    muestrasDespues.add(1);
  }

  // Corta, pero pausa: trescientas personas abriendo la bandeja refrescan cada
  // par de segundos, no martillan. Sin esto se mide un ataque, no una tormenta.
  sleep(2);
}

export function handleSummary(datos) {
  const a = datos.metrics.spike_antes_ms;
  const d = datos.metrics.spike_despues_ms;
  const base = a ? a.values["p(95)"] : null;
  const vuelta = d ? d.values["p(95)"] : null;
  /*
   * Sin las dos fases no hay respuesta, y decirlo importa: «—» al lado de
   * umbrales en verde se lee como que recuperó.
   */
  const recupero = !(base && vuelta)
    ? "NO SE MIDIÓ — alguna fase quedó sin muestras; los escalones no coinciden con las constantes de arriba"
    : vuelta <= base * 1.5
      ? "sí"
      : "NO — quedó lenta después de que bajó la ola";

  return guardar(datos, "spike", {
    "qué mide": "la recuperación después de la ola, no el pico",
    // Los VUs de la corrida, no los del archivo: k6 deja pisarlos con `--stage`.
    "ola": `hasta ${datos.metrics.vus_max ? datos.metrics.vus_max.values.max : "?"} VUs en ${SUBIDA_S} s, ${OLA_S} s arriba, y de vuelta`,
    "p95 antes": base ? `${Math.round(base)} ms` : "sin muestras",
    "p95 durante": datos.metrics.spike_durante_ms
      ? `${Math.round(datos.metrics.spike_durante_ms.values["p(95)"])} ms`
      : "sin muestras",
    "p95 después": vuelta ? `${Math.round(vuelta)} ms` : "sin muestras",
    "recuperó": recupero,
  });
}
