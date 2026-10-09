// @vitest-environment node
import { spawnSync } from "node:child_process";
import { readdirSync, readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";

// Mismo criterio que `scripts/check-architecture.mjs`: sin comentarios, porque
// los workflows explican el defecto citando la expresión.
const sinComentarios = (nombre: string) =>
  readFileSync(resolve(process.cwd(), ".github/workflows", nombre), "utf8")
    .split(/\r?\n/)
    .map((l) => l.replace(/(^|\s)#.*$/, "$1"))
    .join("\n");

const flujos = readdirSync(resolve(process.cwd(), ".github/workflows")).filter((f) => /\.ya?ml$/.test(f));

// `cond && secrets.A || secrets.B`: con A vacío la expresión sigue con B, y
// B es el secreto de otro ambiente.
const PELADO = /&&\s*secrets\.\w+\s*\|\|/;

describe("un secreto elegido por condición no cae al de otro ambiente", () => {
  it.each(flujos)("%s no deja un secreto pelado entre && y ||", (nombre) => {
    expect(sinComentarios(nombre)).not.toMatch(PELADO);
  });

  it("la forma vieja se reconoce y la nueva no", () => {
    expect("cond && secrets.QA_CRON_SECRET || secrets.CRON_SECRET").toMatch(PELADO);
    expect("cond && (secrets.QA_CRON_SECRET || '__falta__') || (secrets.CRON_SECRET || '__falta__')").not.toMatch(PELADO);
  });

  it("barrer-trabados.yml: los dos pasos con CRON_SECRET llevan respaldo y cortan", () => {
    const yml = sinComentarios("barrer-trabados.yml");
    // El job de prd lleva el suyo, solo, y se mira aparte (ci-prd.test.ts).
    const lineas = yml.split("\n").filter((l) => l.includes("CRON_SECRET: ${{") && !l.includes("PRD_CRON_SECRET"));
    expect(lineas).toHaveLength(2);
    for (const l of lineas) {
      expect(l).toContain("(secrets.QA_CRON_SECRET || '__falta__')");
      expect(l).toContain("(secrets.CRON_SECRET || '__falta__')");
    }
    expect(yml.match(/\[ "\$\{CRON_SECRET\}" != '__falta__' \] \|\| \{ echo '::error::[^']*'; exit 1; \}/g)).toHaveLength(2);
  });

  it("load-tests.yml: los tres destinos llevan respaldo y el paso corta", () => {
    const yml = sinComentarios("load-tests.yml");
    const linea = yml.split("\n").find((l) => l.includes("CRON_SECRET: ${{"));
    expect(linea).toBeTruthy();
    for (const s of ["QA_CRON_SECRET", "CRON_SECRET", "PREVIEW_CRON_SECRET"]) {
      expect(linea).toContain(`(secrets.${s} || '__falta__')`);
    }
    expect(yml).toMatch(/\[ "\$\{CRON_SECRET\}" != '__falta__' \] \|\| \{ echo '::error::[^']*'; exit 1; \}/);
  });

  // El corte corre de verdad cuando hay un bash que pasa el entorno (el
  // runner, Git Bash). El `bash` de WSL no lo pasa y entonces se saltea.
  const hayBash =
    spawnSync("bash", ["-c", 'printf %s "$SONDA"'], { encoding: "utf8", env: { ...process.env, SONDA: "ok" } }).stdout === "ok";

  it.skipIf(!hayBash).each([
    ["__falta__", 1],
    ["valor-de-prueba", 0],
  ])("el corte con CRON_SECRET=%s sale con %i", (valor, esperado) => {
    const guarda = sinComentarios("barrer-trabados.yml").match(/\[ "\$\{CRON_SECRET\}" != '__falta__' \][^\n]*/)![0];
    const r = spawnSync("bash", ["-c", guarda], { encoding: "utf8", env: { ...process.env, CRON_SECRET: valor } });
    expect(r.status).toBe(esperado);
    if (esperado !== 0) expect(r.stdout).toContain("::error::");
  });
});
