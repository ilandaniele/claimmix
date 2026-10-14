/**
 * La lista de rubros del perfil de WhatsApp: una sola, y con etiqueta en los dos idiomas.
 */

import { describe, expect, it } from "vitest";

import { enUS } from "@/lib/i18n/en-US";
import { esAR } from "@/lib/i18n/es-AR";
import { CATEGORIA_INICIAL, CATEGORIAS_DE_PERFIL, categoriaDePerfil } from "@/lib/whatsapp-categorias";

// Los valores que el alta ofrecía antes de contrastar con la documentación de Meta.
const LISTA_ANTERIOR = [
  "OTHER", "AUTO", "BEAUTY", "APPAREL", "EDU", "ENTERTAIN", "EVENT_PLAN", "FINANCE", "GROCERY",
  "GOVT", "HOTEL", "HEALTH", "NONPROFIT", "PROF_SERVICES", "RETAIL", "TRAVEL", "RESTAURANT",
];

describe("CATEGORIAS_DE_PERFIL", () => {
  it("no repite ningún valor", () => {
    expect(new Set(CATEGORIAS_DE_PERFIL).size).toBe(CATEGORIAS_DE_PERFIL.length);
  });

  it("trae los valores de la lista anterior", () => {
    for (const valor of LISTA_ANTERIOR) expect(CATEGORIAS_DE_PERFIL).toContain(valor);
  });

  it("no trae los que Meta no deja elegir", () => {
    expect(CATEGORIAS_DE_PERFIL).not.toContain("UNDEFINED");
    expect(CATEGORIAS_DE_PERFIL).not.toContain("NOT_A_BIZ");
  });

  it("son mayúsculas con guion bajo, como las espera Graph", () => {
    for (const valor of CATEGORIAS_DE_PERFIL) expect(valor).toMatch(/^[A-Z_]+$/);
  });

  it("FINANCE queda sólo como valor inicial, y está en la lista", () => {
    expect(CATEGORIA_INICIAL).toBe("FINANCE");
    expect(CATEGORIAS_DE_PERFIL).toContain(CATEGORIA_INICIAL);
  });

  it.each(CATEGORIAS_DE_PERFIL)("%s tiene etiqueta en es-AR y en en-US", (valor) => {
    const clave = `waba.categoria.${valor}` as keyof typeof esAR;
    expect(esAR[clave]?.trim()).toBeTruthy();
    expect(enUS[clave as keyof typeof enUS]?.trim()).toBeTruthy();
  });
});

describe("categoriaDePerfil", () => {
  it.each(CATEGORIAS_DE_PERFIL)("acepta %s", (valor) => {
    expect(categoriaDePerfil(valor)).toBe(valor);
  });

  it.each([
    ["en minúsculas", "finance"],
    ["con espacios", " FINANCE "],
    ["con un salto de línea", "FINANCE\n"],
    ["vacío", ""],
    ["UNDEFINED", "UNDEFINED"],
    ["NOT_A_BIZ", "NOT_A_BIZ"],
    ["un rubro inventado", "CRYPTO"],
    ["una propiedad heredada", "constructor"],
    ["nulo", null],
    ["indefinido", undefined],
    ["un número", 7],
    ["un booleano", true],
    ["un arreglo", ["FINANCE"]],
    ["un objeto", { valor: "FINANCE" }],
  ])("descarta un valor %s", (_caso, valor) => {
    expect(categoriaDePerfil(valor)).toBeNull();
  });
});
