/**
 * En qué fase de la rampa está la corrida: `plano` o `rampa`.
 *
 * Las rampas de subida y de bajada tienen pocos usuarios, y mezclar sus pedidos
 * con los de la meseta baja el p95: un verde armado así no dice nada de la
 * carga que se fue a probar. Cada escenario con rampa etiqueta sus pedidos con
 * esto y el umbral mira sólo `fase:plano` (ver `umbralesDeLectura`).
 *
 * Se decide por los VUs activos y no por el reloj, así no depende de cuánto
 * tardó el `setup()`: es meseta mientras estén todos los del tope. Si se pisan
 * los escalones con `--stage` y el tope no se alcanza nunca, la guarda
 * `http_reqs … count>0` del umbral lo dice en vez de salir verde.
 */

import exec from "k6/execution";

export function faseDeLaCarga(vusTope) {
  return exec.instance.vusActive >= vusTope ? "plano" : "rampa";
}
