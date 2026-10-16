/**
 * El núcleo del modo sombra. Lo que se vigila: que a la base sólo viajen claves
 * con forma de campo (nunca un nombre ni un DNI), que la comparación entre agente
 * y código sea la que dice el plano, que `bajaElPiso` se dispare sólo cuando el
 * agente suelta lo que el código no suelta, y que el umbral sea exacto en el borde.
 */

import { readFileSync } from "node:fs";
import { join } from "node:path";

import { describe, expect, it } from "vitest";

import {
  MINIMO_DE_COMPARACIONES,
  UMBRAL_DE_COINCIDENCIA,
  bajaElPiso,
  clavesSeguras,
  coincide,
  conteoVacio,
  cumpleElUmbral,
  gravedadSegura,
  lineaDeSombra,
  normalizarFaltantes,
  respuestaDelAgente,
  respuestaDelCodigo,
  resumenDeSombra,
  sombraDeLaExtraccion,
  sumarSombra,
  type ConteoDeSombra,
  type SombraDeLaVuelta,
} from "@/core/agente/sombra";
import type { QueHacer } from "@/core/case/reply-decision";

const FUENTE = readFileSync(join(__dirname, "../../src/core/agente/sombra.ts"), "utf8");

describe("clavesSeguras", () => {
  it("descarta un nombre con DNI, una clave de 41 caracteres y lo que no es texto", () => {
    const larga = "a".repeat(41);
    expect(
      clavesSeguras(["Juan Pérez 30123456", larga, "dni", 7, null, undefined, { a: 1 }, ["dni"], "Dni", "con-guion"])
    ).toEqual(["dni"]);
  });

  it("acepta el largo máximo de 40 y el mínimo de 1", () => {
    expect(clavesSeguras(["a".repeat(40), "b", ""])).toEqual(["a".repeat(40), "b"]);
  });

  it("saca repetidos y deja como mucho 10, en el orden de entrada", () => {
    const doce = Array.from({ length: 12 }, (_, i) => `campo_${i}`);
    expect(clavesSeguras([...doce, "campo_0"])).toEqual(doce.slice(0, 10));
    expect(clavesSeguras(["dni", "patente", "dni"])).toEqual(["dni", "patente"]);
  });

  it("no cuenta los descartados contra el tope", () => {
    const basura = Array.from({ length: 5 }, (_, i) => `Nombre Apellido ${i}`);
    const buenas = Array.from({ length: 10 }, (_, i) => `campo_${i}`);
    expect(clavesSeguras([...basura, ...buenas])).toEqual(buenas);
  });
});

describe("normalizarFaltantes", () => {
  it("lleva los alias a la clave canónica y ordena", () => {
    expect(normalizarFaltantes(["heridos", "dni", "injury_severity", "lugar_siniestro"])).toEqual([
      "accident_location",
      "dni",
      "hay_heridos",
    ]);
  });

  it("descarta lo que no es una clave segura, también después de canonicalizar", () => {
    expect(normalizarFaltantes(["Juan Pérez 30123456", 5, null, "patente", "a".repeat(41)])).toEqual(["patente"]);
  });

  it("ordena igual sin importar cómo vengan", () => {
    expect(normalizarFaltantes(["patente", "dni", "poliza"])).toEqual(normalizarFaltantes(["poliza", "patente", "dni"]));
  });
});

describe("gravedadSegura", () => {
  it.each(["low", "medium", "high", "critical"] as const)("deja pasar %s", (g) => {
    expect(gravedadSegura(g)).toBe(g);
  });

  it.each([["HIGH"], ["grave"], [""], [null], [undefined], [3], [true], [{}]])("%j da null", (v) => {
    expect(gravedadSegura(v)).toBeNull();
  });
});

