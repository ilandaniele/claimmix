/**
 * Quién escribe no es el titular de la póliza que dio.
 *
 * El worker ya lo sabe antes de preguntarle al modelo: el padrón encontró la
 * póliza y ni el nombre ni el DNI que dio la persona son los del titular. Una
 * diferencia de formato —puntos en el DNI, mayúsculas, acentos, el orden del
 * nombre— no es otra persona.
 */

import { describe, it, expect } from "vitest";

import { esTitularAjeno } from "@/core/case/titular-ajeno";

const ROBERTO = {
  matchType: "policy_number",
  conflictsWithExtracted: ["full_name", "dni"],
  storedValues: { full_name: "Roberto Paz", dni: "26880140" },
};

const MARTA = {
  matchType: "policy_number",
  conflictsWithExtracted: ["full_name", "dni"],
  storedValues: { full_name: "Marta Gómez", dni: "30111222" },
};

const LUCIA = { full_name: "Lucía Paz", dni: "41.207.663" };

describe("esTitularAjeno", () => {
  it.each([
    ["ni el nombre ni el DNI son los del titular", LUCIA, [ROBERTO]],
    ["dos pólizas y ninguna es suya", LUCIA, [ROBERTO, MARTA]],
    [
      "su DNI es de otro cliente, pero la póliza no",
      LUCIA,
      [
        ROBERTO,
        {
          matchType: "dni",
          conflictsWithExtracted: [],
          storedValues: { full_name: "Lucía Paz", dni: "41207663" },
        },
      ],
    ],
  ])("%s: deriva", (_, dijo, encontrados) => {
    expect(esTitularAjeno(dijo, encontrados)).toBe(true);
  });

  it.each([
    ["sin coincidencias", LUCIA, []],
    ["sólo por DNI", LUCIA, [{ ...ROBERTO, matchType: "dni" }]],
    ["sólo por correo", LUCIA, [{ ...ROBERTO, matchType: "email" }]],
    ["sólo el formato", { full_name: "ROBERTO PAZ", dni: "26.880.140" }, [ROBERTO]],
    [
      "sólo difiere el DNI",
      { full_name: "Roberto Paz", dni: "41207663" },
      [{ ...ROBERTO, conflictsWithExtracted: ["dni"] }],
    ],
    [
      "sólo difiere el nombre",
      { full_name: "Lucía Paz", dni: "26880140" },
      [{ ...ROBERTO, conflictsWithExtracted: ["full_name"] }],
    ],
    [
      "no dijo el DNI",
      { full_name: "Lucía Paz", dni: null },
      [{ ...ROBERTO, conflictsWithExtracted: ["full_name"] }],
    ],
    ["un DNI que no es un DNI", { full_name: "Lucía Paz", dni: "s/d" }, [ROBERTO]],
    ["un DNI demasiado corto", { full_name: "Lucía Paz", dni: "123" }, [ROBERTO]],
    [
      "el padrón no tiene el DNI",
      LUCIA,
      [{ ...ROBERTO, storedValues: { full_name: "Roberto Paz" } }],
    ],
    [
      "el padrón no tiene el nombre",
      LUCIA,
      [{ ...ROBERTO, storedValues: { dni: "26880140" } }],
    ],
    [
      "el mismo nombre en otro orden, con otro DNI",
      { full_name: "PAZ, Roberto", dni: "41207663" },
      [ROBERTO],
    ],
    [
      "el buscador no marcó el DNI",
      LUCIA,
      [{ ...ROBERTO, conflictsWithExtracted: ["full_name"] }],
    ],
    [
      "una de las dos pólizas es suya",
      LUCIA,
      [
        ROBERTO,
        {
          matchType: "policy_number",
          conflictsWithExtracted: [],
          storedValues: { full_name: "Lucía Paz", dni: "41207663" },
        },
      ],
    ],
  ])("%s: no deriva", (_, dijo, encontrados) => {
    expect(esTitularAjeno(dijo, encontrados)).toBe(false);
  });
});
