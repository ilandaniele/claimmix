/**
 * Cómo se comparan las banderas de dev, QA y prd (`pnpm paridad`).
 *
 * El comparador es la parte que se equivoca sola y no se puede probar pegándole a
 * los ambientes, así que vive en un módulo puro y se prueba acá, sin red. Dos
 * cosas importan más que el resto:
 *   - que una diferencia a propósito (D2, D6, D7) no se avise y una que no lo es sí;
 *   - que nada fuera del contrato de `banderas` llegue a la salida, porque los logs
 *     y el resumen de Actions son públicos.
 */

import { spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

import { afterAll, describe, expect, it, vi } from "vitest";

import {
  AMBIENTES,
  EXCEPCIONES,
  NO_ESPERADO,
  commitEsperado,
  compararParidad,
  leerAmbiente,
  leerRespuesta,
  lineasDeParidad,
  urlDePrd,
} from "../../scripts/lib/paridad.mjs";

const ROOT = resolve(__dirname, "../..");

// Las claves salen de banderas.ts: ese archivo no se importa porque es
// `server-only`, y así el test sigue la lista real en vez de copiarla.
const CLAVES = [
  ...readFileSync(join(ROOT, "src/app/api/health/banderas.ts"), "utf8").matchAll(/^ {4}([A-Z][A-Z0-9_]*): /gm),
].map((m) => m[1]);

type Valores = Record<string, boolean | number | string | null>;

/** Un ambiente sin nada raro: todo apagado salvo el alta automática (D6). */
const base = (cambios: Valores = {}): Valores => ({
  ...Object.fromEntries(CLAVES.map((c) => [c, false])),
  ALTA_AUTOMATICA: true,
  ...cambios,
});

const lectura = (valores: Valores, commit = "abc1234") => leerRespuesta(200, { banderas: valores, commit });

/** dev, QA y prd como deben estar igualados: sólo BASE_POR_CLIENTE (D2) distinta. */
const ambientes = (dev: Valores = {}, qa: Valores = {}, prd: Valores = {}) => ({
  dev: lectura(base(dev), "1111111"),
  qa: lectura(base(qa), "2222222"),
  prd: lectura(base({ BASE_POR_CLIENTE: true, ...prd }), "3333333"),
});

const hallazgosDe = (lecturas: Record<string, unknown>, clave?: string) => {
  const { hallazgos } = compararParidad(lecturas);
  return clave ? hallazgos.filter((h) => h.clave === clave) : hallazgos;
};

describe("la lista de claves", () => {
  it("se lee de banderas.ts y trae las que usan las excepciones", () => {
    expect(CLAVES.length).toBeGreaterThan(40);
    expect(CLAVES).toEqual(expect.arrayContaining(["BASE_POR_CLIENTE", "ALTA_AUTOMATICA", "SIGNUP_ALLOWED_EMAILS"]));
    expect(new Set(CLAVES).size).toBe(CLAVES.length);
  });
});

describe("leerRespuesta", () => {
  it("lee un 200 y un 503: los dos traen banderas", () => {
    for (const codigo of [200, 503]) {
      expect(leerRespuesta(codigo, { banderas: { ALTA_AUTOMATICA: true, MONTHLY_BUDGET_USD: 12.5 }, commit: "abc1234" })).toEqual({
        legible: true,
        banderas: { ALTA_AUTOMATICA: true, MONTHLY_BUDGET_USD: 12.5 },
        commit: "abc1234",
      });
    }
  });

  it.each([
    [401, "sin permiso (401)"],
    [0, "sin respuesta"],
    [null, "sin respuesta"],
    [99, "sin respuesta"],
    [1000, "sin respuesta"],
    [500, "HTTP 500"],
    [404, "HTTP 404"],
    [302, "HTTP 302"],
  ])("el código %s no se lee: %s", (codigo, motivo) => {
    expect(leerRespuesta(codigo, { banderas: { ALTA_AUTOMATICA: true } })).toEqual({ legible: false, motivo });
  });

  it.each([null, undefined, {}, { banderas: null }, { banderas: [] }, { banderas: "texto" }, []])(
    "un 200 sin banderas legibles (%j) no se lee",
    (cuerpo) => {
      expect(leerRespuesta(200, cuerpo)).toEqual({ legible: false, motivo: "sin banderas" });
    },
  );

  it("del cuerpo sólo copia banderas y commit: nada más llega a la lectura", () => {
    const sentinela = "valor-centinela-xyz";
    const cuerpo = { banderas: { A: true }, commit: "abc1234", checks: [{ detail: sentinela }], token: sentinela };

    expect(JSON.stringify(leerRespuesta(200, cuerpo))).not.toContain(sentinela);
    expect(JSON.stringify(leerRespuesta(500, cuerpo))).not.toContain(sentinela);
    expect(JSON.stringify(leerRespuesta(401, cuerpo))).not.toContain(sentinela);
  });

  it("descarta las claves que no son de banderas", () => {
    const largo = `A${"B".repeat(64)}`;
    const l = leerRespuesta(200, {
      banderas: { OK: true, minuscula: true, "A B": true, "1A": true, "A-B": true, __proto__x: true, [largo]: true },
    });

    expect(l).toEqual({ legible: true, banderas: { OK: true }, commit: "?" });
  });

  it("acepta booleanos, números, null y modos; el resto queda como no esperado", () => {
    const banderas = {
      BOOL: false,
      ENTERO: 40,
      DECIMAL: 12.5,
      NULO: null,
      MODO: "ai-studio",
      DESCONOCIDO: "desconocido",
      CON_ESPACIO: "hola mundo",
      MAYUSCULA: "Valor",
      URL: "https://ejemplo.com/x",
      LARGO: "a".repeat(30),
      OBJETO: { dentro: 1 },
      LISTA: [1],
      INDEFINIDO: undefined,
      INFINITO: Number.POSITIVE_INFINITY,
      NO_NUMERO: Number.NaN,
      VACIO: "",
    };
    const l = leerRespuesta(200, { banderas, commit: "abc1234" });

    expect(l).toMatchObject({ legible: true });
    if (!l.legible) return;
    expect(l.banderas).toEqual({
      BOOL: false,
      ENTERO: 40,
      DECIMAL: 12.5,
      NULO: null,
      MODO: "ai-studio",
      DESCONOCIDO: "desconocido",
      CON_ESPACIO: NO_ESPERADO,
      MAYUSCULA: NO_ESPERADO,
      URL: NO_ESPERADO,
      LARGO: NO_ESPERADO,
      OBJETO: NO_ESPERADO,
      LISTA: NO_ESPERADO,
      INDEFINIDO: NO_ESPERADO,
      INFINITO: NO_ESPERADO,
      NO_NUMERO: NO_ESPERADO,
      VACIO: NO_ESPERADO,
    });
  });

  it.each([
    ["abc1234", "abc1234"],
    ["0123456789abcdef0123456789abcdef01234567", "0123456789abcdef0123456789abcdef01234567"],
    ["abc123", "?"],
    ["ABCDEF1", "?"],
    ["no es un sha", "?"],
    [null, "?"],
    [undefined, "?"],
    [1234567, "?"],
  ])("el commit %j queda como %j", (commit, esperado) => {
    expect(leerRespuesta(200, { banderas: { A: true }, commit })).toMatchObject({ commit: esperado });
  });

  it("no pasa de 200 claves: un cuerpo ajeno no llena el log", () => {
    const banderas = Object.fromEntries(Array.from({ length: 300 }, (_, i) => [`K${i}`, true]));
    const l = leerRespuesta(200, { banderas });

    expect(l.legible && Object.keys(l.banderas).length).toBe(200);
  });
});

describe("compararParidad: lo que está igualado", () => {
  it("tres ambientes iguales (salvo D2) no dan hallazgos y traen los commits", () => {
    expect(compararParidad(ambientes())).toEqual({
      hallazgos: [],
      ilegibles: [],
      commits: { dev: "1111111", qa: "2222222", prd: "3333333" },
    });
  });

  it("BASE_POR_CLIENTE no da `difiere` cuando es false en dev y QA y true en prd", () => {
    expect(hallazgosDe(ambientes(), "BASE_POR_CLIENTE")).toEqual([]);
  });
});

describe("compararParidad: las excepciones", () => {
  it("D2: BASE_POR_CLIENTE en true en dev rompe la regla y nombra el ambiente", () => {
    expect(hallazgosDe(ambientes({ BASE_POR_CLIENTE: true }), "BASE_POR_CLIENTE")).toEqual([
      expect.objectContaining({ tipo: "regla", detalle: "dev", motivo: expect.stringMatching(/^D2: /) }),
    ]);
  });

  it("D2: BASE_POR_CLIENTE en false en prd rompe la regla", () => {
    expect(hallazgosDe(ambientes({}, {}, { BASE_POR_CLIENTE: false }), "BASE_POR_CLIENTE")).toEqual([
      expect.objectContaining({ tipo: "regla", detalle: "prd" }),
    ]);
  });

  it("D2: dev y QA en true se nombran los dos", () => {
    expect(hallazgosDe(ambientes({ BASE_POR_CLIENTE: true }, { BASE_POR_CLIENTE: true }), "BASE_POR_CLIENTE")).toEqual([
      expect.objectContaining({ tipo: "regla", detalle: "dev,qa" }),
    ]);
  });

  it("D6: la lista de altas cargada con el alta automática prendida rompe la regla en ese ambiente", () => {
    expect(hallazgosDe(ambientes({ SIGNUP_ALLOWED_EMAILS: true }), "SIGNUP_ALLOWED_EMAILS")).toEqual([
      expect.objectContaining({ tipo: "regla", detalle: "dev", motivo: expect.stringMatching(/^D6: /) }),
    ]);
  });

  it("D6: la lista cargada donde no hay alta automática está bien, aunque otro ambiente no la tenga", () => {
    const lecturas = ambientes({ SIGNUP_ALLOWED_EMAILS: true, ALTA_AUTOMATICA: false });

    expect(hallazgosDe(lecturas, "SIGNUP_ALLOWED_EMAILS")).toEqual([]);
  });

  it("D6: la lista cargada en los tres con el alta apagada en los tres está bien", () => {
    const apagada = { SIGNUP_ALLOWED_EMAILS: true, ALTA_AUTOMATICA: false };

    expect(hallazgosDe(ambientes(apagada, apagada, apagada), "SIGNUP_ALLOWED_EMAILS")).toEqual([]);
  });

  it("D6: sin la lista cargada no hay nada que decir, con el alta como esté", () => {
    expect(hallazgosDe(ambientes({ ALTA_AUTOMATICA: false }), "SIGNUP_ALLOWED_EMAILS")).toEqual([]);
  });

  it.each(["MONTHLY_BUDGET_USD", "AI_TENANT_DAILY_TOKEN_CAP"])("D7: %s distinto entre dev y QA rompe la regla", (clave) => {
    const lecturas = ambientes({ [clave]: 10 }, { [clave]: 20 }, { [clave]: 10 });

    expect(hallazgosDe(lecturas, clave)).toEqual([
      expect.objectContaining({ tipo: "regla", detalle: "dev≠qa", motivo: expect.stringMatching(/^D7: /) }),
    ]);
  });

  it.each(["MONTHLY_BUDGET_USD", "AI_TENANT_DAILY_TOKEN_CAP"])("D7: %s igual en dev y QA con prd distinto está bien", (clave) => {
    expect(hallazgosDe(ambientes({ [clave]: 10 }, { [clave]: 10 }, { [clave]: 99 }), clave)).toEqual([]);
  });

  it("D7: null (rige el valor por omisión) contra un número entre dev y QA también rompe la regla", () => {
    const lecturas = ambientes({ MONTHLY_BUDGET_USD: null }, { MONTHLY_BUDGET_USD: 20 });

    expect(hallazgosDe(lecturas, "MONTHLY_BUDGET_USD")).toEqual([expect.objectContaining({ tipo: "regla", detalle: "dev≠qa" })]);
  });

  it("una clave con excepción nunca da `difiere`", () => {
    const lecturas = ambientes({ MONTHLY_BUDGET_USD: 1 }, { MONTHLY_BUDGET_USD: 1 }, { MONTHLY_BUDGET_USD: 2 });

    expect(hallazgosDe(lecturas).filter((h) => h.tipo === "difiere")).toEqual([]);
  });
});

describe("compararParidad: lo que no está en la tabla", () => {
  it("dos ambientes iguales y uno distinto dicen quiénes coinciden", () => {
    const lecturas = ambientes({ GEMINI_TRANSPORT: "vertex" }, { GEMINI_TRANSPORT: "vertex" }, { GEMINI_TRANSPORT: "ai-studio" });

    expect(hallazgosDe(lecturas, "GEMINI_TRANSPORT")).toEqual([expect.objectContaining({ tipo: "difiere", detalle: "dev=qa≠prd" })]);
  });

  it("tres valores distintos quedan en tres grupos, en el orden dev, QA, prd", () => {
    const lecturas = ambientes({ ALTA_TOPE_MB: 1 }, { ALTA_TOPE_MB: 2 }, { ALTA_TOPE_MB: 3 });

    expect(hallazgosDe(lecturas, "ALTA_TOPE_MB")).toEqual([expect.objectContaining({ tipo: "difiere", detalle: "dev≠qa≠prd" })]);
  });

  it("un booleano distinto también es una diferencia", () => {
    expect(hallazgosDe(ambientes({ MOCK_AI: true }), "MOCK_AI")).toEqual([
      expect.objectContaining({ tipo: "difiere", detalle: "dev≠qa=prd" }),
    ]);
  });

  it("null contra un número es una omisión, no una diferencia cualquiera", () => {
    const lecturas = ambientes({ ALTA_TOPE_MB: null }, { ALTA_TOPE_MB: 5 }, { ALTA_TOPE_MB: 5 });

    expect(hallazgosDe(lecturas, "ALTA_TOPE_MB")).toEqual([expect.objectContaining({ tipo: "omision", detalle: "dev≠qa=prd" })]);
  });

  it("null en los tres es lo mismo y no avisa", () => {
    const nulo = { ALTA_TOPE_MB: null };

    expect(hallazgosDe(ambientes(nulo, nulo, nulo), "ALTA_TOPE_MB")).toEqual([]);
  });

  it("un modo que el código no reconoce avisa aunque coincida en los tres", () => {
    const raro = { RETENCION_MODO: "desconocido" };

    expect(hallazgosDe(ambientes(raro, raro, raro), "RETENCION_MODO")).toEqual([
      expect.objectContaining({ tipo: "desconocido", detalle: "dev,qa,prd" }),
    ]);
  });

  it("un valor fuera del contrato avisa y dice dónde", () => {
    const lecturas = ambientes({}, { ALTA_TOPE_MB: "Valor Raro" }, {});

    expect(hallazgosDe(lecturas, "ALTA_TOPE_MB")).toEqual([expect.objectContaining({ tipo: "no-esperado", detalle: "qa" })]);
  });

  it("una clave que está en unos ambientes y en otros no es otro código, y trae los commits", () => {
    const { banderas } = lectura(base()) as { banderas: Valores };
    const sinLaClave = Object.fromEntries(Object.entries(banderas).filter(([k]) => k !== "ALTA_TOPE_MB"));
    const lecturas = { ...ambientes(), qa: lectura(sinLaClave, "2222222") };

    expect(hallazgosDe(lecturas, "ALTA_TOPE_MB")).toEqual([
      expect.objectContaining({ tipo: "falta", detalle: "sin clave en qa; commits dev=1111111 qa=2222222 prd=3333333" }),
    ]);
  });

  it("una clave da a lo sumo un hallazgo: gana el fuera de contrato", () => {
    const { banderas } = lectura(base()) as { banderas: Valores };
    const sinLaClave = Object.fromEntries(Object.entries(banderas).filter(([k]) => k !== "ALTA_TOPE_MB"));
    const lecturas = {
      dev: lectura(base({ ALTA_TOPE_MB: 1 })),
      qa: lectura(base({ ALTA_TOPE_MB: "Valor Raro" })),
      prd: lectura(sinLaClave),
    };

    expect(hallazgosDe(lecturas, "ALTA_TOPE_MB")).toEqual([expect.objectContaining({ tipo: "no-esperado" })]);
  });

  it("el hallazgo guarda los valores de cada ambiente para quien corre el guión a mano", () => {
    const lecturas = ambientes({ ALTA_TOPE_MB: 1 }, { ALTA_TOPE_MB: 2 }, { ALTA_TOPE_MB: 3 });

    expect(hallazgosDe(lecturas, "ALTA_TOPE_MB")[0].valores).toEqual({ dev: 1, qa: 2, prd: 3 });
  });
});

describe("compararParidad: ambientes que no contestan", () => {
  it("uno ilegible se dice, y los otros dos se comparan igual", () => {
    const lecturas = { ...ambientes({ GEMINI_TRANSPORT: "vertex" }, { GEMINI_TRANSPORT: "ai-studio" }), prd: leerRespuesta(401, null) };
    const r = compararParidad(lecturas);

    expect(r.ilegibles).toEqual([{ ambiente: "prd", motivo: "sin permiso (401)" }]);
    expect(r.commits).toEqual({ dev: "1111111", qa: "2222222" });
    expect(r.hallazgos.filter((h) => h.clave === "GEMINI_TRANSPORT")).toEqual([
      expect.objectContaining({ tipo: "difiere", detalle: "dev≠qa" }),
    ]);
  });

  it("con uno solo legible se evalúan las reglas fijas pero no hay con quién comparar", () => {
    const ilegible = leerRespuesta(0, null);
    const roto = { dev: lectura(base({ BASE_POR_CLIENTE: true, GEMINI_TRANSPORT: "vertex" })), qa: ilegible, prd: ilegible };

    expect(compararParidad(roto).hallazgos).toEqual([expect.objectContaining({ clave: "BASE_POR_CLIENTE", tipo: "regla", detalle: "dev" })]);
  });

  it("sin ninguno legible no hay hallazgos y están los tres ilegibles", () => {
    const sin = leerRespuesta(500, null);
    const r = compararParidad({ dev: sin, qa: sin, prd: sin });

    expect(r.hallazgos).toEqual([]);
    expect(r.ilegibles.map((i) => i.ambiente)).toEqual([...AMBIENTES]);
    expect(r.commits).toEqual({});
  });

  it("un ambiente que ni figura cuenta como sin respuesta", () => {
    expect(compararParidad({}).ilegibles).toEqual(AMBIENTES.map((ambiente) => ({ ambiente, motivo: "sin respuesta" })));
  });
});

describe("commitEsperado", () => {
  it.each([
    ["0123456789abcdef0123456789abcdef01234567", "0123456"],
    ["abc1234", "abc1234"],
    ["  abc1234def  ", "abc1234"],
  ])("%j es el commit %s", (sha, corto) => {
    expect(commitEsperado(sha)).toBe(corto);
  });

  it.each([undefined, "", "abc123", "ABCDEF1", "no es un sha"])("%j no es un commit: no se espera nada", (sha) => {
    expect(commitEsperado(sha)).toBeNull();
  });
});

describe("leerAmbiente: el alias de Vercel se mueve después del aviso del deploy", () => {
  const con = (commit: string) => lectura(base(), commit);
  // Una lectura por llamada; la última se repite.
  const secuencia = (...lecturas: ReturnType<typeof lectura>[]) => {
    let i = 0;
    return vi.fn(async () => lecturas[Math.min(i++, lecturas.length - 1)]);
  };
  const SIN_ESPERA = { intentos: 5, esperaMs: 0 };

  it("sin commit esperado lee una vez y devuelve lo que haya", async () => {
    const pedir = secuencia(con("1111111"));

    expect(await leerAmbiente(pedir, null, SIN_ESPERA)).toEqual(con("1111111"));
    expect(pedir).toHaveBeenCalledTimes(1);
  });

  it("si ya sirve el commit del deploy, lo devuelve enseguida", async () => {
    const pedir = secuencia(con("2222222"));

    expect(await leerAmbiente(pedir, "2222222", SIN_ESPERA)).toEqual(con("2222222"));
    expect(pedir).toHaveBeenCalledTimes(1);
  });

  it("si todavía sirve el build anterior, espera y devuelve la lectura del nuevo", async () => {
    const nueva = lectura(base({ MOCK_AI: true }), "2222222");
    const pedir = secuencia(con("1111111"), con("1111111"), nueva);

    expect(await leerAmbiente(pedir, "2222222", SIN_ESPERA)).toEqual(nueva);
    expect(pedir).toHaveBeenCalledTimes(3);
  });

  it("si nunca llega el commit, el ambiente queda ilegible: no compara el build viejo", async () => {
    const pedir = secuencia(con("1111111"));
    const r = await leerAmbiente(pedir, "2222222", SIN_ESPERA);

    expect(r).toEqual({ legible: false, motivo: "no sirve todavía el commit del deploy" });
    expect(pedir).toHaveBeenCalledTimes(5);
  });

  it("una lectura ilegible no se espera: otra no la arregla", async () => {
    const pedir = secuencia(leerRespuesta(401, null));

    expect(await leerAmbiente(pedir, "2222222", SIN_ESPERA)).toEqual({ legible: false, motivo: "sin permiso (401)" });
    expect(pedir).toHaveBeenCalledTimes(1);
  });

  it("un ambiente ilegible por el commit se avisa y los otros dos se comparan igual", async () => {
    const dev = await leerAmbiente(secuencia(con("1111111")), "2222222", SIN_ESPERA);
    const r = compararParidad({ ...ambientes({ MOCK_AI: true }), dev });

    expect(r.ilegibles).toEqual([{ ambiente: "dev", motivo: "no sirve todavía el commit del deploy" }]);
    expect(r.hallazgos.filter((h) => h.clave === "MOCK_AI")).toEqual([]);
  });
});

type Regla = {
  regla: string;
  motivo: string;
  de?: string;
  valores?: Record<string, unknown>;
  ambientes?: string[];
};
const REGLAS = Object.entries(EXCEPCIONES) as [string, Regla][];

describe("EXCEPCIONES", () => {
  it("está congelada hasta adentro: una regla no se cambia en caliente", () => {
    expect(Object.isFrozen(EXCEPCIONES)).toBe(true);
    for (const regla of Object.values(EXCEPCIONES) as Record<string, unknown>[]) {
      expect(Object.isFrozen(regla)).toBe(true);
      for (const valor of Object.values(regla)) if (typeof valor === "object") expect(Object.isFrozen(valor)).toBe(true);
    }
    expect(() => {
      (EXCEPCIONES as Record<string, unknown>).OTRA = {};
    }).toThrow(TypeError);
  });

  it("cada una dice de qué decisión sale", () => {
    for (const [, regla] of REGLAS) expect(regla.motivo).toMatch(/^D[267]: /);
  });

  it("sólo nombra claves que existen en banderas.ts", () => {
    for (const [clave, regla] of REGLAS) {
      expect(CLAVES, clave).toContain(clave);
      if (regla.de) expect(CLAVES, `${clave} -> ${regla.de}`).toContain(regla.de);
    }
  });

  it("usa sólo las reglas que el comparador sabe evaluar y ambientes que existen", () => {
    for (const [clave, regla] of REGLAS) {
      expect(["fijo", "entre", "implica-apagada"], clave).toContain(regla.regla);
      if (regla.valores) expect(Object.keys(regla.valores).sort(), clave).toEqual([...AMBIENTES].sort());
      if (regla.ambientes) for (const a of regla.ambientes) expect(AMBIENTES, clave).toContain(a);
    }
  });
});

describe("lineasDeParidad", () => {
  // Valores que no pueden aparecer en un log público.
  const MODO = "modo-centinela-xyz";
  const NUMERO = 987654;
  const lecturas = ambientes(
    { GEMINI_TRANSPORT: MODO, ALTA_TOPE_MB: NUMERO },
    { GEMINI_TRANSPORT: "vertex", ALTA_TOPE_MB: 2 },
    { GEMINI_TRANSPORT: "vertex", ALTA_TOPE_MB: 3 },
  );
  const paridad = compararParidad(lecturas);

  it("por omisión no muestra valores: ni en los avisos ni en el resumen", () => {
    for (const { avisos, resumen } of [lineasDeParidad(paridad), lineasDeParidad(paridad, { sinValores: true })]) {
      const todo = [...avisos, resumen].join(String.fromCharCode(10));

      expect(todo).not.toContain(MODO);
      expect(todo).not.toContain(String(NUMERO));
      expect(todo).toContain("ALTA_TOPE_MB");
      expect(todo).toContain("dev≠qa≠prd");
      expect(todo).toContain("dev≠qa=prd");
    }
  });

  it("cada aviso es una anotación de Actions con el título de la paridad", () => {
    const { avisos } = lineasDeParidad(paridad);

    expect(avisos.length).toBe(paridad.hallazgos.length);
    for (const a of avisos) expect(a.startsWith("::warning title=Paridad::")).toBe(true);
  });

  it("con `sinValores: false` el resumen trae los valores, pero los avisos no cambian", () => {
    const sin = lineasDeParidad(paridad, { sinValores: true });
    const con = lineasDeParidad(paridad, { sinValores: false });

    expect(con.resumen).toContain(`dev=${MODO}`);
    expect(con.resumen).toContain(`dev=${NUMERO} qa=2 prd=3`);
    expect(con.avisos).toEqual(sin.avisos);
  });

  it("sin hallazgos ni ilegibles no hay avisos: una línea informativa con los commits", () => {
    const { avisos, resumen } = lineasDeParidad(compararParidad(ambientes()));

    expect(avisos).toEqual([]);
    expect(resumen).toContain("sin diferencias");
    expect(resumen).toContain("commits: dev 1111111, qa 2222222, prd 3333333");
    expect(resumen).not.toContain("::warning");
  });

  it("un ambiente ilegible avisa aunque no haya diferencias", () => {
    const { avisos, resumen } = lineasDeParidad(compararParidad({ ...ambientes(), prd: leerRespuesta(401, null) }));

    expect(avisos).toEqual(["::warning title=Paridad::prd: ilegible (sin permiso (401))"]);
    expect(resumen).toContain("- prd: ilegible (sin permiso (401))");
  });

  it("un hallazgo con regla muestra su motivo", () => {
    const { avisos, resumen } = lineasDeParidad(compararParidad(ambientes({ BASE_POR_CLIENTE: true })));

    expect(avisos).toEqual([expect.stringContaining("BASE_POR_CLIENTE: regla (dev) — D2: ")]);
    expect(resumen).toContain("| BASE_POR_CLIENTE | regla | dev | D2: ");
  });

  it("nada de lo que entra puede cortar una anotación ni romper la tabla", () => {
    const CR = String.fromCharCode(13);
    const LF = String.fromCharCode(10);
    const hostil = {
      hallazgos: [
        {
          clave: `X::error::y%0A|z${LF}W`,
          tipo: "difiere",
          detalle: `a${CR}${LF}b ::: c`,
          motivo: `m${LF}n | o`,
          valores: { dev: 1 },
        },
      ],
      ilegibles: [{ ambiente: "dev", motivo: `x${LF}::error::y` }],
      commits: {},
    };
    const prefijo = "::warning title=Paridad::";

    for (const sinValores of [true, false]) {
      const { avisos, resumen } = lineasDeParidad(hostil, { sinValores });

      expect(avisos.length).toBe(2);
      for (const a of avisos) {
        expect(a).not.toMatch(/[\r\n]/);
        expect(a.startsWith(prefijo)).toBe(true);
        expect(a.slice(prefijo.length)).not.toMatch(/::|%|\|/);
      }
      const fila = resumen.split(LF).find((l) => l.startsWith("| X"));
      expect(fila).toBeDefined();
      expect(fila!.split("|").length - 1).toBe(sinValores ? 5 : 6);
    }
  });
});

describe("urlDePrd", () => {
  it.each([
    ["https://claimmix-prd.example.com", "https://claimmix-prd.example.com"],
    ["https://claimmix-prd.example.com/", "https://claimmix-prd.example.com"],
    ["  https://claimmix-prd.example.com  ", "https://claimmix-prd.example.com"],
    ["HTTPS://Claimmix-Prd.Example.com", "https://claimmix-prd.example.com"],
    ["https://claimmix.vercel.app", "https://claimmix.vercel.app"],
    ["https://claimmix-prd.vercel.app", "https://claimmix-prd.vercel.app"],
  ])("%j es el origen de prd: %s", (valor, origen) => {
    expect(urlDePrd(valor)).toBe(origen);
  });

  it.each<[string | undefined, string]>([
    ["http://claimmix-prd.example.com", "sin https"],
    ["https://usuario:clave@claimmix-prd.example.com", "con credenciales"],
    ["https://claimmix-prd.example.com:8443", "con puerto"],
    ["https://claimmix-prd.example.com/api", "con ruta"],
    ["https://claimmix-prd.example.com/?x=1", "con query"],
    ["https://claimmix-prd.example.com/#x", "con fragmento"],
    ["https://claimmix-dev.vercel.app", "es el host de dev"],
    ["https://claimmix-dev.vercel.app./", "es el host de dev con un punto final"],
    ["https://CLAIMMIX-QA.vercel.app", "es el host de QA"],
    ["https://claimmix-qa.vercel.app", "es el host de QA"],
    ["javascript:alert(1)", "no es https"],
    ["no es una url", "no se lee"],
    ["", "vacía"],
    [undefined, "sin definir"],
  ])("%j no es el origen de prd (%s)", (valor) => {
    expect(urlDePrd(valor)).toBeNull();
  });
});

describe("scripts/paridad.mjs, sin pegarle a nadie", () => {
  const dirs: string[] = [];
  afterAll(() => {
    for (const d of dirs) rmSync(d, { recursive: true, force: true });
  });

  const SIN_NADA = {
    CRON_SECRET: "",
    QA_CRON_SECRET: "",
    PRD_CRON_SECRET: "",
    PRD_URL: "",
    GITHUB_ACTIONS: "",
    GITHUB_STEP_SUMMARY: "",
  };

  // Sin secreto o sin URL válida el guión no hace ningún pedido, así que estas
  // corridas no usan la red.
  const correr = (env: Record<string, string>) =>
    spawnSync(process.execPath, ["scripts/paridad.mjs"], {
      cwd: ROOT,
      encoding: "utf8",
      timeout: 30_000,
      env: { ...process.env, ...SIN_NADA, ...env },
    });

  it("sin secretos dice que los tres son ilegibles y sale en verde", () => {
    const r = correr({});

    expect(r.status).toBe(0);
    for (const a of AMBIENTES) expect(r.stdout).toContain(`- ${a}: ilegible (falta el secreto)`);
  });

  it.each([
    ["una URL que no es https", "http://claimmix-prd.example.com"],
    ["la de dev", "https://claimmix-dev.vercel.app"],
    ["la de QA", "https://claimmix-qa.vercel.app"],
    ["una con ruta", "https://claimmix-prd.example.com/api"],
    ["ninguna", ""],
  ])("con PRD_CRON_SECRET y %s, el secreto de prd no se manda a ningún lado", (_caso, url) => {
    const secreto = "secreto-de-prueba-que-no-sale";
    const r = correr({ PRD_CRON_SECRET: secreto, PRD_URL: url });

    expect(r.status).toBe(0);
    expect(r.stdout).toContain("- prd: ilegible (PRD_URL vacía o inválida)");
    expect(r.stdout + r.stderr).not.toContain(secreto);
  });

  it("en Actions imprime los avisos y agrega el resumen al del run, siempre con salida 0", () => {
    const dir = mkdtempSync(join(tmpdir(), "paridad-"));
    dirs.push(dir);
    const resumen = join(dir, "resumen.md");
    const r = correr({ GITHUB_ACTIONS: "true", GITHUB_STEP_SUMMARY: resumen });

    expect(r.status).toBe(0);
    expect(r.stdout).toContain("::warning title=Paridad::dev: ilegible (falta el secreto)");
    expect(readFileSync(resumen, "utf8")).toContain("### Paridad de banderas");
  });

  it("fuera de Actions no imprime anotaciones", () => {
    expect(correr({}).stdout).not.toContain("::warning");
  });

  it("el código no corta el proceso, pide en modo estricto y no loguea el error crudo", () => {
    const fuente = readFileSync(join(ROOT, "scripts/paridad.mjs"), "utf8")
      .split(/\r?\n/)
      .filter((l) => !/^\s*(\/?\*|\/\/)/.test(l))
      .join(String.fromCharCode(10));

    expect(fuente).not.toMatch(/process\.exit\(/);
    expect(fuente).not.toContain("deep=1");
    // Sin redirecciones ni mensaje de error: lo garantiza `pedirSalud` en modo
    // `estricto` (se prueba en mirar-la-salud.test.ts), y acá se exige usarlo.
    expect(fuente).toMatch(/pedirSalud\(origen, secreto, \{[^}]*estricto: true/);
    expect(fuente).not.toContain("fetch(");
    // Todo `catch` es `catch {`: ninguno guarda el error.
    const capturas = [...fuente.matchAll(/\bcatch\b.{0,8}/g)].map((m) => m[0]);
    expect(capturas.length).toBeGreaterThan(0);
    for (const c of capturas) expect(c).toMatch(/^catch(?: \{|\(\(\) =>)/);
  });
});