describe("sombraDeLaExtraccion", () => {
  it("arma gravedad y derivar con la opinión cruda del modelo y la decisión del código", () => {
    expect(
      sombraDeLaExtraccion(
        { severity: "low", requires_specialist: false },
        { gravedad: "high", deriva: true, piso: true }
      )
    ).toEqual({
      v: 1,
      gravedad: { agente: "low", codigo: "high" },
      derivar: { agente: false, codigo: true, piso: true },
    });
  });

  it("deja en null lo que el modelo no devolvió bien", () => {
    const s = sombraDeLaExtraccion(
      { severity: "terrible", requires_specialist: "sí" },
      { gravedad: "medium", deriva: false, piso: false }
    );
    expect(s.gravedad).toEqual({ agente: null, codigo: "medium" });
    expect(s.derivar).toEqual({ agente: null, codigo: false, piso: false });
  });

  it("no tiene pedir ni responder: los anota el orquestador después", () => {
    const s = sombraDeLaExtraccion({ severity: "low", requires_specialist: false }, { gravedad: "low", deriva: false, piso: false });
    expect(s).not.toHaveProperty("pedir");
    expect(s).not.toHaveProperty("responder");
  });
});

describe("respuestaDelAgente", () => {
  it.each([
    ["ask", "pedir"],
    ["answer_and_ask", "pedir"],
    ["answer", "contestar"],
    ["acknowledge", "cerrar"],
    ["escalate", "derivar"],
    ["wait", "callar"],
    ["otra_cosa", null],
    ["", null],
    ["ASK", null],
    [null, null],
    [undefined, null],
  ] as const)("%j da %j", (intent, esperado) => {
    expect(respuestaDelAgente(intent)).toBe(esperado);
  });
});

describe("respuestaDelCodigo", () => {
  const sin = { enEspera: false, nosPreguntoAlgo: false };

  it.each([
    ["pedir", sin, "pedir"],
    ["pedir", { enEspera: true, nosPreguntoAlgo: true }, "pedir"],
    ["acusar-recibo", sin, "acusar"],
    ["avisar-que-no-entro", sin, "avisar"],
    ["avisar-que-no-entro", { enEspera: true, nosPreguntoAlgo: true }, "avisar"],
    ["callar", { enEspera: true, nosPreguntoAlgo: false }, "callar"],
    ["callar", { enEspera: true, nosPreguntoAlgo: true }, "callar"],
    ["callar", { enEspera: false, nosPreguntoAlgo: true }, "contestar"],
    ["callar", { enEspera: false, nosPreguntoAlgo: false }, "cerrar"],
  ] as const)("%s con %j da %s", (q, senales, esperado) => {
    expect(respuestaDelCodigo(q satisfies QueHacer, senales)).toBe(esperado);
  });
});

describe("coincide", () => {
  const vuelta = (parte: Omit<SombraDeLaVuelta, "v">): SombraDeLaVuelta => ({ v: 1, ...parte });

  it("compara gravedad, derivar y responder por igualdad", () => {
    const s = vuelta({
      gravedad: { agente: "low", codigo: "low" },
      derivar: { agente: true, codigo: false, piso: false },
      responder: { agente: "pedir", codigo: "pedir", rechazo: null },
    });
    expect(coincide(s, "gravedad")).toBe(true);
    expect(coincide(s, "derivar")).toBe(false);
    expect(coincide(s, "responder")).toBe(true);
  });

  it("compara pedir como conjunto, sin importar el orden ni los repetidos", () => {
    const pedir = (agente: string[] | null, codigo: string[] | null) =>
      vuelta({ pedir: { agente, codigo, descartadas: 0 } });
    expect(coincide(pedir(["dni", "patente"], ["patente", "dni"]), "pedir")).toBe(true);
    expect(coincide(pedir(["dni", "dni"], ["dni"]), "pedir")).toBe(true);
    expect(coincide(pedir(["dni"], ["dni", "patente"]), "pedir")).toBe(false);
    expect(coincide(pedir(["dni", "poliza"], ["dni", "patente"]), "pedir")).toBe(false);
    expect(coincide(pedir([], []), "pedir")).toBe(true);
    expect(coincide(pedir([], ["dni"]), "pedir")).toBe(false);
  });

  it("da null cuando falta la opinión de alguno de los dos lados", () => {
    expect(coincide(vuelta({ gravedad: { agente: null, codigo: "low" } }), "gravedad")).toBeNull();
    expect(coincide(vuelta({ derivar: { agente: false, codigo: null, piso: false } }), "derivar")).toBeNull();
    expect(coincide(vuelta({ pedir: { agente: null, codigo: ["dni"], descartadas: 0 } }), "pedir")).toBeNull();
    expect(coincide(vuelta({ responder: { agente: null, codigo: "pedir", rechazo: null } }), "responder")).toBeNull();
  });

  it("da null cuando la decisión no se anotó", () => {
    const s = vuelta({});
    for (const d of ["gravedad", "derivar", "pedir", "responder"] as const) expect(coincide(s, d)).toBeNull();
  });

  it("da null con responder avisar, aunque el agente conteste algo", () => {
    for (const agente of ["pedir", "callar", "avisar"] as const) {
      expect(coincide(vuelta({ responder: { agente, codigo: "avisar", rechazo: null } }), "responder")).toBeNull();
    }
  });
});

