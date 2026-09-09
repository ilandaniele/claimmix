/**
 * Stress — ¿dónde se rompe?
 *
 * Sube de 50 a 200 analistas en escalones y NO pretende pasar. Un perfil de
 * estrés que sale verde no midió nada: si aguantó doscientos, el techo está más
 * arriba y no sabemos dónde.
 *
 * Lo que este perfil mide, y ninguno de los otros mide, es el PUNTO DE QUIEBRE:
 * en qué escalón la latencia se sale del presupuesto y en cuál empiezan los
 * errores. Los dos números se anotan aparte con métricas propias.
 *
 * Por eso el umbral de latencia acá está flojo a propósito —dos segundos, no
 * quinientos— y el que corta es el de errores. Un p95 de 900 ms con 200 VUs es
 * un dato, no una falla; un 5% de pedidos caídos sí es una falla.
 */

import http from "k6/http";
import { check } from "k6";
import { Gauge } from "k6/metrics";
import exec from "k6/execution";

import { BASE_URL, PERCENTILES, PRESUPUESTO_P95_MS, RUTAS, exigirDestinoSeguro } from "../config/base.js";
import { comoAnalista, esRechazoDeCupo, iniciarSesiones } from "../helpers/auth.js";
import { guardar } from "../helpers/reporte.js";

exigirDestinoSeguro("stress");

/** El escalón más alto en el que la latencia todavía entraba en el presupuesto. */
const ultimoEscalonSano = new Gauge("stress_ultimo_escalon_sano");
/** El primer escalón en el que algún pedido se cayó. */
const primerEscalonConErrores = new Gauge("stress_primer_escalon_con_errores");

export const options = {
  stages: [
    { duration: "3m", target: 50 },
    { duration: "4m", target: 100 },
    { duration: "4m", target: 150 },
    { duration: "4m", target: 200 },
    { duration: "5m", target: 200 },
    { duration: "3m", target: 0 },
  ],
  summaryTrendStats: PERCENTILES,
  thresholds: {
    // Lo que corta es que se caigan pedidos, no que tarden.
    http_req_failed: ["rate<0.05"],
    // Flojo A PROPÓSITO: acá tardar es el dato que se fue a buscar.
    "http_req_duration{escenario:lectura}": ["p(95)<2000"],
  },
};

export function setup() {
  // Sin pausa: 200 VUs martillando. El cupo de una cuenta es 100/min.
  return iniciarSesiones(200, 600);
}

export default function (sesion) {
  const res = http.get(`${BASE_URL}${RUTAS.bandeja}`, comoAnalista(sesion));
  const rechazado = esRechazoDeCupo(res);
  const ok = check(res, { "200": (r) => r.status === 200 });

  // Los VUs activos AHORA, que es el escalón en el que estamos.
  const nivel = exec.instance.vusActive;
  if (ok && res.timings.duration < PRESUPUESTO_P95_MS) {
    ultimoEscalonSano.add(nivel);
  }
  if (!ok) {
    primerEscalonConErrores.add(nivel);
  }
  // Sin pausa: el estrés es sostener presión, no simular a una persona.
}

export function handleSummary(datos) {
  const sano = datos.metrics.stress_ultimo_escalon_sano;
  const roto = datos.metrics.stress_primer_escalon_con_errores;
  /*
   * El techo se lee de la corrida, no del archivo.
   *
   * Estaba escrito a mano —«50 → 100 → 150 → 200»— y k6 deja pisar los
   * escalones desde la línea de comandos con `--stage`. O sea que el reporte
   * afirmaba un perfil que quizás no fue el que corrió, con el aplomo de un
   * dato medido.
   */
  const techo = datos.metrics.vus_max ? datos.metrics.vus_max.values.max : null;

  return guardar(datos, "stress", {
    "qué mide":
      "el punto de quiebre — en qué carga se sale del presupuesto y en cuál empiezan los errores",
    "VUs máximos de esta corrida": techo ?? "—",
    "último VU con latencia sana": sano ? sano.values.max : "—",
    // `.min`, no `.max`: es el PRIMER escalón que rompió. Con `.max` decía el
    // último, que es literalmente lo contrario y siempre hacia el lado bueno.
    "primer VU con errores": roto
      ? roto.values.min
      : `ninguno: el techo está más arriba de ${techo ?? "lo probado"}`,
    "por qué el umbral de latencia está flojo": "acá tardar es el dato, no la falla",
  });
}
