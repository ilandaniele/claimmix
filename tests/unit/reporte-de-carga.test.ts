/**
 * El reporte de la prueba de carga, y las rutas que esa prueba nombra.
 *
 * Dos cosas que no se pueden comprobar corriendo `pnpm load` —que corre contra
 * producción y no lo corre nadie en cada push— y que fallan en silencio:
 *
 *   · Un reporte que se escribe a medias, o un HTML que dice otros números que
 *     el JSON. Los dos salen del mismo objeto; esto lo verifica.
 *   · Una ruta renombrada. La prueba de carga nombra dos rutas a mano; acá se
 *     comprueba que sigan existiendo en el árbol, en cada push y no el día que
 *     alguien corre la prueba.
 */

import { describe, expect, it } from "vitest";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

import { escribirReporte, type Reporte } from "../../scripts/lib/reporte-carga.mjs";
import { findRoutes, routePattern, routeToUrl } from "../../scripts/lib/rutas-api.mjs";
import {
  fila,
  measure,
  measureFor,
  percentile,
  porTiempo,
  razon,
  veces,
} from "../../scripts/lib/medir-carga.mjs";

const REPORTE: Reporte = {
  cuando: "2026-09-07T12:00:00.000Z",
  base: "https://claimmix.vercel.app",
  casos: 460,
  ok: false,
  endpoints: [
    {
      metodo: "POST",
      ruta: "/api/webhooks/whatsapp",
      archivo: "src/app/api/webhooks/whatsapp/route.ts",
      auth: "Bearer WHATSAPP_WEBHOOK_SECRET",
      usa: "la ráfaga de escritura",
      existe: true,
    },
  ],
  formas: [
    {
      nombre: "carga",
      pregunta: "¿Cuánto tarda una consulta con la mesa llena?",
      metrica: "el peor p95",
      umbral: "p95 < 500ms",
      medido: "p95 peor caso 617ms",
      ok: false,
      filas: [
        {
          etiqueta: "listado <20 analistas>",
          muestras: 120,
          medidas: 118,
          p50: 141,
          p95: 617,
          max: 980,
          fallaron: 2,
        },
      ],
      notas: ["Medido como función contra la base."],
    },
  ],
};

describe("el reporte de la prueba de carga", () => {
  it("escribe JSON y HTML con los mismos números", () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "carga-"));
    const [json, pagina] = escribirReporte(path.join(dir, "corrida.json"), REPORTE);

    expect(json).toMatch(/corrida\.json$/);
    expect(pagina).toMatch(/corrida\.html$/);

    const leido = JSON.parse(fs.readFileSync(json!, "utf8")) as Reporte;
    expect(leido).toEqual(REPORTE);

    const html = fs.readFileSync(pagina!, "utf8");
    // Los números medidos, no un resumen escrito aparte.
    expect(html).toContain("617ms");
    expect(html).toContain("460 casos");
    expect(html).toContain("/api/webhooks/whatsapp");
    // Y la etiqueta escapada: un `<` sin escapar rompe la tabla entera.
    expect(html).toContain("listado &lt;20 analistas&gt;");

    fs.rmSync(dir, { recursive: true, force: true });
  });

  it("le agrega .json al nombre si no lo tiene", () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "carga-"));
    const [json, pagina] = escribirReporte(path.join(dir, "corrida"), REPORTE);
    expect(fs.existsSync(json!)).toBe(true);
    expect(fs.existsSync(pagina!)).toBe(true);
    fs.rmSync(dir, { recursive: true, force: true });
  });
});

