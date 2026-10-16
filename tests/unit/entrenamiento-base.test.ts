/**
 * La base del agente. Lo que se vigila: que el módulo generado diga lo mismo que
 * `entrenamiento/base/` (un .md editado sin volver a empaquetar es un agente con la
 * política vieja), que las secciones de prompt sean el texto que corre (los
 * `__prompts__` dorados), que las de sombra nombren las claves que el código usa de
 * verdad, y que el accesor sea núcleo puro.
 */

import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync, readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";

import { describe, expect, it } from "vitest";

import {
  ENTRENAMIENTO_BASE,
  VERSION_DEL_ENTRENAMIENTO_BASE as VERSION_GENERADA,
} from "@/core/agente/entrenamiento-base.generated";
import {
  VERSION_DEL_ENTRENAMIENTO_BASE,
  seccionesDelPaso,
  textoBase,
  textoDeSombra,
  type IdDeSeccion,
} from "@/core/agente/entrenamiento-base";
import { CAMPOS_REQUERIDOS_POR_RAMO } from "@/core/case/required-fields";
import { REQUIRED_CLAIM_FIELDS, REQUIRED_CONTACT_FIELDS } from "@/core/case/faltantes-requeridos";

const RAIZ = join(__dirname, "../..");
const PROMPTS = join(RAIZ, "tests/unit/__prompts__");

const GENERADO = readFileSync(join(RAIZ, "src/core/agente/entrenamiento-base.generated.ts"), "utf8");
const ACCESOR = readFileSync(join(RAIZ, "src/core/agente/entrenamiento-base.ts"), "utf8");

const PROMPTS_DORADOS = readdirSync(PROMPTS)
  .filter((f) => f.endsWith(".txt"))
  .map((f) => readFileSync(join(PROMPTS, f), "utf8").replace(/\r\n/g, "\n"));

