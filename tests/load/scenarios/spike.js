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
 * Por eso la medición está partida en tres etiquetas de tiempo (`fase:antes`,
 * `durante` y `despues`): el umbral de latencia y de pedidos caídos sólo aplica
 * a la de después, y los `check()` llevan la misma etiqueta para exigir 200 en
 * el antes y el después, pero no durante el pico.
 *
 * Los 429 no se toleran en ninguna fase: `rechazados_por_cupo` tiene umbral. La
 * ola pide lo que dan las cuentas —las que haga falta, `iniciarSesiones` corta
 * la corrida si no alcanzan— con la misma pausa que el sondeo de la bandeja.
 */

import http from "k6/http";
import { check, sleep } from "k6";
import { Counter, Trend } from "k6/metrics";

import {
  BASE_URL,
  CHECKS_SIN_FALLAS,
  PAUSA_S,
  PERCENTILES,
  RUTAS,
  cupoSinRechazos,
  exigirDestinoSeguro,
  selectorDeLectura,
  umbralesDeLectura,
} from "../config/base.js";
import { comoAnalista, esRechazoDeCupo, iniciarSesiones } from "../helpers/auth.js";
import { guardar } from "../helpers/reporte.js";

exigirDestinoSeguro("spike");

const antes = new Trend("spike_antes_ms", true);
/** Cuántas muestras cayeron en la línea de base. Ver el umbral, abajo. */
const muestrasAntes = new Counter("spike_muestras_antes");
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
  // Un 302 al login no se sigue como si fuera la respuesta.
  maxRedirects: 0,
  // El login va de a 25 por minuto: con decenas de cuentas el setup tarda minutos.
  setupTimeout: "10m",
  thresholds: {
    /*
     * Los umbrales de latencia y de pedidos caídos van sobre el DESPUÉS, no
     * sobre el total.
     *
     * Sobre el total, el pico —que es lo que este perfil fue a provocar— tira
     * el p95 y la corrida sale roja siempre, midiendo lo esperado en vez de lo
     * que se pregunta. Durante el pico se admite perder pedidos; después, no.
     *
     * Incluyen `http_reqs … count>0`, la guarda de que la fase se llenó: en k6
     * un umbral sobre una métrica SIN MUESTRAS pasa —un Trend vacío da
     * p(95)=0— y una fase que nunca se llenó saldría verde, que es el peor de
     * los verdes. Un contador no tiene esa ambigüedad: o hubo muestras o no.
     * (`min>0` no sirve de guarda: contra un servidor local una respuesta puede
     * tardar menos de un milisegundo y `min` da 0 con la fase llena.)
     */
    ...umbralesDeLectura("despues"),
    // Y lo mismo para la línea de base: sin ella no hay con qué comparar.
    spike_muestras_antes: ["count>0"],
    ...cupoSinRechazos(),
    // Los checks se exigen en el antes y el después; durante el pico no.
    "checks{fase:antes}": CHECKS_SIN_FALLAS,
    "checks{fase:despues}": CHECKS_SIN_FALLAS,
  },
};

export function setup() {
  return { ...iniciarSesiones(300, 60 / PAUSA_S), arranque: Date.now() };
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
  check(res, { "200": (r) => r.status === 200 }, { fase: enQue });

  const d = res.timings.duration;
  if (enQue === "antes") {
    antes.add(d);
    muestrasAntes.add(1);
  } else if (enQue === "durante") {
    durante.add(d);
  } else {
    despues.add(d);
  }

  // Pausa como la del sondeo de la bandeja: trescientas personas abriendo la
  // bandeja no martillan. Sin esto se mide un ataque, no una tormenta.
  sleep(PAUSA_S);
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
  }, selectorDeLectura("despues"));
}
