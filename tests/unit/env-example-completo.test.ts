/**
 * Guarda: `.env.example` lista toda variable de entorno que lee el código.
 *
 * Una variable que el código lee y la plantilla no nombra se descubre tarde: al
 * levantar un entorno nuevo, cuando el comportamiento ya cambió y nadie sabe de
 * qué perilla viene. Esta guarda recorre la raíz, `src/` y `scripts/`; los nombres que
 * sólo se arman en tiempo de ejecución se registran a mano en `DINAMICAS`.
 */

import { existsSync, readFileSync, readdirSync } from "fs";
import { join, resolve } from "path";

import { describe, expect, it } from "vitest";

const ROOT = resolve(__dirname, "../..");

/** Con `# NOMBRE=` también cuenta: las opcionales van comentadas. */
const LISTADAS = new Set(
  [
    ...readFileSync(join(ROOT, ".env.example"), "utf8").matchAll(
      /^#?[ \t]*([A-Z][A-Z0-9_]*)=/gm
    ),
  ].map((m) => m[1])
);

/** Las pone la plataforma o el runner, no una persona: no van en la plantilla. */
const DE_LA_PLATAFORMA: Record<string, string> = {
  NODE_ENV: "Next y vitest",
  VITEST: "vitest",
  VERCEL: "variables de sistema de Vercel",
  VERCEL_ENV: "variables de sistema de Vercel",
  VERCEL_URL: "variables de sistema de Vercel",
  VERCEL_GIT_COMMIT_SHA: "variables de sistema de Vercel",
  VERCEL_REGION: "variables de sistema de Vercel",
  CI: "GitHub Actions",
  NEXT_RUNTIME: "Next, en instrumentation.ts",
};
/** GitHub no deja definir secretos ni variables con este prefijo. */
const PREFIJO_DE_GITHUB = "GITHUB_";

const esDeLaPlataforma = (nombre: string) =>
  nombre in DE_LA_PLATAFORMA || nombre.startsWith(PREFIJO_DE_GITHUB);

/** Funciones del repo que leen una variable por el nombre que reciben como primer argumento. */
const LECTORES = [
  "entero",
  "getNumberEnv",
  "numberEnv",
  "clavePara",
  "leerDeEnvLocal",
];

/**
 * Archivos que leen `process.env[x]` con un `x` que no es un literal.
 * - lector: `x` llega de un lector de arriba, que ya se ve en sus llamadores.
 * - lista: `x` sale de una lista de nombres en el propio archivo.
 */
const DINAMICAS: Record<string, "lector" | "lista"> = {
  "src/lib/entero.ts": "lector",
  "src/server/ai/gemini-extractor.ts": "lector",
  "src/app/api/admin/provider-usage/route.ts": "lector",
  "src/server/intake/simulation-throttle.ts": "lector",
  "scripts/sembrar-para-integracion.mts": "lector",
  "src/app/api/health/route.ts": "lista",
  "src/lib/security/cifrado.ts": "lista",
  "src/server/alta/waba-propia-activa.ts": "lista",
  "src/server/gcp/credenciales.ts": "lista",
  "scripts/compare-schemas.mts": "lista",
  "scripts/create-app-role.mts": "lista",
  "scripts/lib/entorno-de-bases.mjs": "lista",
  "scripts/lib/hosts-vetados.mjs": "lista",
};

const DIRECTA =
  /process\.env(?:\?\.|\.)([A-Za-z_]\w*)|process\.env\[\s*(["'`])([A-Za-z_]\w*)\2\s*\]|\b(?:env|entorno)(?:\?\.|\.)([A-Z][A-Z0-9_]*)/g;
const POR_LECTOR = new RegExp(
  String.raw`\b(?:${LECTORES.join("|")})\(\s*(["'\x60])([A-Za-z_]\w*)\1`,
  "g"
);
const DINAMICA = /\b(?:process\.env|env|entorno)\[\s*(?!["'`])/;
/** Sin comillas invertidas: los comentarios citan las constantes así. */
const NOMBRE_EN_LISTA = /["']([A-Z][A-Z0-9]*(?:_[A-Z0-9]+)+)["']/g;

const EXTENSIONES = /\.(?:ts|tsx|mts|mjs|js)$/;
/** Lo genera el build del SDK de workflow y está en `.gitignore`: no es código del repo. */
const GENERADOS = ["src/app/.well-known/workflow/"];

function archivosDe(carpeta: string): string[] {
  return (
    readdirSync(join(ROOT, carpeta), {
      recursive: true,
      encoding: "utf8",
    }) as string[]
  )
    .map((f) => `${carpeta}/${f.split("\\").join("/")}`)
    .filter(
      (f) => EXTENSIONES.test(f) && !GENERADOS.some((g) => f.startsWith(g))
    );
}

/** Los de la raíz (configs e instrumentation.ts) también leen variables. */
const DE_LA_RAIZ = readdirSync(ROOT).filter((f) => EXTENSIONES.test(f));

const ARCHIVOS = [
  ...DE_LA_RAIZ,
  ...archivosDe("src"),
  ...archivosDe("scripts"),
];

const lecturas = new Map<string, string>();
const dinamicasSinRegistrar: string[] = [];

function anotar(nombre: string | undefined, archivo: string) {
  if (nombre && !lecturas.has(nombre)) lecturas.set(nombre, archivo);
}

for (const archivo of ARCHIVOS) {
  const txt = readFileSync(join(ROOT, archivo), "utf8");

  for (const m of txt.matchAll(DIRECTA)) anotar(m[1] ?? m[3] ?? m[4], archivo);
  for (const m of txt.matchAll(POR_LECTOR)) anotar(m[2], archivo);
  if (DINAMICAS[archivo] === "lista")
    for (const m of txt.matchAll(NOMBRE_EN_LISTA)) anotar(m[1], archivo);

  if (DINAMICA.test(txt) && !(archivo in DINAMICAS))
    dinamicasSinRegistrar.push(archivo);
}

describe(".env.example lista todo lo que el código lee", () => {
  it("ninguna lectura por nombre queda sin registrar", () => {
    expect(dinamicasSinRegistrar).toEqual([]);
  });

  it("las registradas siguen leyendo por nombre", () => {
    const sobran = Object.keys(DINAMICAS).filter(
      (f) =>
        !existsSync(join(ROOT, f)) ||
        !DINAMICA.test(readFileSync(join(ROOT, f), "utf8"))
    );

    expect(sobran).toEqual([]);
  });

  it("encuentra lecturas por cada camino", () => {
    expect(lecturas.has("DATABASE_URL_APP")).toBe(true);
    expect(lecturas.has("ALTA_TOPE_CORREOS_DIA")).toBe(true);
    expect(lecturas.has("GCP_PROJECT_NUMBER")).toBe(true);
    expect(lecturas.has("RETENCION_ANIOS")).toBe(true);
  });

  it("cada variable que lee el código está en .env.example", () => {
    const faltan = [...lecturas]
      .filter(([nombre]) => !LISTADAS.has(nombre) && !esDeLaPlataforma(nombre))
      .map(([nombre, archivo]) => `${nombre} (${archivo})`)
      .sort();

    expect(faltan).toEqual([]);
  });
});
