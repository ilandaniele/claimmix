// @vitest-environment node
import { spawnSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";

// Mismo criterio que `ci-prd.test.ts`: sin comentarios, porque el workflow
// explica el defecto citando la expresión.
const sinComentarios = (nombre: string) =>
  readFileSync(resolve(process.cwd(), ".github/workflows", nombre), "utf8")
    .replace(/\r\n/g, "\n")
    .split("\n")
    .map((l) => l.replace(/(^|\s)#.*$/, "$1"))
    .join("\n");

// El cuerpo de un job: desde `  id:` hasta el siguiente job.
const cuerpoDe = (yml: string, id: string) => {
  const lineas = yml.split("\n");
  const i = lineas.findIndex((l) => l === `  ${id}:`);
  expect(i).toBeGreaterThan(-1);
  const j = lineas.findIndex((l, k) => k > i && /^ {2}[\w-]+:\s*$/.test(l));
  return lineas.slice(i, j === -1 ? undefined : j).join("\n");
};

// Un paso por su nombre, hasta el siguiente.
const pasoDe = (cuerpo: string, nombre: string) => {
  const i = cuerpo.indexOf(`- name: ${nombre}`);
  expect(i).toBeGreaterThan(-1);
  const j = cuerpo.indexOf("\n      - ", i + 1);
  return cuerpo.slice(i, j === -1 ? undefined : j);
};

// El script de un paso `run: |`, sin la sangría, tal como lo corre el runner.
const scriptDe = (paso: string) => {
  const lineas = paso.slice(paso.indexOf("run: |")).split("\n").slice(1);
  const fin = lineas.findIndex((l) => l.trim() !== "" && !l.startsWith("          "));
  return lineas
    .slice(0, fin === -1 ? undefined : fin)
    .map((l) => l.replace(/^ {10}/, ""))
    .join("\n");
};

const ci = sinComentarios("ci.yml");
const job = cuerpoDe(ci, "bases");
const paso = pasoDe(job, "pnpm bases:empaquetar --comprobar && pnpm bases:probar");

const hayBash =
  spawnSync("bash", ["-c", 'printf %s "$SONDA"'], { encoding: "utf8", env: { ...process.env, SONDA: "ok" } }).stdout === "ok";

describe("ci.yml: el job de bases por cliente", () => {
  it("existe y se llama «Bases por cliente»", () => {
    expect(job).toMatch(/^ {4}name: Bases por cliente$/m);
  });

  it("corre en los mismos eventos que el resto y no en un PR hacia prd", () => {
    const m = /pull_request:\s*branches:\s*\[([^\]]*)\]/.exec(ci);
    expect(m).not.toBeNull();
    const ramas = m![1].split(",").map((r) => r.trim());
    expect(ramas).toEqual(["main", "qa"]);
    expect(ramas).not.toContain("prd");
    // Sin `if:` propio: no se saltea por evento ni por rama, y menos con un secreto (el `if:` de un job no lo lee).
    expect(job).not.toMatch(/^ {4}if:/m);
    expect(job).not.toMatch(/\bprd\b/);
  });

  it("serializa las corridas con `concurrency: bases` y no cancela la que está corriendo", () => {
    expect(job).toMatch(/^ {4}concurrency:\n {6}group: bases\n {6}cancel-in-progress: false$/m);
  });

  it("verifica el empaquetado y corre `pnpm bases:probar`", () => {
    const script = scriptDe(paso);
    expect(script).toContain("pnpm bases:empaquetar --comprobar");
    expect(script).toContain("pnpm bases:probar");
    expect(script.indexOf("--comprobar")).toBeLessThan(script.indexOf("bases:probar"));
  });

  it("usa las dos cadenas `PRD_ENSAYO_*` y ninguna otra base", () => {
    expect(paso).toContain("PRD_ENSAYO_DATABASE_URL: ${{ secrets.PRD_ENSAYO_DATABASE_URL }}");
    expect(paso).toContain("PRD_ENSAYO_DATABASE_URL_APP: ${{ secrets.PRD_ENSAYO_DATABASE_URL_APP }}");
    const secretos = [...job.matchAll(/secrets\.(\w+)/g)].map((m) => m[1]);
    expect(secretos.length).toBeGreaterThan(0);
    for (const s of secretos) expect(s).toMatch(/^PRD_ENSAYO_DATABASE_URL(_APP)?$/);
    expect(job).not.toMatch(/^\s+DATABASE_URL(_APP)?:/m);
  });

  it("`HAY_BASES` exige los dos secretos, sin dejar uno pelado entre && y ||", () => {
    const linea = job.split("\n").find((l) => l.includes("HAY_BASES:"));
    expect(linea).toContain("secrets.PRD_ENSAYO_DATABASE_URL != ''");
    expect(linea).toContain("secrets.PRD_ENSAYO_DATABASE_URL_APP != ''");
    expect(linea).not.toMatch(/&&\s*secrets\.\w+\s*\|\|/);
  });

  it("distingue el fork por `ES_FORK`, como el job de aislamiento", () => {
    expect(job).toMatch(/^ {6}ES_FORK: \$\{\{ github\.event\.pull_request\.head\.repo\.fork \}\}$/m);
  });

  it("package.json lo declara con la config del ensayo", () => {
    const { scripts } = JSON.parse(readFileSync(resolve(process.cwd(), "package.json"), "utf8"));
    expect(scripts["bases:probar"]).toBe("tsx --tsconfig tsconfig.rehearsal.json scripts/probar-bases.mts");
  });

  // El paso corre de verdad cuando hay un bash que pasa el entorno (el runner,
  // Git Bash). `pnpm` es una función que sólo anota qué le pidieron.
  const correr = (env: Record<string, string>) =>
    spawnSync("bash", ["-ec", `pnpm() { echo "pnpm $*"; }\n${scriptDe(paso)}`], {
      encoding: "utf8",
      env: { ...process.env, HAY_BASES: "", ES_FORK: "", ...env },
    });

  it.skipIf(!hayBash)("con los secretos corre el empaquetado y la prueba", () => {
    const r = correr({ HAY_BASES: "true" });
    expect(r.status).toBe(0);
    expect(r.stdout).toBe("pnpm bases:empaquetar --comprobar\npnpm bases:probar\n");
  });

  it.skipIf(!hayBash)("en un fork sin secretos comprueba el empaquetado, avisa y no prueba", () => {
    const r = correr({ ES_FORK: "true" });
    expect(r.status).toBe(0);
    expect(r.stdout).toContain("pnpm bases:empaquetar --comprobar");
    expect(r.stdout).not.toContain("pnpm bases:probar");
    expect(r.stdout).toContain("::warning title=Bases por cliente sin probar::");
  });

  it.skipIf(!hayBash)("fuera de un fork, sin secretos corta en vez de saltear", () => {
    const casos: Record<string, string>[] = [{}, { ES_FORK: "false" }, { ES_FORK: "" }];
    for (const env of casos) {
      const r = correr(env);
      expect(r.status).toBe(1);
      expect(r.stdout).not.toContain("pnpm bases:probar");
      expect(r.stdout).toContain("::error title=Bases por cliente sin probar::");
    }
  });
});
