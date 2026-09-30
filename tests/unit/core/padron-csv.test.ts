import { describe, expect, it } from "vitest";

import { leerCsv, MAX_COLUMNAS, MAX_FILAS_DE_DATOS } from "@/core/padron/csv";

const filas = (crudo: string) => {
  const r = leerCsv(crudo);
  if (!r.ok) throw new Error(r.error);
  return r.filas;
};

describe("leerCsv (B16)", () => {
  it("lee coma, punto y coma y tabulación según la primera línea", () => {
    expect(filas("a,b\n1,2")).toEqual([["a", "b"], ["1", "2"]]);
    expect(filas("a;b\n1;2")).toEqual([["a", "b"], ["1", "2"]]);
    expect(filas("a\tb\n1\t2")).toEqual([["a", "b"], ["1", "2"]]);
  });

  it("entiende comillas, comillas duplicadas y saltos de línea dentro de una celda", () => {
    expect(filas('nombre,nota\n"Pérez, Ana","dijo ""hola""\nadiós"')).toEqual([
      ["nombre", "nota"],
      ["Pérez, Ana", 'dijo "hola"\nadiós'],
    ]);
  });

  it("le saca la marca BOM y acepta CRLF, LF y CR sueltos", () => {
    expect(filas("﻿a,b\r\n1,2\r3,4\n5,6")).toEqual([["a", "b"], ["1", "2"], ["3", "4"], ["5", "6"]]);
  });

  it("devuelve las filas vacías para que el número de fila sea el de la planilla", () => {
    expect(filas("a,b\n\n1,2")).toEqual([["a", "b"], [""], ["1", "2"]]);
  });

  it("una fila final sin salto de línea entra", () => {
    expect(filas("a\n1")).toEqual([["a"], ["1"]]);
  });

  it("sin filas de datos es archivo_vacio", () => {
    expect(leerCsv("")).toEqual({ ok: false, error: "archivo_vacio" });
    expect(leerCsv("dni,nombre")).toEqual({ ok: false, error: "archivo_vacio" });
    expect(leerCsv("dni,nombre\n")).toEqual({ ok: false, error: "archivo_vacio" });
  });

  it("una comilla sin cerrar es un error, no una celda gigante", () => {
    expect(leerCsv('a,b\n1,"2')).toEqual({ ok: false, error: "comilla_sin_cerrar" });
  });

  it("una comilla en medio de una celda no abre un entrecomillado", () => {
    expect(filas('a,b\n5" de largo,2')).toEqual([["a", "b"], ['5" de largo', "2"]]);
  });

  it("corta con demasiadas_columnas", () => {
    const cabecera = Array.from({ length: MAX_COLUMNAS + 1 }, (_, i) => `c${i}`).join(",");
    expect(leerCsv(`${cabecera}\n1`)).toEqual({ ok: false, error: "demasiadas_columnas" });
  });

  it("acepta el tope de filas y corta una más", () => {
    const cuerpo = (n: number) => Array.from({ length: n }, (_, i) => String(i)).join("\n");
    expect(leerCsv(`dni\n${cuerpo(MAX_FILAS_DE_DATOS)}`).ok).toBe(true);
    expect(leerCsv(`dni\n${cuerpo(MAX_FILAS_DE_DATOS + 1)}`)).toEqual({ ok: false, error: "demasiadas_filas" });
  });
});
