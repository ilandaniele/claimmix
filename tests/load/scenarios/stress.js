/**
 * Stress — ¿dónde se rompe?
 *
 * Sube de 50 a 200 analistas en escalones y NO pretende pasar. Un perfil de
 * estrés que sale verde no midió nada: si aguantó doscientos, el techo está más
 * arriba y no sabemos dónde.
 *
 * Lo que este perfil mide, y ninguno de los otros mide, es el PUNTO DE QUIEBRE:
 * en qué escalón la latencia se sale del presupuesto y en cuál empiezan los
 * errores. Cada escalón tiene sus propias métricas (`stress_ms_<vus>` y
 * `stress_fallos_<vus>`) y el reporte arma la tabla con ellas. Los escalones son
 * de verdad: una subida corta y una meseta, así cada muestra pertenece a un
 * nivel de carga y no a un punto de una rampa.
 *
 * Por eso el umbral de latencia acá está flojo a propósito —dos segundos, no
 * quinientos— y el que corta es el de errores. Un p95 de 900 ms con 200 VUs es
 * un dato, no una falla; un 5% de pedidos caídos sí es una falla.
 *
 * ── El cupo manda sobre la presión ─────────────────────────────────────────
 *
 * Cada cuenta aguanta 100 pedidos por minuto contra `/api/cases`. Doscientos VUs
 * sin pausa pedirían ~120 000 por minuto: 1200 cuentas, y el login deja entrar
 * 25 por minuto. Y con menos cuentas los 429 se medirían como si fueran la
 * capacidad. Así que los VUs hacen una pausa (la del sondeo de la bandeja, 5 s:
 * 24 cuentas para 200 VUs) y `iniciarSesiones` corta la corrida si no alcanzan.
 * `STRESS_PAUSA_S` la baja para apretar más; pide más cuentas, y por eso un
 * `setupTimeout` largo.
 *
 * Los 429 no entran en la tabla de escalones (no dicen nada de la capacidad) y
 * `rechazados_por_cupo` tiene umbral: una corrida que se comió el cupo sale roja.
 */

import http from "k6/http";
import { check, sleep } from "k6";
import { Rate, Trend } from "k6/metrics";
import exec from "k6/execution";

import {
  BASE_URL,
  PAUSA_S,
  PERCENTILES,
  PRESUPUESTO_P95_MS,
  RUTAS,
  cupoSinRechazos,
  exigirDestinoSeguro,
  selectorDeLectura,
} from "../config/base.js";
import { comoAnalista, esRechazoDeCupo, iniciarSesiones } from "../helpers/auth.js";
import { guardar } from "../helpers/reporte.js";

exigirDestinoSeguro("stress");

const PAUSA_STRESS_S = Number(__ENV.STRESS_PAUSA_S || PAUSA_S);
const VUS_PICO = 200;

/** Los escalones: una subida corta y una meseta de `minutos` en cada uno. */
const SUBIDA_S = 30;
const TRAMOS = [
  { vus: 50, minutos: 3 },
  { vus: 100, minutos: 3 },
  { vus: 150, minutos: 3 },
  { vus: VUS_PICO, minutos: 5 },
];
const BAJADA_MIN = 3;

/** Cuándo termina la presión: lo que viene después es la bajada y no se mide. */
const FIN_PRESION_S = TRAMOS.reduce((s, t) => s + SUBIDA_S + t.minutos * 60, 0);

/** Latencia de los pedidos que contestaron 200, y fallos, de cada escalón. */
const msPorNivel = Object.fromEntries(
  TRAMOS.map(({ vus }) => [vus, new Trend(`stress_ms_${vus}`, true)])
);
const fallosPorNivel = Object.fromEntries(
  TRAMOS.map(({ vus }) => [vus, new Rate(`stress_fallos_${vus}`)])
);

const LECTURA = selectorDeLectura();

export const options = {
  stages: [
    ...TRAMOS.flatMap(({ vus, minutos }) => [
      { duration: `${SUBIDA_S}s`, target: vus },
      { duration: `${minutos}m`, target: vus },
    ]),
    { duration: `${BAJADA_MIN}m`, target: 0 },
  ],
  summaryTrendStats: PERCENTILES,
  maxRedirects: 0,
  // El login va de a 25 por minuto: con muchas cuentas el setup tarda minutos.
  setupTimeout: "10m",
  thresholds: {
    // Lo que corta es que se caigan pedidos, no que tarden.
    [`http_req_failed{${LECTURA}}`]: ["rate<0.05"],
    // Flojo A PROPÓSITO: acá tardar es el dato que se fue a buscar.
    [`http_req_duration{${LECTURA}}`]: ["p(95)<2000"],
    [`http_reqs{${LECTURA}}`]: ["count>0"],
    // Tolera fallos en el pico, pero no que el grueso de los checks falle.
    checks: ["rate>0.95"],
    ...cupoSinRechazos(),
  },
};

