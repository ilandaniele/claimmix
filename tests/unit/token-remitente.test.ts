import { spawnSync } from "node:child_process";
import { describe, expect, it } from "vitest";

// Corre el script de verdad, pero sólo con argumentos que salen en una guarda de
// uso: ninguno llega a leer un archivo de entorno ni a la red. Un caso que pase
// todas las guardas leería un .env real, así que no hay ninguno.
describe("scripts/token-remitente.mts: --vercel carga cada proyecto desde su archivo", () => {
  const correr = (...args: string[]) =>
    spawnSync(process.execPath, ["--import", "tsx", "scripts/token-remitente.mts", ...args], {
      cwd: process.cwd(),
      encoding: "utf8",
      env: { ...process.env, TSX_TSCONFIG_PATH: "tsconfig.rehearsal.json" },
    });

  const PROYECTOS = "--vercel: claimmix, claimmix-qa o claimmix-prd.";

  it.each([
    [["--vercel", "otro-proyecto", "--correo", "fake@example.com"], PROYECTOS],
    [["--vercel", "claimmix; echo fake", "--correo", "fake@example.com"], PROYECTOS],
    [["--vercel", "constructor", "--correo", "fake@example.com"], PROYECTOS],
    [
      ["--vercel", "claimmix-qa", "--archivo", ".env.local", "--correo", "fake@example.com"],
      "--vercel claimmix-qa carga sólo desde .env.qa.local.",
    ],
    [
      ["--vercel", "claimmix-prd", "--archivo", ".env.qa.local", "--correo", "fake@example.com"],
      "--vercel claimmix-prd carga sólo desde .env.prd.local.",
    ],
    [
      ["--vercel", "claimmix", "--archivo", ".env.prd.local", "--correo", "fake@example.com"],
      "--vercel claimmix carga sólo desde .env.local.",
    ],
    [
      ["--vercel", "claimmix-qa", "--archivo", "./scripts/../.env.local", "--correo", "fake@example.com"],
      "--vercel claimmix-qa carga sólo desde .env.qa.local.",
    ],
    [["--vercel", "claimmix-qa"], "--vercel pide --correo"],
  ])("se niega con %j", (args, mensaje) => {
    const r = correr(...args);
    expect(r.status).toBe(2);
    expect(r.stderr).toContain(mensaje);
    // La negativa va antes de leer el cliente: ningún archivo se abrió.
    expect(r.stderr).not.toContain("no existe o no se puede leer");
  }, 60_000);
});
