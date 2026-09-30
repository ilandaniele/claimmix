/**
 * G35: el grupo de fraude en `GRUPOS_DE_FILTRO`.
 *
 * `filtrosPuestos` ya se prueba en general en `alternar-valores-de-filtro.test.ts`;
 * esto sólo cubre el grupo nuevo, con la misma forma de probar: sin URL,
 * pasando qué devuelve `leer` por parámetro.
 */

import { describe, expect, it } from "vitest";
import {
  GRUPOS_DE_FILTRO,
  PARAMS_DE_FILTRO,
  filtrosPuestos,
  gruposConTipos,
  textoDeFiltro,
} from "../../src/app/(app)/bandeja/components/grupos-de-filtro";
import { FILTER_PARAMS } from "../../src/app/(app)/bandeja/components/useCasesRealtime";
import { ComplejidadFiltroSchema, VencimientoFiltroSchema } from "../../src/lib/schemas/cases";

describe("filtrosPuestos — fraude", () => {
  it("fraude=high devuelve una marca", () => {
    const leer = (param: string) => (param === "fraude" ? ["high"] : []);

    const puestos = filtrosPuestos(leer);

    expect(puestos).toEqual([
      {
        param: "fraude",
        valor: "high",
        rotulo: "filter.fraude",
        etiqueta: "riesgo.fraude.high",
        color: "bg-red-600",
      },
    ]);
  });

  it("fraude=meteorito devuelve cero, porque no está en las opciones del grupo", () => {
    const leer = (param: string) => (param === "fraude" ? ["meteorito"] : []);

    expect(filtrosPuestos(leer)).toEqual([]);
  });
});

describe("filtros de plazo y de complejidad (B10, B13)", () => {
  const grupo = (param: string) => GRUPOS_DE_FILTRO.find((g) => g.param === param);

  it("las opciones son exactamente las del esquema, en el mismo orden", () => {
    expect(grupo("vencimiento")?.opciones.map((o) => o.clave)).toEqual(VencimientoFiltroSchema.options);
    expect(grupo("complejidad")?.opciones.map((o) => o.clave)).toEqual(ComplejidadFiltroSchema.options);
  });

  it("el sondeo de la bandeja los reenvía, porque salen de PARAMS_DE_FILTRO", () => {
    expect(PARAMS_DE_FILTRO).toEqual(expect.arrayContaining(["vencimiento", "complejidad"]));
    expect(FILTER_PARAMS).toEqual(expect.arrayContaining(["vencimiento", "complejidad"]));
  });

  it("vencimiento=vencidos devuelve una marca roja", () => {
    const leer = (param: string) => (param === "vencimiento" ? ["vencidos"] : []);

    expect(filtrosPuestos(leer)).toEqual([
      {
        param: "vencimiento",
        valor: "vencidos",
        rotulo: "filter.vencimiento",
        etiqueta: "vencimiento.vencidos",
        color: "bg-red-600",
      },
    ]);
  });

  it("complejidad=alta devuelve una marca y complejidad=enorme ninguna", () => {
    expect(filtrosPuestos((p) => (p === "complejidad" ? ["alta"] : []))).toEqual([
      expect.objectContaining({ param: "complejidad", valor: "alta", etiqueta: "complejidad.alta" }),
    ]);
    expect(filtrosPuestos((p) => (p === "complejidad" ? ["enorme"] : []))).toEqual([]);
  });
});

describe("tipos propios del inquilino en el filtro de tipo", () => {
  const tipos = [
    { clave: "flota_camiones", nombre: "Flota de camiones" },
    { clave: "drones", nombre: "Drones" },
  ];
  const opcionesDeTipo = (grupos: ReturnType<typeof gruposConTipos>) =>
    grupos.find((g) => g.param === "type")!.opciones;

  it("sin tipos propios devuelve la misma lista de grupos", () => {
    expect(gruposConTipos()).toBe(GRUPOS_DE_FILTRO);
    expect(gruposConTipos([])).toBe(GRUPOS_DE_FILTRO);
  });

  it("los tipos propios se suman al grupo de tipo, antes de «otro»", () => {
    const claves = opcionesDeTipo(gruposConTipos(tipos)).map((o) => o.clave);

    expect(claves.slice(-3)).toEqual(["flota_camiones", "drones", "other"]);
    expect(claves).toContain("art");
    expect(claves).toContain("consorcio");
  });

  it("no toca ningún otro grupo ni la lista de origen", () => {
    const antes = opcionesDeTipo(GRUPOS_DE_FILTRO).length;
    const grupos = gruposConTipos(tipos);

    expect(opcionesDeTipo(GRUPOS_DE_FILTRO)).toHaveLength(antes);
    for (const g of grupos.filter((x) => x.param !== "type")) {
      expect(g).toBe(GRUPOS_DE_FILTRO.find((o) => o.param === g.param));
    }
  });

  it("una marca de tipo propio lleva el nombre de la aseguradora", () => {
    const leer = (param: string) => (param === "type" ? ["drones", "meteorito"] : []);

    const puestos = filtrosPuestos(leer, tipos);

    expect(puestos).toHaveLength(1);
    expect(puestos[0]).toMatchObject({ param: "type", valor: "drones", texto: "Drones" });
  });

  it("sin pasar los tipos, un tipo propio en la URL se ignora como cualquier valor desconocido", () => {
    const leer = (param: string) => (param === "type" ? ["drones"] : []);

    expect(filtrosPuestos(leer)).toEqual([]);
  });

  it("textoDeFiltro manda el texto propio y, sin él, traduce la clave", () => {
    const t = (k: string) => `traducido:${k}`;

    expect(textoDeFiltro(t, { etiqueta: "type.other", texto: "Drones" })).toBe("Drones");
    expect(textoDeFiltro(t, { etiqueta: "type.other" })).toBe("traducido:type.other");
  });
});
