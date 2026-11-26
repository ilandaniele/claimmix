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

import { afterEach, describe, expect, it, vi } from "vitest";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

import { escribirReporte, formaSinMedir, type Reporte } from "../../scripts/lib/reporte-carga.mjs";
import { findRoutes, routePattern, routeToUrl } from "../../scripts/lib/rutas-api.mjs";
import {
  OperacionColgada,
  conTope,
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

// Una consulta que se cuelga no es una muestra lenta: antes la corrida seguía midiéndola 120 veces por
// celda hasta que Actions cancelaba el job a los 20 minutos, sin un número en el reporte.
describe("conTope", () => {
  afterEach(() => vi.useRealTimers());

  it("corta la operación que pasa el tope, con el nombre de la consulta", async () => {
    vi.useFakeTimers();
    const colgada = conTope("contadores", 10_000, () => new Promise<void>(() => {}));

    const resultado = colgada();
    const rechazo = expect(resultado).rejects.toThrow("op > 10 s en contadores");
    await vi.advanceTimersByTimeAsync(10_000);
    await rechazo;
    await expect(resultado).rejects.toBeInstanceOf(OperacionColgada);
  });

  it("no corta antes del tope", async () => {
    vi.useFakeTimers();
    const colgada = conTope("x", 10_000, () => new Promise<void>(() => {}));
    let termino = false;
    colgada().then(
      () => (termino = true),
      () => (termino = true)
    );
    await vi.advanceTimersByTimeAsync(9_999);
    expect(termino).toBe(false);
    await vi.advanceTimersByTimeAsync(1);
    expect(termino).toBe(true);
  });

  it("si la operación termina a tiempo resuelve y no deja el temporizador", async () => {
    vi.useFakeTimers();
    await expect(conTope("x", 10_000, async () => {})()).resolves.toBeUndefined();
    expect(vi.getTimerCount()).toBe(0);
  });

  // El tope por operación no ve la regresión que da consultas de segundos: cada una pasa por debajo.
  // Lo que las corta es el de la celda, que cuenta desde que se arma la operación.
  it("corta la celda que pasa su tope aunque ninguna operación pase el suyo", async () => {
    vi.useFakeTimers();
    const lenta = conTope("ciclo", 10_000, () => new Promise<void>((r) => setTimeout(r, 30)), 50);
    const correr = async () => {
      const vuelta = lenta();
      await vi.advanceTimersByTimeAsync(30);
      await vuelta;
    };

    await correr();
    await correr();
    const error = await lenta().catch((e: unknown) => e);

    expect(error).toBeInstanceOf(OperacionColgada);
    expect((error as Error).message).toBe("celda > 0.05 s en ciclo");
  });

  it("sin tope de celda no corta por el tiempo acumulado", async () => {
    const lenta = conTope("x", 10_000, () => new Promise<void>((r) => setTimeout(r, 5)));

    await lenta();
    await lenta();
    await expect(lenta()).resolves.toBeUndefined();
  });

  it("un error común pasa tal cual y tampoco deja el temporizador", async () => {
    vi.useFakeTimers();
    const rota = conTope("x", 10_000, async () => {
      throw new Error("la base dijo que no");
    });
    const error = await rota().catch((e: unknown) => e);

    expect(error).toBeInstanceOf(Error);
    expect(error).not.toBeInstanceOf(OperacionColgada);
    expect(vi.getTimerCount()).toBe(0);
  });
});

describe("una consulta colgada corta la medición", () => {
  const colgada = () => new OperacionColgada("op > 10 s en x");

  it("measure no sigue con las que quedan: ni una vuelta de más", async () => {
    let llamadas = 0;
    await expect(
      measure(120, 1, async () => {
        // La primera es el calentamiento; la segunda es la primera muestra.
        if (++llamadas >= 2) throw colgada();
      })
    ).rejects.toBeInstanceOf(OperacionColgada);
    expect(llamadas).toBe(2);
  });

  it("measure corta a todos los trabajadores, no sólo al que se colgó", async () => {
    let llamadas = 0;
    await expect(
      measure(120, 5, async () => {
        llamadas++;
        // Pasan los cinco del calentamiento y el primer trabajador se cuelga.
        if (llamadas === 6) throw colgada();
        await new Promise((r) => setTimeout(r, 1));
      })
    ).rejects.toBeInstanceOf(OperacionColgada);
    expect(llamadas).toBeLessThan(125);
  });

  it("el calentamiento también corta, y deja de llamar después de la primera vuelta", async () => {
    let llamadas = 0;
    await expect(
      measure(120, 3, async () => {
        llamadas++;
        throw colgada();
      })
    ).rejects.toBeInstanceOf(OperacionColgada);
    expect(llamadas).toBe(3);
  });

  it("el calentamiento sigue tragando un error común: lo cuenta la medición", async () => {
    let llamadas = 0;
    const samples = await measure(4, 2, async () => {
      if (++llamadas <= 2) throw new Error("conexión fría");
    });
    expect(samples.filter((s) => s.ok)).toHaveLength(4);
  });

  it("con el tope puesto, una consulta que nunca vuelve corta la medición y no la deja esperando", async () => {
    vi.useFakeTimers();
    try {
      let llamadas = 0;
      const op = conTope("contadores", 1_000, async () => {
        // El calentamiento pasa; todo lo que viene después no vuelve.
        if (++llamadas > 5) await new Promise<void>(() => {});
      });
      const medicion = measure(120, 5, op);
      const rechazo = expect(medicion).rejects.toThrow("op > 1 s en contadores");
      await vi.advanceTimersByTimeAsync(1_000);
      await rechazo;
      expect(llamadas).toBeLessThan(125);
    } finally {
      vi.useRealTimers();
    }
  });
});

describe("formaSinMedir", () => {
  const BASE = { nombre: "carga", pregunta: "¿Cuánto tarda?", metrica: "el peor p95", umbral: "p95 < 500ms" };

  it("es una forma que falla y dice por qué en lugar de un número", () => {
    const f = formaSinMedir(BASE, "op > 10 s en contadores · 5 analistas");

    expect(f).toEqual({ ...BASE, medido: "op > 10 s en contadores · 5 analistas", ok: false, filas: [], notas: [] });
  });

  it("conserva las filas que ya se habían medido", () => {
    const hecha = fila("listado · 1 analistas", [{ ms: 10, ok: true }]);
    const f = formaSinMedir(BASE, "no se midió", [hecha]);

    expect(f.ok).toBe(false);
    expect(f.filas).toEqual([hecha]);
  });

  it("sale en el reporte como cualquier otra forma", () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "carga-"));
    const f = formaSinMedir(BASE, "op > 10 s en x");
    const [json, pagina] = escribirReporte(path.join(dir, "colgada.json"), { ...REPORTE, formas: [f] });

    expect((JSON.parse(fs.readFileSync(json!, "utf8")) as Reporte).formas).toEqual([f]);
    expect(fs.readFileSync(pagina!, "utf8")).toContain("op &gt; 10 s en x");
    fs.rmSync(dir, { recursive: true, force: true });
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
