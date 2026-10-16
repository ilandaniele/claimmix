/**
 * `pnpm sombra:evaluar`: mide la sombra con escenarios sintéticos y nada más. Lo que se
 * vigila es lo que no se ve al correrlo: que no lea las corridas reales del agente ni
 * toque la base, que no lleve inquilino (el gasto no entra al tope), que el texto de
 * sombra que le da al modelo entre en el tope de `agent_training`, y que `--seco`
 * liste sin llamar a nadie.
 */

import { spawnSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";

import { describe, expect, it } from "vitest";

import { textoDeSombra } from "@/core/agente/entrenamiento-base";
import { SCENARIOS } from "@/server/intake/scenarios";

const fuente = readFileSync(resolve(process.cwd(), "scripts/eval-sombra.mts"), "utf8");

describe("scripts/eval-sombra.mts: sólo escenarios sintéticos", () => {
  it("no lee las corridas reales del agente ni importa la capa de base", () => {
    expect(fuente).not.toContain("input_payload");
    expect(fuente).not.toContain("output_payload");
    expect(fuente).not.toContain("@/lib/db");
  });

  it("extrae sin inquilino: no escribe en ninguna base ni en el presupuesto", () => {
    expect(fuente).toMatch(/undefined,\s*"eval-sombra"\s*\)/);
  });

  it("está registrado como `pnpm sombra:evaluar`", () => {
    const paquete = JSON.parse(readFileSync(resolve(process.cwd(), "package.json"), "utf8")) as {
      scripts: Record<string, string>;
    };
    expect(paquete.scripts["sombra:evaluar"]).toBe(
      "tsx --tsconfig tsconfig.rehearsal.json scripts/eval-sombra.mts"
    );
  });
});

describe("el agentTraining de la evaluación", () => {
  it("entra en el tope de agent_training del prompt", () => {
    const texto = textoDeSombra(["gravedad", "derivar", "pedir"]);
    expect(texto.length).toBeGreaterThan(0);
    // prompt.ts recorta agent_training a 8000 caracteres: más largo y el modelo ve la política cortada.
    expect(texto.length).toBeLessThanOrEqual(8000);
  });
});

describe("--seco", () => {
  const correr = (args: string[]) =>
    spawnSync(process.execPath, ["--import", "tsx", "scripts/eval-sombra.mts", "--seco", ...args], {
      cwd: process.cwd(),
      encoding: "utf8",
      env: { ...process.env, TSX_TSCONFIG_PATH: "tsconfig.rehearsal.json" },
    });

  it("--todos lista todos los escenarios, con la cantidad real, y sale sin llamar", () => {
    const r = correr(["--todos"]);
    expect(r.status).toBe(0);
    expect(r.stdout).toContain(`Escenarios: ${SCENARIOS.length} de ${SCENARIOS.length}.`);
    expect(r.stdout).toContain(`Llamadas a la extracción: ${SCENARIOS.length}`);
    for (const s of SCENARIOS) expect(r.stdout).toContain(`${s.id}  ${s.case_type}`);
    expect(r.stdout).toContain("no se llamó a ningún servicio");
  }, 60_000);

  it("sin opciones son diez, y un id desconocido es un error de uso", () => {
    const diez = correr([]);
    expect(diez.status).toBe(0);
    expect(diez.stdout).toContain(`Escenarios: 10 de ${SCENARIOS.length}.`);

    const malo = correr(["--escenarios", "no-existe"]);
    expect(malo.status).toBe(2);
    expect(malo.stderr).toContain("no-existe");
  }, 60_000);
});
