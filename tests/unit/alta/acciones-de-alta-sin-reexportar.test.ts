/**
 * Las acciones del alta no publican la lógica del alta.
 *
 * Un archivo con "use server" convierte TODOS sus exports en endpoints que cualquiera
 * puede llamar con un POST. `crearEspacio` toma cupos y escribe en la base, y
 * `crearCuentaDelEnlace` crea la cuenta: por eso viven en módulos de servidor
 * sin la directiva, y las acciones (`crearMiEspacio`, `crearCuentaDesdeCorreo`)
 * son envoltorios finos que primero miran la sesión o abren el enlace.
 *
 * Se lee el código como texto: no hay forma de probar con un import que un export NO
 * esté publicado. Por eso no alcanza con buscar los nombres de la lógica: un alias
 * (`export const otra = crearEspacio`) o un envoltorio (`export async function otra(x)
 * { return crearEspacio(x); }`) la publica con otro nombre. Cada archivo tiene su lista
 * exacta de exports, y la lógica sólo la nombra quien debe llamarla.
 */

import { readdirSync, readFileSync, statSync } from "node:fs";
import { join, relative } from "node:path";

import { describe, expect, it } from "vitest";

const RAIZ = join(__dirname, "..", "..", "..");
const SRC = join(RAIZ, "src");

const TODO_DE_LA_LOGICA = /export\s*\*[^;]*from\s*["'][^"']*alta\/(?:crear-espacio|cuenta-del-enlace)["']/;
const MODULOS_DE_LA_LOGICA = ["alta/crear-espacio", "alta/cuenta-del-enlace"];
const LOGICA = /\b(crearEspacio|crearCuentaDelEnlace|prepararEspacio)\b/g;

/** Lo único que cada acción del alta publica. Todo export de un archivo "use server" es un endpoint: sumar uno es una decisión. */
const EXPORTS_PERMITIDOS: Record<string, string[]> = {
  "src/app/alta/actions.ts": ["crearMiEspacio"],
  "src/app/alta/correo/actions.ts": ["crearCuentaDesdeCorreo"],
  "src/app/registro/actions.ts": ["empezarAltaConGoogle", "signUp"],
};

/** Quién puede nombrar cada pieza de la lógica desde un archivo "use server". */
const LA_LLAMA: Record<string, string> = {
  "src/app/alta/actions.ts": "crearEspacio",
  "src/app/alta/correo/actions.ts": "crearCuentaDelEnlace",
};

/** Los nombres de valor que publica un archivo, con el alias con que salen: `export function f`, `export const f =`, `export { a as b }`, `export default`. Los tipos no cuentan. */
function exportados(texto: string): string[] {
  const directos = [...texto.matchAll(/^export\s+(?:async\s+)?(?:function\*?|const|let|var|class)\s+(\w+)/gm)].map((m) => m[1]);
  const enListas = [...texto.matchAll(/^export\s*\{([^}]*)\}/gm)].flatMap((m) =>
    m[1]
      .split(",")
      .map((x) => x.trim())
      .filter((x) => x !== "" && !x.startsWith("type "))
      .map((x) => x.split(/\s+as\s+/).at(-1) as string)
  );
  const porDefecto = /^export\s+default\b/m.test(texto) ? ["default"] : [];
  return [...directos, ...enListas, ...porDefecto].sort();
}

function archivos(dir: string): string[] {
  return readdirSync(dir).flatMap((nombre) => {
    const ruta = join(dir, nombre);
    if (statSync(ruta).isDirectory()) return archivos(ruta);
    return /\.(ts|tsx)$/.test(nombre) ? [ruta] : [];
  });
}

const leer = (ruta: string) => readFileSync(join(RAIZ, ruta), "utf8").replace(/\r\n/g, "\n");

