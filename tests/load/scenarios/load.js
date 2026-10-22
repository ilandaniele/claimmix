/**
 * Load — el día normal.
 *
 * Cincuenta VUs es una mesa de siniestros mediana: cincuenta analistas con la
 * bandeja abierta. Cada uno sondea con una pausa de cinco segundos —el piso del
 * intervalo de `useCasesRealtime`, el peor caso— y cada tanto abre otra pantalla.
 *
 * Lo que este perfil mide es UNA cosa: si en el estado estable la latencia entra
 * en el presupuesto. No busca el techo (eso es `stress`), ni la recuperación
 * (eso es `spike`), ni la deriva (eso es `soak`).
 *
 * Nueve minutos: dos de subida, cinco planos, dos de bajada. Los cinco planos
 * son la medición; el resto es llegar y salir. Los pedidos llevan la etiqueta
 * `fase:plano` o `fase:rampa` y los umbrales miran sólo la primera: las rampas
 * tienen pocos usuarios y mezclarlas bajaría el p95.
 */

import http from "k6/http";
import { check, sleep } from "k6";

import { BASE_URL, PAUSA_S, PERCENTILES, RUTAS, selectorDeLectura, umbrales } from "../config/base.js";
import { comoAnalista, esRechazoDeCupo, iniciarSesiones } from "../helpers/auth.js";
import { faseDeLaCarga } from "../helpers/fase.js";
import { guardar } from "../helpers/reporte.js";

const VUS = 50;

export const options = {
  stages: [
    { duration: "2m", target: VUS },
    { duration: "5m", target: VUS },
    { duration: "2m", target: 0 },
  ],
  summaryTrendStats: PERCENTILES,
  thresholds: umbrales({}, "plano"),
};

export function setup() {
  // 50 VUs sondeando cada 5 s son ~600 pedidos/min a `/api/cases`. Si las
  // cuentas que hay no dan ese cupo la corrida se corta: sin eso, esto mide el
  // limitador y el diagnóstico sale al revés.
  return iniciarSesiones(VUS, 60 / PAUSA_S);
}

/**
 * Lo que hace un analista en un rato, en la proporción en que lo hace.
 *
 * La bandeja pesa porque es la que sondea sola; las métricas se miran cada
 * tanto. Una mezcla pareja de las seis rutas mediría un uso que nadie tiene.
 */
export default function (sesion) {
  const dado = Math.random();
  const ruta =
    dado < 0.55 ? RUTAS.bandeja
    : dado < 0.75 ? RUTAS.bandejaFiltrada
    : dado < 0.85 ? RUTAS.busqueda
    : dado < 0.92 ? RUTAS.metricas
    : dado < 0.97 ? RUTAS.clientes
    : RUTAS.polizas;

  const res = http.get(
    `${BASE_URL}${ruta}`,
    comoAnalista(sesion, "lectura", { fase: faseDeLaCarga(VUS) })
  );
  esRechazoDeCupo(res);
  check(res, { "200": (r) => r.status === 200 });

  sleep(PAUSA_S);
}

export function handleSummary(datos) {
  // Los VUs de la corrida, no los del archivo: k6 deja pisarlos con `--stage`.
  const vus = datos.metrics.vus_max ? datos.metrics.vus_max.values.max : "?";
  return guardar(datos, "load", {
    "qué mide": "latencia en estado estable con la carga de un día normal",
    "modelo": `${vus} analistas con la bandeja abierta, sondeando cada ${PAUSA_S} s`,
    "mezcla": "55% bandeja · 20% bandeja filtrada · 10% búsqueda · 7% métricas · 8% padrón",
    "medido sobre": "los cinco minutos planos, sin las rampas",
  }, selectorDeLectura("plano"));
}
