import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";

import {
  ASEGURADORAS_POR_OMISION,
  USUARIOS_POR_OMISION,
  correoDe,
  cuentaDeVu,
  inquilinoDe,
} from "../load/config/cuentas.js";
import { exigirDestinoDePrueba, hostDe, motivoDeRechazo } from "../load/config/destino.js";

describe("carga de aseguradoras: a dónde se puede apuntar", () => {
  it.each([
    "http://localhost:3000",
    "http://localhost",
    "http://127.0.0.1:3000/",
    "https://claimmix-qa.vercel.app",
    "https://claimmix-qa.vercel.app/",
    "https://claimmix-dev.vercel.app",
    "https://claimmix-qa-git-una-rama-ilandaniele-3471s-projects.vercel.app",
    "HTTPS://ClaimMix-QA.Vercel.App",
  ])("deja pasar %s", (url) => {
    expect(motivoDeRechazo(url)).toBeNull();
    expect(() => exigirDestinoDePrueba("aseguradoras", url)).not.toThrow();
  });

  it.each([
    "https://claimmix.vercel.app",
    "https://claimmix.vercel.app/",
    "https://claimmix.vercel.app/login?x=1",
    "https://claimmix.vercel.app:443",
    "https://CLAIMMIX.vercel.app",
    "https://claimmix.vercel.app.",
    "https://claimmix-prd.vercel.app",
    "https://claimmix-prd-qa.vercel.app",
    "https://claimmix-qa-prod.vercel.app",
  ])("rechaza producción: %s", (url) => {
    expect(motivoDeRechazo(url)).not.toBeNull();
    expect(() => exigirDestinoDePrueba("aseguradoras", url)).toThrow(/no corre contra/);
  });

  it.each([
    "https://claimmix-staging.vercel.app",
    "https://example.com",
    "https://claimmix-qatar.vercel.app",
    "https://claimmix.vercel.app.evil-qa.com",
    "https://evil.com/claimmix-qa.vercel.app",
    "https://evil.com?h=claimmix-qa",
    "http://localhost.evil.com",
    "http://127.0.0.1.evil.com",
    "https://claimmix-qa.vercel.app@claimmix.vercel.app",
    "https://claimmix-qa.vercel.app@evil.com",
  ])("rechaza todo lo que no sea localhost ni -qa / -dev: %s", (url) => {
    expect(motivoDeRechazo(url)).not.toBeNull();
  });

  it.each([undefined, null, "", "   ", "claimmix-qa.vercel.app", "ftp://claimmix-qa.vercel.app", "qa"])(
    "una URL que no se lee se rechaza: %j",
    (url) => {
      expect(motivoDeRechazo(url as string)).toMatch(/no se lee/);
    }
  );

  it("el PRD_URL de quien corre se veta aunque su host lleve -qa", () => {
    const propio = "https://mi-sitio-qa.example.net";
    expect(motivoDeRechazo(propio)).toBeNull();
    expect(motivoDeRechazo(propio, [propio])).toMatch(/producción/);
    expect(motivoDeRechazo(propio, ["MI-SITIO-QA.example.net"])).toMatch(/producción/);
    // Un prohibido vacío (PRD_URL sin definir) no vuelve a nadie producción.
    expect(motivoDeRechazo("http://localhost:3000", [""])).toBeNull();
  });

  it("el mensaje dice qué escenario y qué URL, sin llave para saltearlo", () => {
    expect(() => exigirDestinoDePrueba("aseguradoras", "https://claimmix.vercel.app")).toThrow(
      /"aseguradoras" no corre contra https:\/\/claimmix\.vercel\.app/
    );
    // `PERMITIR_REMOTO` abre los perfiles de base.js; éste no lo mira.
    expect(() =>
      exigirDestinoDePrueba("aseguradoras", "https://claimmix.vercel.app", [])
    ).toThrow();
  });

  it("hostDe normaliza y no se deja engañar por usuario@", () => {
    expect(hostDe("https://Claimmix-QA.vercel.app:8443/ruta?q=1#a")).toBe("claimmix-qa.vercel.app");
    expect(hostDe("https://claimmix.vercel.app./")).toBe("claimmix.vercel.app");
    expect(hostDe("https://x@claimmix.vercel.app")).toBe("");
  });

  it("el escenario llama al guard al cargar el módulo, antes de las opciones y del default", () => {
    const fuente = readFileSync(resolve(process.cwd(), "tests/load/scenarios/aseguradoras.js"), "utf8")
      .replace(/\/\*[\s\S]*?\*\//g, "")
      .replace(/^\s*\/\/.*$/gm, "");
    const guard = fuente.search(/^exigirDestinoDePrueba\(\s*"aseguradoras"\s*,\s*BASE_URL\b/m);
    expect(guard).toBeGreaterThan(-1);
    expect(guard).toBeLessThan(fuente.indexOf("export const options"));
    expect(guard).toBeLessThan(fuente.indexOf("export default function"));
    expect(guard).toBeLessThan(fuente.indexOf("export function setup"));
  });
});

describe("carga de aseguradoras: las cuentas que comparten el sembrado y el escenario", () => {
  const total = ASEGURADORAS_POR_OMISION * USUARIOS_POR_OMISION;

  it("son 20 x 35 = 700 por omisión", () => {
    expect([ASEGURADORAS_POR_OMISION, USUARIOS_POR_OMISION, total]).toEqual([20, 35, 700]);
  });

  it("cada VU tiene una cuenta propia, siempre la misma, y todas son example.com", () => {
    const correos = new Set<string>();
    for (let vu = 1; vu <= total; vu++) {
      const c = cuentaDeVu(vu, USUARIOS_POR_OMISION);
      expect(c.correo).toBe(correoDe(c.aseguradora, c.usuario));
      expect(c.correo).toMatch(/^carga-a\d{2}-u\d{2}@example\.com$/);
      correos.add(c.correo);
    }
    expect(correos.size).toBe(total);
  });

  it("los bordes: el primero, el cambio de aseguradora y el último", () => {
    expect(cuentaDeVu(1, 35)).toMatchObject({ aseguradora: 1, usuario: 1, correo: "carga-a01-u01@example.com" });
    expect(cuentaDeVu(35, 35)).toMatchObject({ aseguradora: 1, usuario: 35 });
    expect(cuentaDeVu(36, 35)).toMatchObject({ aseguradora: 2, usuario: 1 });
    expect(cuentaDeVu(700, 35)).toMatchObject({ aseguradora: 20, usuario: 35, correo: "carga-a20-u35@example.com" });
  });

  it("el id del espacio es un uuid fijo y distinto por aseguradora, lejos del de los tests (1000…)", () => {
    const ids = Array.from({ length: 20 }, (_, i) => inquilinoDe(i + 1));
    expect(new Set(ids).size).toBe(20);
    for (const id of ids) {
      expect(id).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-8[0-9a-f]{3}-[0-9a-f]{12}$/);
      expect(id).not.toBe("10000000-0000-0000-0000-000000000001");
    }
    expect(inquilinoDe(1)).toBe("20000000-0000-4000-8000-000000000001");
  });
});
