/**
 * Público — la mitad que contesta sin base de datos.
 *
 * Un VU, treinta segundos, sin login y sin sesión: pide las cuatro páginas que
 * el middleware sirve sin leer la sesión (`RUTAS_PUBLICAS`). Está para que un
 * destino sin `DATABASE_URL` —una vista previa recién levantada, por ejemplo—
 * deje números en vez de nada: los otros escenarios empiezan por el login, y
 * sin base de datos se van en un `fail()` antes del primer pedido medido.
 *
 * Lo que este perfil NO dice: nada de lo que vive detrás de la sesión. Verde
 * acá es la mitad pública contestando y sólo eso — la bandeja, los KPI y el
 * resto de la API pueden estar caídos enteros y esta corrida ni se entera.
 */

import http from "k6/http";
import { check, sleep } from "k6";

import {
  BASE_URL,
  comoVisitante,
  PERCENTILES,
  RUTAS_PUBLICAS,
} from "../config/base.js";
import { guardar } from "../helpers/reporte.js";

export const options = {
  vus: 1,
  // k6 sigue redirecciones y cuenta 200-399 como éxito. Sin esto, una página
  // que pasara a redirigir a /login se mediría como sana.
  maxRedirects: 0,
  duration: "30s",
  summaryTrendStats: PERCENTILES,
  // Mil milisegundos es lo que puede tardar una página armada en el servidor.
  // NO es el presupuesto de Carga: los 500 ms de `PRESUPUESTO_P95_MS` son para
  // las lecturas de la API del tablero, y de ahí no se mueven.
  thresholds: {
    http_req_failed: ["rate==0"],
    // `checks` a mano y no `umbralesComunes()`: ese trae también
    // `rechazados_por_cupo`, un contador que sólo existe si se importa
    // `helpers/auth.js` — y acá no hay sesión que importar.
    checks: ["rate==1.00"],
    "http_req_duration{escenario:publico}": ["p(95)<1000"],
  },
};

export default function () {
  for (const ruta of RUTAS_PUBLICAS) {
    const res = http.get(`${BASE_URL}${ruta}`, comoVisitante());
    check(res, {
      [`${ruta} contesta 200`]: (r) => r.status === 200,
      // Son páginas: si vuelve JSON, lo que contestó fue un error de la API.
      [`${ruta} devuelve HTML`]: (r) =>
        (r.headers["Content-Type"] || "").includes("text/html"),
    });
  }
  sleep(1);
}

export function handleSummary(datos) {
  return guardar(datos, "publico", {
    "qué mide": "que las cuatro páginas públicas contesten sin base de datos",
    "qué no mide": "esta corrida no midió nada que esté detrás de una sesión",
    "rutas probadas": RUTAS_PUBLICAS.join(", "),
  });
}
