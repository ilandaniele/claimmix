/**
 * Qué se lleva una corrida cuando termina.
 *
 * k6 imprime un resumen y se va. Sin esto no queda nada que comparar contra la
 * corrida de la semana pasada, que es para lo que sirve medir.
 *
 * Se escriben los dos: el JSON es lo que compara una máquina —y lo que sube la
 * CI como artefacto— y el HTML es lo que mira una persona sin instalar nada.
 * El `stdout` se deja porque si no, la corrida no dice nada mientras pasa.
 */

/** Redondea a un decimal, o `null` cuando la métrica no existe en ese escenario. */
function ms(valor) {
  return typeof valor === "number" ? Math.round(valor * 10) / 10 : null;
}

/**
 * Lo que importa de un resumen de k6, sin las cien claves que no mira nadie.
 *
 * `escenario` y `notas` los pone cada archivo: son lo que ESE perfil fue a
 * medir, y son distintos entre sí a propósito.
 */
export function resumen(datos, escenario, notas = {}) {
  const dur = datos.metrics.http_req_duration || { values: {} };
  const fallos = datos.metrics.http_req_failed || { values: {} };
  const pedidos = datos.metrics.http_reqs || { values: {} };

  return {
    escenario,
    generado_en: new Date().toISOString(),
    pedidos: pedidos.values.count ?? 0,
    rps: ms(pedidos.values.rate),
    fallidos_pct: ms((fallos.values.rate ?? 0) * 100),
    latencia_ms: {
      p50: ms(dur.values.med),
      p90: ms(dur.values["p(90)"]),
      p95: ms(dur.values["p(95)"]),
      p99: ms(dur.values["p(99)"]),
      max: ms(dur.values.max),
    },
    umbrales: Object.fromEntries(
      Object.entries(datos.metrics)
        .filter(([, m]) => m.thresholds)
        .map(([nombre, m]) => [
          nombre,
          Object.fromEntries(
            Object.entries(m.thresholds).map(([k, v]) => [k, v.ok ? "ok" : "ROTO"])
          ),
        ])
    ),
    notas,
  };
}

function html(r) {
  const filas = Object.entries(r.latencia_ms)
    .map(([k, v]) => `<tr><th>${k}</th><td>${v ?? "—"} ms</td></tr>`)
    .join("");
  const umbrales = Object.entries(r.umbrales)
    .flatMap(([nombre, estados]) =>
      Object.entries(estados).map(
        ([regla, estado]) =>
          `<tr><th>${nombre}</th><td>${regla}</td><td class="${
            estado === "ok" ? "ok" : "mal"
          }">${estado}</td></tr>`
      )
    )
    .join("");
  const notas = Object.entries(r.notas)
    .map(([k, v]) => `<tr><th>${k}</th><td>${v}</td></tr>`)
    .join("");

  return `<!doctype html><meta charset="utf-8"><title>Carga — ${r.escenario}</title>
<style>
  body{font:14px/1.5 system-ui,sans-serif;margin:2rem auto;max-width:46rem;color:#0f172a}
  h1{font-size:1.4rem;margin:0 0 .25rem}
  p.sub{color:#475569;margin:0 0 1.5rem}
  table{border-collapse:collapse;width:100%;margin:0 0 1.5rem}
  th,td{text-align:left;padding:.4rem .6rem;border-bottom:1px solid #e2e8f0}
  th{color:#475569;font-weight:600}
  .ok{color:#15803d}.mal{color:#b91c1c;font-weight:700}
  h2{font-size:1rem;margin:0 0 .4rem}
</style>
<h1>Carga — ${r.escenario}</h1>
<p class="sub">${r.generado_en} · ${r.pedidos} pedidos · ${r.rps ?? "—"} req/s · ${
    r.fallidos_pct ?? 0
  }% fallidos</p>
<h2>Latencia</h2><table>${filas}</table>
<h2>Umbrales</h2><table>${umbrales || "<tr><td>ninguno</td></tr>"}</table>
${notas ? `<h2>Lo que este perfil fue a medir</h2><table>${notas}</table>` : ""}`;
}

/**
 * El `handleSummary` de k6. Cada escenario lo reexporta con su nombre y sus
 * notas.
 */
export function guardar(datos, escenario, notas = {}) {
  const r = resumen(datos, escenario, notas);
  const base = `resultados/carga-${escenario}`;
  return {
    stdout: `\n${escenario}: p95 ${r.latencia_ms.p95} ms · ${r.fallidos_pct}% fallidos · ${r.pedidos} pedidos\n`,
    [`${base}.json`]: JSON.stringify(r, null, 2),
    [`${base}.html`]: html(r),
  };
}