describe("bajaElPiso", () => {
  const derivar = (agente: boolean | null, codigo: boolean | null, piso: boolean): SombraDeLaVuelta => ({
    v: 1,
    derivar: { agente, codigo, piso },
  });

  it.each([
    [false, true, true, true],
    [false, true, false, false],
    [true, true, true, false],
    [null, true, true, false],
    [true, false, false, false],
    [false, false, false, false],
  ] as const)("agente %j, código %j, piso %j: %j", (agente, codigo, piso, esperado) => {
    expect(bajaElPiso(derivar(agente, codigo, piso))).toBe(esperado);
  });

  it("una diferencia de gravedad sola no lo baja", () => {
    expect(
      bajaElPiso({
        v: 1,
        gravedad: { agente: "low", codigo: "critical" },
        derivar: { agente: true, codigo: true, piso: true },
      })
    ).toBe(false);
  });

  it("sin derivar anotado no baja nada", () => {
    expect(bajaElPiso({ v: 1 })).toBe(false);
    expect(bajaElPiso({ v: 1, gravedad: { agente: "low", codigo: "critical" } })).toBe(false);
  });
});

describe("lineaDeSombra", () => {
  it("es exacta para el ejemplo del plano", () => {
    expect(
      lineaDeSombra({
        v: 1,
        gravedad: { agente: "high", codigo: "high" },
        derivar: { agente: false, codigo: true, piso: true },
        pedir: { agente: null, codigo: ["dni"], descartadas: 0 },
        responder: { agente: "derivar", codigo: "sin_derivar", rechazo: null },
      })
    ).toBe(
      "gravedad = · derivar ≠ (agente: no · código: sí) · pedir ? · responder ≠ (agente: derivar · código: sin_derivar) · BAJA EL PISO"
    );
  });

  it("omite lo que falta y no agrega nada al final sin piso", () => {
    expect(lineaDeSombra({ v: 1, gravedad: { agente: "low", codigo: "low" } })).toBe("gravedad =");
    expect(lineaDeSombra({ v: 1, responder: { agente: "pedir", codigo: "pedir", rechazo: null } })).toBe("responder =");
    expect(lineaDeSombra({ v: 1 })).toBe("");
  });

  it("muestra las listas con coma, y el guion largo si están vacías", () => {
    expect(
      lineaDeSombra({ v: 1, pedir: { agente: ["dni", "patente"], codigo: ["poliza"], descartadas: 1 } })
    ).toBe("pedir ≠ (agente: dni, patente · código: poliza)");
    expect(lineaDeSombra({ v: 1, pedir: { agente: [], codigo: ["dni"], descartadas: 0 } })).toBe(
      "pedir ≠ (agente: — · código: dni)"
    );
    expect(lineaDeSombra({ v: 1, pedir: { agente: ["dni"], codigo: [], descartadas: 0 } })).toBe(
      "pedir ≠ (agente: dni · código: —)"
    );
    expect(lineaDeSombra({ v: 1, pedir: { agente: [], codigo: [], descartadas: 0 } })).toBe("pedir =");
  });

  it("muestra gravedad distinta con los dos valores", () => {
    expect(lineaDeSombra({ v: 1, gravedad: { agente: "low", codigo: "high" } })).toBe(
      "gravedad ≠ (agente: low · código: high)"
    );
  });

  it("agrega el rechazo después de responder, con igualdad, diferencia o sin comparar", () => {
    expect(lineaDeSombra({ v: 1, responder: { agente: "pedir", codigo: "pedir", rechazo: "invented" } })).toBe(
      "responder = [rechazo: invented]"
    );
    expect(lineaDeSombra({ v: 1, responder: { agente: "pedir", codigo: "cerrar", rechazo: "ask_without_items" } })).toBe(
      "responder ≠ (agente: pedir · código: cerrar) [rechazo: ask_without_items]"
    );
    expect(lineaDeSombra({ v: 1, responder: { agente: "pedir", codigo: "avisar", rechazo: "otro" } })).toBe(
      "responder ? [rechazo: otro]"
    );
  });

  it("pone BAJA EL PISO al final, también si es lo único que sale", () => {
    expect(lineaDeSombra({ v: 1, derivar: { agente: false, codigo: true, piso: true } })).toBe(
      "derivar ≠ (agente: no · código: sí) · BAJA EL PISO"
    );
  });
});