export function setup() {
  return iniciarSesiones(VUS_PICO, 60 / PAUSA_STRESS_S);
}

export default function (sesion) {
  const res = http.get(`${BASE_URL}${RUTAS.bandeja}`, comoAnalista(sesion));
  const rechazado = esRechazoDeCupo(res);
  const ok = check(res, { "200": (r) => r.status === 200 });

  /*
   * El escalón es la cantidad de VUs activos AHORA: en la meseta es exactamente
   * el de `TRAMOS`, y en la subida no coincide con ninguno, así que esas
   * muestras no cuentan. La bajada pasa de nuevo por 150, 100 y 50; el reloj la
   * deja afuera.
   */
  const nivel = exec.instance.vusActive;
  const enPresion = Date.now() - exec.scenario.startTime <= FIN_PRESION_S * 1000;
  if (!rechazado && enPresion && fallosPorNivel[nivel]) {
    fallosPorNivel[nivel].add(!ok);
    if (ok) msPorNivel[nivel].add(res.timings.duration);
  }

  sleep(PAUSA_STRESS_S);
}

/** Un escalón es sano si entra en el presupuesto y casi no pierde pedidos. */
const ERRORES_SANOS = 0.01;

function escalon(datos, vus) {
  const ms = datos.metrics[`stress_ms_${vus}`];
  const fallos = datos.metrics[`stress_fallos_${vus}`];
  const pedidos = fallos ? fallos.values.passes + fallos.values.fails : 0;
  const p95 = ms && ms.values["p(95)"] != null ? Math.round(ms.values["p(95)"]) : null;
  const errores = pedidos > 0 ? fallos.values.rate : null;
  return {
    vus,
    pedidos,
    p95,
    errores,
    // Sin muestras no se sabe; con todos los pedidos caídos tampoco hay p95 y no es sano.
    medido: pedidos > 0,
    sano: pedidos > 0 && p95 !== null && p95 <= PRESUPUESTO_P95_MS && errores < ERRORES_SANOS,
  };
}

export function handleSummary(datos) {
  const escalones = TRAMOS.map(({ vus }) => escalon(datos, vus));
  /*
   * El quiebre es el PRIMER escalón medido que no es sano, en orden de carga.
   * Antes salía de dos gauges con una sola muestra cada uno, y el último
   * pedido lento de cualquier escalón movía el «último sano».
   */
  const quiebre = escalones.find((e) => e.medido && !e.sano);
  const sanos = escalones.filter((e) => e.sano && (!quiebre || e.vus < quiebre.vus));
  const ultimoMedido = escalones.filter((e) => e.medido).pop();
  /*
   * El techo se lee de la corrida, no del archivo.
   *
   * k6 deja pisar los escalones desde la línea de comandos con `--stage`: el
   * reporte no puede afirmar un perfil que quizás no fue el que corrió.
   */
  const techo = datos.metrics.vus_max ? datos.metrics.vus_max.values.max : null;

  const porEscalon = Object.fromEntries(
    escalones.map((e) => [
      `${e.vus} VUs`,
      e.medido
        ? `p95 ${e.p95 ?? "—"} ms · ${(e.errores * 100).toFixed(1)}% fallidos · ${e.pedidos} pedidos · ${e.sano ? "sano" : "NO sano"}`
        : "sin muestras",
    ])
  );

  return guardar(datos, "stress", {
    "qué mide":
      "el punto de quiebre — en qué escalón se sale del presupuesto o empiezan los errores",
    "VUs máximos de esta corrida": techo ?? "—",
    ...porEscalon,
    "último escalón sano": sanos.length ? `${sanos[sanos.length - 1].vus} VUs` : "ninguno",
    "primer quiebre": quiebre
      ? `${quiebre.vus} VUs`
      : `ninguno: el techo está más arriba de ${ultimoMedido ? ultimoMedido.vus : "lo probado"} VUs`,
    "qué es sano": `p95 ≤ ${PRESUPUESTO_P95_MS} ms y menos de ${ERRORES_SANOS * 100}% de pedidos caídos, sin contar los 429`,
    "por qué el umbral de latencia está flojo": "acá tardar es el dato, no la falla",
  });
}