describe("el núcleo de medición", () => {
  // Por qué la prueba junta 120 muestras por celda y no tres: con tres, el
  // «p95» es el peor de los tres, y entonces una corrida lenta no es una cola
  // de la distribución, es toda la medición.
  it("con tres muestras el p95 es el máximo, con 120 no", () => {
    expect(percentile([10, 20, 900], 95)).toBe(900);

    const ciento_veinte = [...Array(119).fill(10), 900].sort((a, b) => a - b);
    expect(percentile(ciento_veinte, 95)).toBe(10);
  });

  it("no deja más operaciones en vuelo que la concurrencia pedida", async () => {
    let enVuelo = 0;
    let pico = 0;
    const samples = await measure(20, 4, async () => {
      pico = Math.max(pico, ++enVuelo);
      await new Promise((r) => setTimeout(r, 1));
      enVuelo--;
    });
    expect(samples).toHaveLength(20);
    expect(pico).toBeLessThanOrEqual(4);
  });

  it("cuenta como fallada la operación que tira, y la cronometra igual", async () => {
    const samples = await measure(4, 1, async () => {
      throw new Error("la base dijo que no");
    });
    expect(samples.filter((s) => !s.ok)).toHaveLength(4);
  });

  it("por tiempo corre hasta el plazo y no una operación fija", async () => {
    const desde = performance.now();
    const samples = await measureFor(60, 2, () => new Promise((r) => setTimeout(r, 5)));
    expect(performance.now() - desde).toBeGreaterThanOrEqual(55);
    expect(samples.length).toBeGreaterThan(4);
  });

  // Si fallaron TODAS las muestras del «antes», su p95 es 0 —los percentiles
  // salen sólo de las que salieron bien— y devolver 1 ahí era inventar la
  // comparación que pasa: 1,00× es el mejor resultado posible y nadie lo mira
  // dos veces. La forma reportaba «volvió a la normalidad» sobre una base que
  // no existió.
  it("sin línea de base no inventa una comparación que pase", () => {
    expect(veces(0, 500)).toBe(Number.POSITIVE_INFINITY);
    expect(razon(veces(0, 500))).toBe("sin línea de base");
    expect(veces(0, 0)).toBe(1);
    expect(veces(200, 400)).toBe(2);
  });

  // Los percentiles se calculan sólo sobre las que no fallaron, al lado de un
  // conteo de muestras que sí las incluye: un sistema que rechaza el 40% puede
  // mostrar un p95 mejor que uno sano. Las dos columnas tienen que estar.
  it("dice sobre cuántas muestras calculó el p95, no sólo cuántas pidió", () => {
    const f = fila("mitad caída", [
      { ms: 10, ok: true },
      { ms: 20, ok: true },
      { ms: 5000, ok: false },
      { ms: 5000, ok: false },
    ]);
    expect(f.muestras).toBe(4);
    expect(f.medidas).toBe(2);
    expect(f.p95).toBe(20);
  });

  // La cantidad de muestras por unidad de tiempo es inversamente proporcional a
  // la latencia: partir por índice hace que el tramo degradado achique su
  // propia representación justo en la proporción en que degrada.
  it("parte las muestras por tiempo y no por posición en el arreglo", () => {
    const rapidas = Array.from({ length: 90 }, (_, i) => ({ ms: 10, ok: true, t: i * 8 }));
    // 3 muestras lentas ocupan el último tercio del reloj y son el 3% del arreglo.
    const lentas = Array.from({ length: 3 }, (_, i) => ({ ms: 1000, ok: true, t: 800 + i * 150 }));
    const [primero, , ultimo] = porTiempo([...rapidas, ...lentas], 3);

    expect(primero!.every((s) => s.ms === 10)).toBe(true);
    expect(ultimo!.every((s) => s.ms === 1000)).toBe(true);
    expect(veces(fila("a", primero!).p95, fila("b", ultimo!).p95)).toBe(100);
  });

  it("cronometra cada muestra desde que arrancó, para poder partirlas por reloj", async () => {
    const samples = await measure(4, 1, () => new Promise((r) => setTimeout(r, 1)));
    expect(samples.every((s) => typeof s.t === "number")).toBe(true);
  });

  // Con neon-http cada consulta en vuelo abre su propio socket: sin este
  // calentamiento, `concurrency` muestras de cada medición pagaban TCP+TLS y la
  // tabla de 1 / 5 / 20 comparaba conexión caliente contra conexión fría.
  it("abre las conexiones antes de cronometrar, y esas vueltas no son muestras", async () => {
    let vueltas = 0;
    const samples = await measure(10, 3, async () => {
      vueltas++;
    });
    expect(samples).toHaveLength(10);
    expect(vueltas).toBe(13);
  });
});

describe("las rutas que la prueba de carga nombra", () => {
  const rutas = new Set(findRoutes("src/app/api").map(routePattern));

  // Si esto falla, alguien renombró la ruta y la prueba de carga se enteraría
  // con un 404 contado como falla de carga.
  it.each(["/api/webhooks/whatsapp", "/api/health"])("%s existe", (ruta) => {
    expect(rutas.has(ruta)).toBe(true);
  });

  it("convierte los segmentos dinámicos en algo pedible", () => {
    expect(routeToUrl("src/app/api/cases/[id]/route.ts")).toBe(
      "/api/cases/00000000-0000-0000-0000-000000000001"
    );
  });
});
