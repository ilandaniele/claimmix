/**
 * Soak — la fuga que sólo se ve con el tiempo.
 *
 * Treinta analistas durante dos horas. Poca carga a propósito: acá no se busca
 * el techo. Se busca lo que empeora SOLO, con el sistema quieto — un pool de
 * conexiones que no devuelve, un caché que crece, un `setInterval` que se
 * duplica en cada recarga.
 *
 * Y por eso el número que importa no es el p95 de toda la corrida, que un
 * problema de deriva no mueve casi: es la DIFERENCIA entre el principio y el
 * final. Una aplicación que arranca en 200 ms y termina en 400 tiene un p95
 * total perfectamente presentable y una fuga.
 *
 * Las dos ventanas se miden aparte y el umbral compara una contra otra. Es el
 * único escenario cuyo umbral no es un número absoluto.
 */

import http from "k6/http";
import { check, sleep } from "k6";
import { Counter, Trend } from "k6/metrics";

import { BASE_URL, PAUSA_S, PERCENTILES, RUTAS, exigirDestinoSeguro } from "../config/base.js";
import { comoAnalista, esRechazoDeCupo, iniciarSesiones } from "../helpers/auth.js";
import { guardar } from "../helpers/reporte.js";

exigirDestinoSeguro("soak");

/** Minutos totales del tramo plano. Dos horas por omisión. */
const MINUTOS = Number(__ENV.SOAK_MINUTOS || 120);
/** Minutos de subida. La misma constante arma los escalones y la matemática de las ventanas. */
const RAMPA_MIN = Number(__ENV.SOAK_RAMPA_MIN || 2);
/** Cuánto dura cada ventana de comparación, en minutos. */
const VENTANA = Math.max(1, Math.round(MINUTOS / 10));

const primeraVentana = new Trend("soak_primera_ventana_ms", true);
/** Cuántas muestras cayó en cada ventana. Ver el umbral, abajo. */
const muestrasPrimera = new Counter("soak_muestras_primera");
const muestrasUltima = new Counter("soak_muestras_ultima");
const ultimaVentana = new Trend("soak_ultima_ventana_ms", true);

export const options = {
  stages: [
    { duration: `${RAMPA_MIN}m`, target: 30 },
    { duration: `${MINUTOS}m`, target: 30 },
    { duration: "2m", target: 0 },
  ],
  summaryTrendStats: PERCENTILES,
  thresholds: {
    http_req_failed: ["rate<0.01"],
    /*
     * El umbral de la deriva.
     *
     * No hay forma de escribir "la última ventana < 1,3 × la primera" en un
     * umbral de k6: comparan contra constantes. Así que el corte duro va acá
     * —la última ventana no puede duplicar el presupuesto— y la comparación
     * fina se calcula en `handleSummary`, que es donde se lee.
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
    soak_ultima_ventana_ms: ["p(95)<1000"],
    soak_muestras_primera: ["count>0"],
    soak_muestras_ultima: ["count>0"],
  },
};

export function setup() {
  return { ...iniciarSesiones(30, 60 / PAUSA_S), arranque: Date.now() };
}

export default function (sesion) {
  const minutos = (Date.now() - sesion.arranque) / 60000;
  const res = http.get(`${BASE_URL}${RUTAS.bandeja}`, comoAnalista(sesion));
  esRechazoDeCupo(res);
  check(res, { "200": (r) => r.status === 200 });

  /*
   * Las ventanas cuelgan de las MISMAS constantes que arman los escalones.
   *
   * Estaban escritas con el 2 de la rampa a mano. Basta con pisar los escalones
   * desde la línea de comandos —`k6 run --stage ...`, que es lo normal para
   * probar el script— y la primera ventana no se llena nunca: el reporte sale
   * con la deriva vacía y el umbral de la última pasa igual, porque en k6 un
   * umbral sobre una métrica SIN MUESTRAS no falla. Verde sin haber medido.
   */
  if (minutos > RAMPA_MIN && minutos <= RAMPA_MIN + VENTANA) {
    primeraVentana.add(res.timings.duration);
    muestrasPrimera.add(1);
  }
  if (minutos >= RAMPA_MIN + MINUTOS - VENTANA && minutos < RAMPA_MIN + MINUTOS) {
    ultimaVentana.add(res.timings.duration);
    muestrasUltima.add(1);
  }

  sleep(PAUSA_S);
}

export function handleSummary(datos) {
  const p = datos.metrics.soak_primera_ventana_ms;
  const u = datos.metrics.soak_ultima_ventana_ms;
  const inicio = p ? p.values["p(95)"] : null;
  const fin = u ? u.values["p(95)"] : null;
  const deriva = inicio && fin ? fin / inicio : null;

  /*
   * Una ventana vacía NO es «estable».
   *
   * Es el único resultado que este escenario no puede devolver en silencio: si
   * no hay con qué comparar, no se midió la deriva, y un reporte que dice «—»
   * al lado de umbrales en verde se lee como que salió todo bien.
   */
  const veredicto = !deriva
    ? "NO SE MIDIÓ — una de las dos ventanas quedó vacía; los escalones no coinciden con SOAK_MINUTOS/SOAK_RAMPA_MIN"
    : deriva <= 1.3
      ? "estable"
      : "SE DEGRADA — buscar qué crece con el tiempo";

  return guardar(datos, "soak", {
    "qué mide": "la deriva: cuánto empeora sola la latencia con el tiempo",
    "perfil": `${datos.metrics.vus_max ? datos.metrics.vus_max.values.max : "?"} VUs · ${RAMPA_MIN} min de subida + ${MINUTOS} min planos · ventanas de ${VENTANA} min`,
    "p95 primera ventana": inicio ? `${Math.round(inicio)} ms` : "sin muestras",
    "p95 última ventana": fin ? `${Math.round(fin)} ms` : "sin muestras",
    "deriva": deriva ? `${deriva.toFixed(2)}×` : "—",
    "veredicto": veredicto,
  });
}
