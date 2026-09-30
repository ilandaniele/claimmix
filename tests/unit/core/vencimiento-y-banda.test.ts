/**
 * Las cuentas que pinta el navegador (vencimiento y banda de complejidad) no
 * pueden traer zod: viven aparte de `plazos.ts` y `puntaje-complejidad.ts`
 * justamente para que las insignias de la bandeja no suban al bundle de todas
 * las pantallas ~18 kB comprimidos de un esquema que sólo usa el servidor.
 */

import { readFileSync } from "node:fs";
import { join } from "node:path";

import { describe, expect, it } from "vitest";

import * as plazos from "@/core/case/plazos";
import * as puntaje from "@/core/case/puntaje-complejidad";
import * as puras from "@/core/case/vencimiento-y-banda";

const leer = (ruta: string) => readFileSync(join(process.cwd(), ruta), "utf8");

describe("vencimiento-y-banda: sin zod para el navegador", () => {
  it("no importa nada: ni zod ni un módulo que lo traiga", () => {
    expect(leer("src/core/case/vencimiento-y-banda.ts")).not.toMatch(/^\s*import\s/m);
  });

  it("las insignias del equipo importan de ahí y no de los módulos con esquemas", () => {
    const insignias = leer("src/app/(app)/_components/plazo-y-complejidad.tsx");
    expect(insignias).toContain("@/core/case/vencimiento-y-banda");
    expect(insignias).not.toMatch(/@\/core\/case\/(plazos|puntaje-complejidad)"/);
  });

  it("plazos.ts y puntaje-complejidad.ts reexportan las mismas funciones, no una copia", () => {
    expect(plazos.estadoDelVencimiento).toBe(puras.estadoDelVencimiento);
    expect(plazos.diasAlVencimiento).toBe(puras.diasAlVencimiento);
    expect(plazos.DIAS_POR_VENCER).toBe(puras.DIAS_POR_VENCER);
    expect(puntaje.bandaDe).toBe(puras.bandaDe);
    expect(puntaje.RANGOS).toBe(puras.RANGOS);
  });
});
