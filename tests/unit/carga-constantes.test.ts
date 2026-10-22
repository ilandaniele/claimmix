import { existsSync, readdirSync } from "node:fs";
import { join, resolve } from "node:path";
import { beforeAll, describe, expect, it, vi } from "vitest";

import { RATE_LIMIT_CONFIGS } from "@/lib/rate-limit/index";

/*
 * `config/base.js` lee `__ENV` al cargarse: k6 lo pone, Node no. Se lo da vacío
 * y se importa después. El archivo no importa nada de k6, así que se puede cargar.
 *
 * Con `allowJs`, TS deduce los tipos de `umbrales` y `selectorDeLectura` de sus
 * valores por omisión (`{}`, `null`): no dejaría pasar una fase ni leer las
 * claves. Se los escribe acá.
 */
type Umbrales = Record<string, string[]>;
type Base = Omit<typeof import("../load/config/base.js"), "umbrales" | "selectorDeLectura"> & {
  umbrales: (extra?: Umbrales, fase?: string | null) => Umbrales;
  selectorDeLectura: (fase?: string | null) => string;
};
let base: Base;

beforeAll(async () => {
  vi.stubGlobal("__ENV", {});
  base = (await import("../load/config/base.js")) as unknown as Base;
});

const APP = resolve(__dirname, "../../src/app");

/** Las rutas de `src/app` que tienen `route.ts` o `page.tsx`, sin los `(grupos)`. */
function rutasDeLaApp(dir = APP, prefijo: string[] = []): string[][] {
  const aqui = ["route.ts", "page.tsx"].some((f) => existsSync(join(dir, f))) ? [prefijo] : [];
  const hijas = readdirSync(dir, { withFileTypes: true })
    .filter((d) => d.isDirectory())
    .flatMap((d) =>
      rutasDeLaApp(
        join(dir, d.name),
        /^\(.*\)$/.test(d.name) ? prefijo : [...prefijo, d.name]
      )
    );
  return [...aqui, ...hijas];
}

const RUTAS_DE_LA_APP = rutasDeLaApp();

/** `[id]` acepta cualquier segmento; el resto tiene que coincidir tal cual. */
function existeEnLaApp(ruta: string): boolean {
  const pedida = ruta.split("?")[0].split("/").filter(Boolean);
  return RUTAS_DE_LA_APP.some(
    (real) =>
      real.length === pedida.length &&
      real.every((seg, i) => /^\[[^.\]]+\]$/.test(seg) || seg === pedida[i])
  );
}

describe("carga: las rutas que se miden existen en src/app", () => {
  it("el recorrido de src/app encuentra rutas (si no, el resto no prueba nada)", () => {
    expect(RUTAS_DE_LA_APP.length).toBeGreaterThan(20);
    expect(existeEnLaApp("/api/cases")).toBe(true);
    expect(existeEnLaApp("/api/ruta-inventada")).toBe(false);
  });

  it("RUTAS", () => {
    for (const ruta of Object.values(base.RUTAS)) {
      expect(existeEnLaApp(ruta), ruta).toBe(true);
    }
  });

  it("RUTAS_DE_CASO", () => {
    for (const armar of Object.values(base.RUTAS_DE_CASO)) {
      expect(existeEnLaApp(armar("11111111-1111-4111-8111-111111111111"))).toBe(true);
    }
  });

  it("RUTAS_PUBLICAS", () => {
    for (const ruta of base.RUTAS_PUBLICAS) {
      expect(existeEnLaApp(ruta), ruta).toBe(true);
    }
  });
});

describe("carga: atada a los topes del producto", () => {
  it("el cupo por sesión es el de /api/cases, por minuto", () => {
    expect(RATE_LIMIT_CONFIGS.CASES_API.windowMs).toBe(60_000);
    expect(base.cupoPorSesion()).toBe(RATE_LIMIT_CONFIGS.CASES_API.limit);
  });

  it("los logins por minuto son los de AUTH_POR_IP", () => {
    expect(RATE_LIMIT_CONFIGS.AUTH_POR_IP.windowMs).toBe(60_000);
    expect(base.TOPE_LOGIN_POR_MIN).toBe(RATE_LIMIT_CONFIGS.AUTH_POR_IP.limit);
  });

  it("la bandeja pide a lo sumo lo que el listado deja (per_page ≤ 100)", () => {
    for (const ruta of [base.RUTAS.bandeja, base.RUTAS.bandejaFiltrada, base.RUTAS.busqueda]) {
      const porPagina = Number(new URL(ruta, "http://x").searchParams.get("per_page"));
      expect(porPagina, ruta).toBeGreaterThan(0);
      expect(porPagina, ruta).toBeLessThanOrEqual(100);
    }
  });
});

describe("carga: listado", () => {
  it("arma la consulta sin escribirla a mano", () => {
    expect(base.listado(100)).toBe("/api/cases?page=1&per_page=100");
    expect(base.listado(25, "q=choque")).toBe("/api/cases?page=1&per_page=25&q=choque");
  });
});

describe("carga: los umbrales salen de un solo lugar", () => {
  const presupuesto = () => `p(95)<${base.PRESUPUESTO_P95_MS}`;

  it("sin fase miran las lecturas", () => {
    const u = base.umbrales();
    expect(u["http_req_duration{escenario:lectura}"]).toEqual([presupuesto()]);
    expect(u["http_req_failed{escenario:lectura}"]).toEqual(["rate<0.01"]);
    expect(u["http_reqs{escenario:lectura}"]).toEqual(["count>0"]);
  });

  it("con fase miran sólo esa fase, y no las lecturas de todas", () => {
    const u = base.umbrales({}, "plano");
    expect(u["http_req_duration{escenario:lectura,fase:plano}"]).toEqual([presupuesto()]);
    expect(u["http_reqs{escenario:lectura,fase:plano}"]).toEqual(["count>0"]);
    expect(Object.keys(u).some((k) => k === "http_req_duration{escenario:lectura}")).toBe(false);
    expect(base.selectorDeLectura("plano")).toBe("escenario:lectura,fase:plano");
  });

  it("cualquier escenario hereda los checks y el cupo", () => {
    const u = base.umbrales({ propio: ["count>0"] });
    expect(u.checks).toEqual(base.CHECKS_SIN_FALLAS);
    expect(u.rechazados_por_cupo).toEqual(["count<=0"]);
    expect(u.propio).toEqual(["count>0"]);
    expect(base.cupoSinRechazos(3)).toEqual({ rechazados_por_cupo: ["count<=3"] });
    expect(base.umbralesComunes()).toEqual({
      checks: base.CHECKS_SIN_FALLAS,
      rechazados_por_cupo: ["count<=0"],
    });
  });
});
