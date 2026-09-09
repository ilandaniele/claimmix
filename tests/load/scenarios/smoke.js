/**
 * Smoke — ¿está todo enchufado?
 *
 * Un VU, treinta segundos. No mide rendimiento y no pretende: mide que las seis
 * rutas contesten 200 con una sesión de verdad. Es el que corre en cada PR,
 * porque lo que rompe una prueba de carga casi nunca es la carga: es una ruta
 * que se renombró, un login que cambió de forma, un filtro que ahora pide otro
 * parámetro.
 *
 * Con el umbral de fallos en cero: acá un solo 4xx ya es la respuesta.
 */

import http from "k6/http";
import { check, sleep } from "k6";

import {
  BASE_URL,
  PERCENTILES,
  PRESUPUESTO_P95_MS,
  RUTAS,
  umbralesComunes,
} from "../config/base.js";
import { comoAnalista, esRechazoDeCupo, iniciarSesiones } from "../helpers/auth.js";
import { guardar } from "../helpers/reporte.js";

export const options = {
  vus: 1,
  // k6 sigue redirecciones y cuenta 200-399 como éxito. Sin esto, una API
  // que pasara a redirigir a /login se mediría como sana.
  maxRedirects: 0,
  duration: "30s",
  summaryTrendStats: PERCENTILES,
  thresholds: {
    // Cero, no 1%: con un VU y seis rutas, un fallo es una ruta rota.
    ...umbralesComunes(),
    http_req_failed: ["rate==0"],
    "http_req_duration{escenario:lectura}": [`p(95)<${PRESUPUESTO_P95_MS * 2}`],
  },
};

export function setup() {
  return iniciarSesiones(1, 0);
}

export default function (sesion) {
  for (const [nombre, ruta] of Object.entries(RUTAS)) {
    const res = http.get(`${BASE_URL}${ruta}`, comoAnalista(sesion));
    esRechazoDeCupo(res);
    check(res, {
      [`${nombre} contesta 200`]: (r) => r.status === 200,
      [`${nombre} devuelve JSON`]: (r) =>
        (r.headers["Content-Type"] || "").includes("application/json"),
    });
  }
  sleep(1);
}

export function handleSummary(datos) {
  return guardar(datos, "smoke", {
    "qué mide": "que las seis rutas contesten 200 con sesión — no rendimiento",
    "rutas probadas": Object.keys(RUTAS).join(", "),
  });
}
