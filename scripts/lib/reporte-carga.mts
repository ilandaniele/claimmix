/**
 * El resultado de una corrida de carga, en un archivo.
 *
 * Sin esto los números de cada deploy viven en el log del runner y se van con
 * la retención — y el propio post-deploy pide, cuando falla, «comparalo con la
 * corrida del deploy anterior», que hoy no existe en ningún lado.
 *
 * Se escriben los dos formatos a la vez y del MISMO objeto: el JSON para
 * comparar dos corridas con una herramienta, el HTML para mirarlo. Que salgan
 * de la misma estructura es el punto — un resumen que se arma aparte termina
 * diciendo otra cosa que los datos, y entonces no se le puede creer a ninguno.
 */

import * as fs from "node:fs";
import * as path from "node:path";

/** Una medición: un escenario a un nivel de carga, o un tramo de tiempo. */
export interface Fila {
  etiqueta: string;
  muestras: number;
  /** Sobre cuántas se calcularon los percentiles: las que no fallaron. */
  medidas: number;
  p50: number;
  p95: number;
  max: number;
  fallaron: number;
}

/** Una forma de carga: qué pregunta, con qué número se contesta, y si pasó. */
export interface Forma {
  nombre: string;
  pregunta: string;
  metrica: string;
  umbral: string;
  medido: string;
  ok: boolean;
  filas: Fila[];
  notas: string[];
}

/** Una ruta que la prueba nombra, y si sigue existiendo en `src/app/api`. */
export interface Endpoint {
  metodo: string;
  ruta: string;
  archivo: string;
  auth: string;
  usa: string;
  existe: boolean;
}

export interface Reporte {
  cuando: string;
  base: string;
  casos: number;
  ok: boolean;
  endpoints: Endpoint[];
  formas: Forma[];
}

function ms(n: number): string {
  return n >= 1000 ? `${(n / 1000).toFixed(1)}s` : `${Math.round(n)}ms`;
}

function esc(s: string): string {
  return s.replace(
    /[&<>"]/g,
    (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" })[c]!
  );
}

function tablaFilas(filas: Fila[]): string {
  if (filas.length === 0) return "<p class=vacio>Sin mediciones.</p>";
  // «medidas» al lado de «muestras» a propósito: los percentiles salen sólo de
  // las que no fallaron, y sin esa columna un p95 de los sobrevivientes se lee
  // igual que uno de una celda sana.
  return `<table>
<tr><th>medición</th><th>muestras</th><th>medidas</th><th>p50</th><th>p95</th><th>máx</th><th>fallaron</th></tr>
${filas
  .map(
    (f) =>
      `<tr><td>${esc(f.etiqueta)}</td><td>${f.muestras}</td><td>${f.medidas}</td><td>${ms(f.p50)}</td>` +
      `<td>${ms(f.p95)}</td><td>${ms(f.max)}</td>` +
      `<td class="${f.fallaron > 0 ? "mal" : ""}">${f.fallaron}</td></tr>`
  )
  .join("\n")}
</table>`;
}

function html(r: Reporte): string {
  return `<!doctype html>
<html lang="es"><meta charset="utf-8">
<title>Carga — ClaimMix ${esc(r.cuando)}</title>
<style>
body{font:14px/1.5 system-ui,sans-serif;margin:2rem auto;max-width:56rem;padding:0 1rem;color:#111}
h1{font-size:1.4rem;margin-bottom:.2rem}
h2{font-size:1.1rem;margin:2rem 0 .3rem}
table{border-collapse:collapse;width:100%;margin:.6rem 0 1rem}
th,td{border-bottom:1px solid #ddd;padding:.3rem .5rem;text-align:right}
th:first-child,td:first-child{text-align:left}
.bien{color:#0a6b2e;font-weight:600}.mal{color:#a4111a;font-weight:600}
.meta{color:#555}.vacio{color:#777;font-style:italic}
dl{display:grid;grid-template-columns:auto 1fr;gap:.1rem .8rem;margin:.4rem 0}
dt{color:#555}dd{margin:0}
</style>
<h1>Prueba de carga — ClaimMix</h1>
<p class=meta>${esc(r.cuando)} · ${esc(r.base)} · ${r.casos} casos en la base ·
<span class="${r.ok ? "bien" : "mal"}">${r.ok ? "dentro del presupuesto" : "algo se pasó"}</span></p>

<h2>Rutas que la prueba nombra</h2>
<table>
<tr><th>ruta</th><th>autenticación</th><th>la usa</th><th>existe</th></tr>
${r.endpoints
  .map(
    (e) =>
      `<tr><td>${esc(e.metodo)} ${esc(e.ruta)}</td><td>${esc(e.auth)}</td>` +
      `<td>${esc(e.usa)}</td><td class="${e.existe ? "bien" : "mal"}">${e.existe ? "sí" : "NO"}</td></tr>`
  )
  .join("\n")}
</table>

${r.formas
  .map(
    (f) => `<h2>${esc(f.nombre)} <span class="${f.ok ? "bien" : "mal"}">${f.ok ? "✓" : "✗"}</span></h2>
<p class=meta>${esc(f.pregunta)}</p>
<dl><dt>mide</dt><dd>${esc(f.metrica)}</dd><dt>umbral</dt><dd>${esc(f.umbral)}</dd><dt>medido</dt><dd>${esc(f.medido)}</dd></dl>
${tablaFilas(f.filas)}
${f.notas.map((n) => `<p class=meta>${esc(n)}</p>`).join("\n")}`
  )
  .join("\n")}
</html>
`;
}

/**
 * Escribe el JSON en `archivo` y el HTML al lado, con el mismo nombre.
 *
 * Los dos juntos y no uno u otro: quien compara dos deploys quiere el JSON, y
 * quien mira el artefacto después de un rojo quiere el HTML. Pedirlos por
 * separado garantiza que alguna corrida guarde sólo el que no hacía falta.
 */
export function escribirReporte(archivo: string, reporte: Reporte): string[] {
  const json = archivo.endsWith(".json") ? archivo : `${archivo}.json`;
  const pagina = path.join(path.dirname(json), `${path.basename(json, ".json")}.html`);
  fs.writeFileSync(json, JSON.stringify(reporte, null, 2));
  fs.writeFileSync(pagina, html(reporte));
  return [json, pagina];
}