describe("sumarSombra", () => {
  const completa: SombraDeLaVuelta = {
    v: 1,
    gravedad: { agente: "low", codigo: "low" },
    derivar: { agente: false, codigo: true, piso: true },
    pedir: { agente: null, codigo: ["dni"], descartadas: 0 },
    responder: { agente: "pedir", codigo: "avisar", rechazo: null },
  };

  it("acumula iguales, distintas y sin opinión por decisión, y las vueltas que bajan el piso", () => {
    const c = sumarSombra(sumarSombra(conteoVacio(), completa), completa);
    expect(c).toEqual({
      vueltas: 2,
      bajaElPiso: 2,
      porDecision: {
        gravedad: { iguales: 2, distintas: 0, sinOpinion: 0 },
        derivar: { iguales: 0, distintas: 2, sinOpinion: 0 },
        pedir: { iguales: 0, distintas: 0, sinOpinion: 2 },
        responder: { iguales: 0, distintas: 0, sinOpinion: 2 },
      },
    });
  });

  it("cuenta como sin opinión la decisión que la vuelta no anotó", () => {
    const c = sumarSombra(conteoVacio(), { v: 1 });
    expect(c.vueltas).toBe(1);
    for (const d of ["gravedad", "derivar", "pedir", "responder"] as const) {
      expect(c.porDecision[d]).toEqual({ iguales: 0, distintas: 0, sinOpinion: 1 });
    }
  });

  it("no muta el conteo que recibe ni la vuelta", () => {
    const antes = conteoVacio();
    const copiaAntes = structuredClone(antes);
    const copiaVuelta = structuredClone(completa);
    const despues = sumarSombra(antes, completa);
    expect(antes).toEqual(copiaAntes);
    expect(completa).toEqual(copiaVuelta);
    expect(despues).not.toBe(antes);
    expect(despues.porDecision).not.toBe(antes.porDecision);
    expect(despues.porDecision.gravedad).not.toBe(antes.porDecision.gravedad);
  });

  it("por cada decisión, iguales + distintas + sin opinión da las vueltas", () => {
    const vueltas: SombraDeLaVuelta[] = [
      completa,
      { v: 1, gravedad: { agente: "low", codigo: "high" } },
      { v: 1 },
      { v: 1, pedir: { agente: ["dni"], codigo: ["dni"], descartadas: 0 } },
    ];
    const c = vueltas.reduce(sumarSombra, conteoVacio());
    for (const d of ["gravedad", "derivar", "pedir", "responder"] as const) {
      const { iguales, distintas, sinOpinion } = c.porDecision[d];
      expect(iguales + distintas + sinOpinion).toBe(c.vueltas);
    }
  });
});