/** La directiva, no un comentario que la nombra. */
const TIENE_USE_SERVER = /^\s*["']use server["'];?\s*$/m;

const enAcciones = archivos(SRC)
  .map((ruta) => ({ ruta: relative(RAIZ, ruta).replace(/\\/g, "/"), texto: readFileSync(ruta, "utf8").replace(/\r\n/g, "\n") }))
  .filter(({ texto }) => TIENE_USE_SERVER.test(texto));

describe("los archivos con \"use server\"", () => {
  it("hay acciones del alta que revisar (si no, esta prueba no mira nada)", () => {
    const rutas = enAcciones.map((a) => a.ruta);
    expect(rutas).toContain("src/app/alta/actions.ts");
    expect(rutas).toContain("src/app/alta/correo/actions.ts");
    expect(rutas).toContain("src/app/registro/actions.ts");
  });

  it("la expresión reconoce el `export *` de los módulos de la lógica (si no, la prueba de abajo pasaría vacía)", () => {
    expect(TODO_DE_LA_LOGICA.test('export * from "@/server/alta/crear-espacio";')).toBe(true);
    expect(TODO_DE_LA_LOGICA.test('export * from "@/server/alta/cuenta-del-enlace"')).toBe(true);
    expect(TODO_DE_LA_LOGICA.test('export * from "@/server/alta/validar";')).toBe(false);
  });

  it("`exportados` ve los alias y los envoltorios (si no, la lista exacta de abajo pasaría vacía)", () => {
    expect(exportados("export const publicada = crearEspacio;")).toEqual(["publicada"]);
    expect(exportados("export async function otra(x: unknown) {\n  return crearEspacio(x);\n}")).toEqual(["otra"]);
    expect(exportados("export { crearEspacio as otra, type Tipo, b };")).toEqual(["b", "otra"]);
    expect(exportados("export default crearEspacio;")).toEqual(["default"]);
    expect(exportados("export type Tipo = string;\nexport interface Otro {}\nasync function privada() {}")).toEqual([]);
  });

  it.each(Object.keys(EXPORTS_PERMITIDOS))("%s publica sólo lo permitido: ni alias, ni envoltorios, ni `export *`", (ruta) => {
    const texto = leer(ruta);

    expect(exportados(texto)).toEqual([...EXPORTS_PERMITIDOS[ruta]].sort());
    expect(texto).not.toMatch(/^export\s*\*/m);
  });

  it("ningún archivo \"use server\" nombra la lógica del alta salvo quien la llama", () => {
    const sobrantes = enAcciones.flatMap(({ ruta, texto }) =>
      [...new Set([...texto.matchAll(LOGICA)].map((m) => m[1]))]
        .filter((nombre) => LA_LLAMA[ruta] !== nombre)
        .map((nombre) => `${ruta}: ${nombre}`)
    );

    expect(sobrantes).toEqual([]);
  });

  it("ninguno re-exporta todo de los módulos de la lógica del alta", () => {
    const culpables = enAcciones.filter(({ texto }) => TODO_DE_LA_LOGICA.test(texto)).map((a) => a.ruta);

    expect(culpables).toEqual([]);
  });

  it("la acción del enlace del correo no toca los cupos ni crea el inquilino por su cuenta", () => {
    const texto = leer("src/app/alta/correo/actions.ts");

    expect(texto).not.toMatch(/\bcrearInquilino\b/);
    expect(texto).not.toMatch(/\btomarCupoDeAlta\b/);
    expect(texto).not.toMatch(/\bsoltarCupoDeAlta\b/);
  });

  it("la acción de /alta delega en `crearEspacio` y no toma el cupo ni llama a la función de la base", () => {
    const texto = leer("src/app/alta/actions.ts");

    expect(texto).toMatch(/from "@\/server\/alta\/crear-espacio"/);
    expect(texto).not.toMatch(/\bcrearInquilino\b/);
    expect(texto).not.toMatch(/\btomarCupoDeAlta\b/);
    expect(texto).not.toMatch(/\bsoltarCupoDeAlta\b/);
  });
});

describe.each(MODULOS_DE_LA_LOGICA.map((m) => `src/server/${m}.ts`))("%s", (ruta) => {
  const texto = leer(ruta);

  it("es un módulo de servidor: empieza con `import \"server-only\"`", () => {
    const sinComentarioInicial = texto.replace(/^\/\*\*[\s\S]*?\*\/\s*/, "");

    expect(sinComentarioInicial.startsWith('import "server-only";')).toBe(true);
  });

  it("no lleva la directiva \"use server\"", () => {
    expect(TIENE_USE_SERVER.test(texto)).toBe(false);
  });
});

describe("crear-espacio.ts", () => {
  const texto = leer("src/server/alta/crear-espacio.ts");
  /** Sin comentarios: los de este archivo explican justamente que `after()` y `redirect()` no van acá. */
  const codigo = texto.replace(/\/\*[\s\S]*?\*\//g, "").replace(/^\s*\/\/.*$/gm, "");

  it("no sabe de cookies ni de encabezados, ni redirige, ni usa `after()`: eso es de la acción", () => {
    expect(codigo).not.toMatch(/from "next\/headers"/);
    expect(codigo).not.toMatch(/from "next\/navigation"/);
    expect(codigo).not.toMatch(/from "next\/server"/);
    expect(codigo).not.toMatch(/\bredirect\(/);
    expect(codigo).not.toMatch(/\bafter\(/);
  });

  it("no mira la sesión: la acción ya la miró y le pasa el usuario", () => {
    expect(texto).not.toMatch(/getSessionContext/);
  });
});
