/**
 * ¿Esto que trae el sobre es el nombre de una persona, o cualquier cosa?
 *
 * El agente pedía «Nombre completo» a alguien cuyo `From` decía
 * `Ilan Daniele <ilan.daniele@gmail.com>`. Usar el nombre visible arregla eso y
 * abre el riesgo opuesto: un nombre basura aceptado saluda mal, entra al prompt
 * del redactor y puede fabricar un conflicto contra el padrón. Un nombre
 * visible lo configura quien escribe y no lo verifica nadie.
 *
 * Por eso el juicio vive una sola vez, es puro, y tiene su propia batería: es
 * la mitad barata y determinística de un cambio cuyo resto se lee en un
 * transcripto.
 */

import { describe, it, expect } from "vitest";
import { nombreDePersona, nombreVisibleDelSobre } from "@/core/nombres/nombre-de-persona";

describe("nombreVisibleDelSobre", () => {
  it("saca lo que va antes de los ángulos", () => {
    expect(nombreVisibleDelSobre("Ilan Daniele <ilan.daniele@gmail.com>")).toBe("Ilan Daniele");
  });

  it("y le saca las comillas que pone un cliente de correo", () => {
    expect(nombreVisibleDelSobre('"Ilan Daniele" <ilan@x.com>')).toBe("Ilan Daniele");
  });

  it("una dirección pelada no tiene nombre visible", () => {
    // Es lo que mandaba el ensayo, y devolver la dirección la convertiría en
    // un nombre.
    expect(nombreVisibleDelSobre("ensayo.1@example.com")).toBeNull();
    expect(nombreVisibleDelSobre("<solo@la.direccion>")).toBeNull();
    expect(nombreVisibleDelSobre("")).toBeNull();
    expect(nombreVisibleDelSobre(null)).toBeNull();
  });

  it("la dirección repetida en el lugar del nombre no agrega nada", () => {
    expect(nombreVisibleDelSobre("ilan@x.com <ilan@x.com>")).toBeNull();
    expect(nombreVisibleDelSobre("ilan <ilan@x.com>")).toBeNull();
  });
});

describe("nombreDePersona — lo que sí es un nombre", () => {
  it.each([
    "Ilan Daniele",
    "María José Pérez",
    "Juan Carlos Gómez Ruiz",
    "Ana O'Connor",
    "Luis Fernández-Lamas",
  ])("%s", (visible) => {
    expect(nombreDePersona(visible)).toBe(visible);
  });

  it("normaliza los espacios y no toca la caja", () => {
    // `titleCase` lo formatea después; acá sólo se juzga.
    expect(nombreDePersona("  MARTIN   SOSA  ")).toBe("MARTIN SOSA");
  });
});

describe("nombreDePersona — lo que no lo es", () => {
  it.each([
    ["un teléfono se pone su propio nombre", "iPhone de Juan"],
    ["y el modelo también", "Galaxy S21"],
    ["lo que manda `pnpm knock`", "Asegurado de prueba"],
    ["una razón social", "Transportes del Sur S.R.L."],
    ["una aseguradora", "Grupo Seguros SA"],
    ["un buzón funcional", "Soporte Tecnico"],
    ["uno automático", "Notificaciones Automaticas"],
    ["una dirección de correo", "ilan.daniele@gmail.com"],
    ["un domicilio", "Av. Alem 2300"],
    ["una calle sin altura", "Calle Falsa"],
    ["un teléfono", "5491100000000"],
    ["una sola palabra", "Ilan"],
    ["una letra", "I"],
    ["vacío", ""],
    ["nada", null],
    ["una frase entera", "Escribo por el choque de mi hermana"],
  ])("%s: %s", (_por_que, visible) => {
    expect(nombreDePersona(visible)).toBeNull();
  });
});
