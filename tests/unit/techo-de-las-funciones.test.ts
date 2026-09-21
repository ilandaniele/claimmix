/**
 * Una ruta que corre el agente más que la reserva deja que una segunda corrida
 * empiece en paralelo sobre el mismo caso. Y una entrada en `vercel.json`
 * pisaría en silencio el número que el webhook usa para su propio reloj.
 *
 * No mira el paso del workflow (`src/workflows/intake-simulado.ts`): su ruta la
 * genera el build y su techo es el máximo del plan, hoy 300 s.
 */

import { describe, it, expect } from "vitest";
import { readFileSync, readdirSync } from "fs";
import { resolve, join } from "path";
import { RESERVA_DE_EXTRACCION_MS } from "@/core/case/reserva-de-extraccion";

const ROOT = resolve(__dirname, "../..");
const APP = join(ROOT, "src/app");

const rutasConAgente = (readdirSync(APP, { recursive: true, encoding: "utf8" }) as string[])
  .filter((f) => f.endsWith("route.ts"))
  .filter((f) => /\b(runIntakeAgent|retomarExtraccionesPendientes)\b/.test(readFileSync(join(APP, f), "utf8")));

describe("techo de las funciones que corren el agente", () => {
  it("hay al menos seis rutas que lo corren", () => {
    expect(rutasConAgente.length).toBeGreaterThanOrEqual(6);
  });

  it.each(rutasConAgente)("%s declara maxDuration dentro de la reserva", (ruta) => {
    const contenido = readFileSync(join(APP, ruta), "utf8");
    const m = contenido.match(/^export const maxDuration = (\d+);$/m);

    expect(m).not.toBeNull();
    expect(Number(m![1]) * 1000).toBeLessThanOrEqual(RESERVA_DE_EXTRACCION_MS);
  });

  it("vercel.json ya no fija maxDuration por ruta", () => {
    const vercelJson = JSON.parse(readFileSync(join(ROOT, "vercel.json"), "utf8"));
    expect(vercelJson.functions).toBeUndefined();
  });
});