describe("el módulo generado", () => {
  it("pnpm entrenamiento:empaquetar --comprobar da 0: el archivo está al día", () => {
    const r = spawnSync(process.execPath, ["scripts/empaquetar-entrenamiento.mjs", "--comprobar"], {
      cwd: RAIZ,
      encoding: "utf8",
    });

    expect(r.stderr).toBe("");
    expect(r.status).toBe(0);
  });

  it("no importa nada, ni node:fs", () => {
    expect(GENERADO).not.toMatch(/^\s*import\s/m);
    expect(GENERADO).not.toMatch(/node:|require\(/);
  });

  it("son 20 secciones y los ids no se repiten", () => {
    const ids = ENTRENAMIENTO_BASE.map((s) => s.id);

    expect(ids).toHaveLength(20);
    expect(new Set(ids).size).toBe(20);
  });

  it("el id es <paso>.<slug del archivo> y la ruta existe", () => {
    for (const s of ENTRENAMIENTO_BASE) {
      const archivo = s.ruta.split("/").pop() ?? "";

      expect(s.ruta).toBe(`entrenamiento/base/${s.paso}/${archivo}`);
      expect(s.id).toBe(`${s.paso}.${archivo.replace(/^\d{2}-/, "").replace(/\.md$/, "").replaceAll("-", "_")}`);
      expect(existsSync(join(RAIZ, s.ruta))).toBe(true);
    }
  });

  it("va por orden: extracción, decidir, redactar, y por nombre de archivo dentro de cada uno", () => {
    const rutas = ENTRENAMIENTO_BASE.map((s) => s.ruta);
    const ordenadas = ["extraccion", "decidir", "redactar"].flatMap((paso) =>
      rutas.filter((r) => r.startsWith(`entrenamiento/base/${paso}/`)).sort()
    );

    expect(rutas).toEqual(ordenadas);
  });

  it("toda sección de sombra tiene decision y ninguna de prompt la tiene", () => {
    for (const s of ENTRENAMIENTO_BASE) {
      if (s.modo === "sombra") {
        expect(s.decision, s.id).toBeDefined();
      } else {
        expect(s.decision, s.id).toBeUndefined();
      }
    }
  });

  it("los títulos están en español y en inglés", () => {
    for (const s of ENTRENAMIENTO_BASE) {
      expect(s.titulo["es-AR"].trim(), s.id).not.toBe("");
      expect(s.titulo["en-US"].trim(), s.id).not.toBe("");
    }
  });

  it("ningún texto tiene \\r ni queda vacío", () => {
    for (const s of ENTRENAMIENTO_BASE) {
      expect(s.texto, s.id).not.toContain("\r");
      expect(s.texto.trim(), s.id).not.toBe("");
      expect(GENERADO).not.toContain("\r");
    }
  });

  it("la versión son doce caracteres del sha256 de las secciones", () => {
    const esperada = createHash("sha256").update(JSON.stringify(ENTRENAMIENTO_BASE)).digest("hex").slice(0, 12);

    expect(VERSION_GENERADA).toMatch(/^[0-9a-f]{12}$/);
    expect(VERSION_GENERADA).toBe(esperada);
  });
});

describe("las secciones de prompt son el texto que corre", () => {
  const delPrompt = ENTRENAMIENTO_BASE.filter((s) => s.modo === "prompt");

  it("hay 16", () => {
    expect(delPrompt).toHaveLength(16);
  });

  it.each(delPrompt.map((s) => [s.id, s.texto] as const))("%s aparece tal cual en un prompt dorado", (_id, cuerpo) => {
    expect(PROMPTS_DORADOS.some((dorado) => dorado.includes(cuerpo))).toBe(true);
  });
});

describe("las secciones de sombra nombran lo que el código usa", () => {
  it("decidir.pedir nombra los requeridos, el contacto, los datos de cada ramo y el tope de 5", () => {
    const pedir = textoBase("decidir.pedir");
    const delRamo = new Set(Object.values(CAMPOS_REQUERIDOS_POR_RAMO).flat());

    for (const clave of [...REQUIRED_CLAIM_FIELDS, ...REQUIRED_CONTACT_FIELDS, ...delRamo]) {
      expect(pedir, clave).toContain(clave);
    }
    expect(pedir).toMatch(/\b5\b/);
  });

  it("extraccion.derivar nombra heridos, muerte, póliza vencida y titular", () => {
    const derivar = textoBase("extraccion.derivar");

    for (const palabra of ["heridos", "muerte", "vencida", "titular"]) {
      expect(derivar, palabra).toContain(palabra);
    }
  });

  it("decidir.responder nombra las siete salidas", () => {
    const responder = textoBase("decidir.responder");

    for (const salida of ["pedir", "contestar", "cerrar", "acusar", "avisar", "callar", "derivar"]) {
      expect(responder, salida).toContain(salida);
    }
  });

  it("hay una sección de sombra por decisión", () => {
    const decisiones = ENTRENAMIENTO_BASE.filter((s) => s.modo === "sombra").map((s) => s.decision);

    expect([...decisiones].sort()).toEqual(["derivar", "gravedad", "pedir", "responder"]);
  });
});

describe("el accesor", () => {
  it("textoBase devuelve el texto de la sección", () => {
    for (const s of ENTRENAMIENTO_BASE) {
      expect(textoBase(s.id)).toBe(s.texto);
    }
  });

  it("textoBase tira con un id que no existe", () => {
    expect(() => textoBase("extraccion.no_existe" as IdDeSeccion)).toThrow(
      "Sección de entrenamiento desconocida: extraccion.no_existe"
    );
  });

  it("seccionesDelPaso trae las de ese paso en el orden del módulo", () => {
    for (const paso of ["extraccion", "decidir", "redactar"] as const) {
      expect(seccionesDelPaso(paso)).toEqual(ENTRENAMIENTO_BASE.filter((s) => s.paso === paso));
    }
    expect(seccionesDelPaso("extraccion")).toHaveLength(10);
    expect(seccionesDelPaso("decidir")).toHaveLength(4);
    expect(seccionesDelPaso("redactar")).toHaveLength(6);
  });

  it("textoDeSombra une las cuatro con una línea en blanco, y con decisiones sólo esas", () => {
    const sombra = ENTRENAMIENTO_BASE.filter((s) => s.modo === "sombra");

    expect(textoDeSombra()).toBe(sombra.map((s) => s.texto).join("\n\n"));
    expect(textoDeSombra(["pedir"])).toBe(textoBase("decidir.pedir"));
    expect(textoDeSombra(["gravedad", "derivar"])).toBe(
      [textoBase("extraccion.gravedad_del_codigo"), textoBase("extraccion.derivar")].join("\n\n")
    );
    expect(textoDeSombra([])).toBe("");
  });

  it("textoDeSombra no trae texto de prompt", () => {
    const sombra = textoDeSombra();

    for (const s of ENTRENAMIENTO_BASE.filter((x) => x.modo === "prompt")) {
      expect(sombra, s.id).not.toContain(s.texto);
    }
  });

  it("reexporta la versión del generado", () => {
    expect(VERSION_DEL_ENTRENAMIENTO_BASE).toBe(VERSION_GENERADA);
  });

  it("es núcleo puro: ni entorno, ni server-only, ni next", () => {
    expect(ACCESOR).not.toMatch(/process\.env|server-only|from "next|node:/);
  });
});