describe("resumenDeSombra", () => {
  it("arma la línea del plano con porcentaje redondeado", () => {
    const c: ConteoDeSombra = {
      vueltas: 30,
      bajaElPiso: 0,
      porDecision: {
        gravedad: { iguales: 24, distintas: 2, sinOpinion: 4 },
        derivar: { iguales: 26, distintas: 0, sinOpinion: 4 },
        pedir: { iguales: 1, distintas: 2, sinOpinion: 0 },
        responder: { iguales: 0, distintas: 0, sinOpinion: 30 },
      },
    };
    expect(resumenDeSombra(c)).toBe(
      "Sombra (no cuenta para el resultado): gravedad 24/26 (92 %) · derivar 26/26 (100 %) · pedir 1/3 (33 %) · responder 0/0 (— %) · sin opinión: 38 · baja el piso: 0 · umbral 95 % con 100 comparaciones"
    );
  });

  it("con el conteo vacío no divide por cero", () => {
    expect(resumenDeSombra(conteoVacio())).toBe(
      "Sombra (no cuenta para el resultado): gravedad 0/0 (— %) · derivar 0/0 (— %) · pedir 0/0 (— %) · responder 0/0 (— %) · sin opinión: 0 · baja el piso: 0 · umbral 95 % con 100 comparaciones"
    );
  });

  it("cuenta las vueltas que bajan el piso", () => {
    const c = sumarSombra(conteoVacio(), { v: 1, derivar: { agente: false, codigo: true, piso: true } });
    expect(resumenDeSombra(c)).toContain("baja el piso: 1");
  });
});

describe("cumpleElUmbral", () => {
  const con = (iguales: number, distintas: number, bajaElPiso = 0): ConteoDeSombra => {
    const c = conteoVacio();
    c.bajaElPiso = bajaElPiso;
    c.porDecision.gravedad = { iguales, distintas, sinOpinion: 0 };
    return c;
  };

  it("usa las constantes del plano", () => {
    expect(UMBRAL_DE_COINCIDENCIA).toBe(0.95);
    expect(MINIMO_DE_COMPARACIONES).toBe(100);
  });

  it("cumple justo en 100 comparaciones y 95 %", () => {
    expect(cumpleElUmbral(con(95, 5), "gravedad")).toBe(true);
  });

  it("no cumple con 99 comparaciones aunque coincidan todas", () => {
    expect(cumpleElUmbral(con(99, 0), "gravedad")).toBe(false);
  });

  it("no cumple con 94 de 100", () => {
    expect(cumpleElUmbral(con(94, 6), "gravedad")).toBe(false);
  });

  it("cumple en el borde con más comparaciones: 190 de 200", () => {
    expect(cumpleElUmbral(con(190, 10), "gravedad")).toBe(true);
    expect(cumpleElUmbral(con(189, 11), "gravedad")).toBe(false);
  });

  it("un solo BAJA EL PISO lo impide, aunque coincida al 100 %", () => {
    expect(cumpleElUmbral(con(100, 0), "gravedad")).toBe(true);
    expect(cumpleElUmbral(con(100, 0, 1), "gravedad")).toBe(false);
  });

  it("no cuenta las vueltas sin opinión y mide cada decisión por separado", () => {
    const c = con(95, 5);
    c.porDecision.gravedad.sinOpinion = 500;
    expect(cumpleElUmbral(c, "gravedad")).toBe(true);
    expect(cumpleElUmbral(c, "derivar")).toBe(false);
  });

  it("con el conteo vacío no cumple", () => {
    for (const d of ["gravedad", "derivar", "pedir", "responder"] as const) {
      expect(cumpleElUmbral(conteoVacio(), d)).toBe(false);
    }
  });
});

describe("el módulo es núcleo puro", () => {
  it("no toca el entorno, el servidor ni next", () => {
    expect(FUENTE).not.toMatch(/process\.env/);
    expect(FUENTE).not.toMatch(/@\/server/);
    expect(FUENTE).not.toMatch(/from "next/);
    expect(FUENTE).not.toMatch(/server-only/);
  });
});
