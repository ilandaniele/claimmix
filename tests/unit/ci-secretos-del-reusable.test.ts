import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";

// Un secreto de `workflow_call` declarado `required: false` llega vacío, sin
// error, si el caller se olvida de mapearlo. Con `secrets: inherit` eso no
// pasaba; con el mapeo uno por uno, este test es el que lo frena.
const sinComentarios = (nombre: string) =>
  readFileSync(resolve(process.cwd(), ".github/workflows", nombre), "utf8")
    .split(/\r?\n/)
    .map((l) => l.replace(/(^|\s)#.*$/, "$1"))
    .join("\n");

// Las líneas de un job: desde `  id:` hasta el siguiente job.
const cuerpoDe = (yml: string, id: string) => {
  const lineas = yml.split("\n");
  const i = lineas.findIndex((l) => l === `  ${id}:`);
  expect(i).toBeGreaterThan(-1);
  const fin = lineas.findIndex((l, k) => k > i && /^ {2}[\w-]+:\s*$/.test(l));
  return lineas.slice(i, fin === -1 ? undefined : fin);
};

// El bloque `run: |` de un paso: sus líneas van más sangradas que la clave.
const runDe = (paso: string) => {
  const lineas = paso.slice(paso.indexOf("run: |")).split("\n");
  const fin = lineas.findIndex((l, k) => k > 0 && l.trim() !== "" && !l.startsWith("          "));
  return lineas.slice(0, fin === -1 ? undefined : fin).join("\n");
};

const checks = sinComentarios("deploy-checks.yml");
const post = sinComentarios("post-deploy.yml");

const declarados = new Set(
  [...checks.slice(0, checks.indexOf("\njobs:")).matchAll(/^ {6}([A-Z][A-Z0-9_]*):\s*$/gm)].map((m) => m[1]),
);

// Configuración, no credenciales: la identidad de Vertex viene de WIF. Son los
// únicos que `qa` pasa sin `QA_`.
const COMPARTIDOS = ["GEMINI_TRANSPORT", "GOOGLE_CLOUD_PROJECT", "GOOGLE_CLOUD_LOCATION"];

const mapeo = (id: string) => {
  const cuerpo = cuerpoDe(post, id);
  const s = cuerpo.findIndex((l) => /^ {4}secrets:\s*$/.test(l));
  expect(s).toBeGreaterThan(-1);
  const pares = new Map<string, string>();
  for (const l of cuerpo.slice(s + 1)) {
    if (l.trim() === "") continue;
    const m = /^ {6}([A-Z][A-Z0-9_]*): (.+?)\s*$/.exec(l);
    if (!m) break;
    pares.set(m[1], m[2]);
  }
  return pares;
};

// Las variables de un paso que leen un secreto de DEV (sin `QA_`), y la
// expresión sin sus comparaciones: lo que quede es un valor que llega al shell.
const conDev = (texto: string) =>
  [...texto.matchAll(/^ {10}(\w+): \$\{\{ (.+) \}\}$/gm)].filter(([, , e]) => /secrets\.(?!QA_)\w+/.test(e));
const sinComparar = (e: string) => e.replace(/secrets\.\w+ (?:==|!=) (?:secrets\.\w+|'')/g, "");

describe("deploy-checks.yml: cada secreto declarado llega con su nombre", () => {
  it("nadie llama al reusable con `secrets: inherit`", () => {
    expect(post).not.toMatch(/secrets:\s*inherit/);
  });

  it("lo que el reusable lee es lo que declara", () => {
    const leidos = new Set([...checks.matchAll(/\bsecrets\.([A-Z][A-Z0-9_]*)/g)].map((m) => m[1]));
    leidos.delete("GITHUB_TOKEN");
    expect([...leidos].sort()).toEqual([...declarados].sort());
    expect(declarados.has("DATABASE_URL")).toBe(true);
  });

  it("`dev` mapea cada uno, con el mismo nombre", () => {
    const dev = mapeo("dev");
    expect([...dev.keys()].sort()).toEqual([...declarados].sort());
    for (const [clave, valor] of dev) expect(valor, `dev -> ${clave}`).toBe(`\${{ secrets.${clave} }}`);
  });

  it("`qa` mapea cada uno a su QA_, salvo la configuración compartida", () => {
    const qa = mapeo("qa");
    for (const [clave, valor] of qa) {
      expect(declarados.has(clave), `qa -> ${clave} no está declarado`).toBe(true);
      const fuente = COMPARTIDOS.includes(clave) ? clave : `QA_${clave}`;
      expect(valor, `qa -> ${clave}`).toBe(`\${{ secrets.${fuente} }}`);
    }
    expect(qa.get("DATABASE_URL")).toBe("${{ secrets.QA_DATABASE_URL }}");
  });
});

describe("el shell de QA y el de los e2e no reciben cadenas de DEV", () => {
  it("`qa_secretos` compara en la expresión: al runner llega sólo true o false", () => {
    const vars = conDev(cuerpoDe(post, "qa_secretos").join("\n"));
    expect(vars.map(([, n]) => n)).toEqual(["MISMA_BASE", "MISMO_R2"]);
    for (const [, n, e] of vars) expect(sinComparar(e), n).not.toMatch(/secrets\.(?!QA_)\w+/);
  });

  it("lo mismo en el paso del balde de los e2e", () => {
    const cuerpo = cuerpoDe(sinComentarios("ci.yml"), "e2e-tests").join("\n");
    const i = cuerpo.indexOf("- name: El balde de los e2e no es el de producción");
    expect(i).toBeGreaterThan(-1);
    const fin = cuerpo.indexOf("\n      - ", i + 1);
    const vars = conDev(cuerpo.slice(i, fin === -1 ? undefined : fin));
    expect(vars.map(([, n]) => n)).toEqual(["MISMO_R2"]);
    for (const [, n, e] of vars) expect(sinComparar(e), n).not.toMatch(/secrets\.(?!QA_)\w+/);
  });
});

describe("load-tests.yml: nada interpolado en el shell, y nunca contra PRD", () => {
  const load = sinComentarios("load-tests.yml");

  it("ningún `run:` lleva `${{`: todo entra por env", () => {
    const bloques = load.split("run: |").slice(1).map((r) => runDe(`run: |${r}`));
    expect(bloques.length).toBeGreaterThan(3);
    for (const b of bloques) expect(b).not.toContain("${{");
  });

  it("PRD queda afuera por el entorno y por el host, y falta de secreto es rojo", () => {
    expect(load).toContain("!endsWith(github.event.deployment.environment, '-prd')");
    expect(load).toContain("claimmix.vercel.app|claimmix-prd.vercel.app|claimmix-prd-*");
    expect(load).toContain("tr '[:upper:]' '[:lower:]'");
    expect(load).not.toContain("ES_FORK");
  });
});
