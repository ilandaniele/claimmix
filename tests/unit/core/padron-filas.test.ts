import { describe, expect, it } from "vitest";

import { ERRORES_DE_FILA, leerPadron } from "@/core/padron/filas";

const leer = (csv: string) => {
  const r = leerPadron(csv);
  if (!r.ok) throw new Error(r.error);
  return r;
};

describe("leerPadron (B16)", () => {
  it("reconoce las columnas por su nombre, en cualquier orden y en castellano o inglés, y normaliza la fila", () => {
    const r = leer(
      [
        "poliza,nombre,dni,ramo,estado,desde,hasta,prima,mail,celular,nacimiento,domicilio",
        'pol-1,Ana Pérez,30.123.456,Hogar,Vigente,01/01/2025,2025-12-31,"1.234,50",ANA@x.com,291 642-6930,1990-05-06,Mitre 1',
      ].join("\n")
    );
    expect(r.errores).toEqual([]);
    expect(r.filas).toEqual([
      {
        fila: 2,
        dni: "30123456",
        nombre: "Ana Pérez",
        email: "ana@x.com",
        telefono: "291 642-6930",
        nacimiento: "1990-05-06",
        direccion: "Mitre 1",
        poliza: { numero: "POL-1", ramo: "home", estado: "active", desde: "2025-01-01", hasta: "2025-12-31", prima: "1234.50" },
      },
    ]);
  });

  it("una fila sin póliza es sólo un cliente", () => {
    const r = leer("dni,nombre\n30123456,Ana Pérez");
    expect(r.filas).toEqual([{ fila: 2, dni: "30123456", nombre: "Ana Pérez" }]);
  });

  it("las columnas que no se reconocen se ignoran y se informan", () => {
    const r = leer("dni,nombre,color favorito\n30123456,Ana Pérez,azul");
    expect(r.ignoradas).toEqual(["color favorito"]);
    expect(r.filas).toHaveLength(1);
  });

  it("las filas vacías se saltean pero cuentan para el número de fila", () => {
    const r = leer("dni,nombre\n30123456,Ana Pérez\n,\n40123456,Luis Gómez");
    expect(r.filas.map((f) => f.fila)).toEqual([2, 4]);
  });

  it("sin columna dni no hay importación", () => {
    expect(leerPadron("nombre,poliza\nAna,1")).toEqual({ ok: false, error: "falta_columna_dni" });
  });

  it("dos columnas que significan lo mismo son un error del archivo", () => {
    expect(leerPadron("dni,documento\n1,2")).toEqual({ ok: false, error: "cabecera_repetida" });
  });

  it("los errores del CSV suben como errores del archivo", () => {
    expect(leerPadron("")).toEqual({ ok: false, error: "archivo_vacio" });
    expect(leerPadron('dni\n"1')).toEqual({ ok: false, error: "comilla_sin_cerrar" });
  });

  it.each([
    ["dni,nombre\n,Ana Pérez", "dni_requerido"],
    ["dni,nombre\n123,Ana Pérez", "dni_invalido"],
    ["dni,nombre\n30123456,A", "nombre_invalido"],
    ["dni,email\n30123456,no-es-un-mail", "email_invalido"],
    ["dni,telefono\n30123456,12", "telefono_invalido"],
    ["dni,nacimiento\n30123456,31/02/1990", "nacimiento_invalido"],
    ["dni,poliza\n30123456,=CMD()", "poliza_invalida"],
    ["dni,poliza,ramo\n30123456,P1,moto", "ramo_invalido"],
    ["dni,poliza,estado\n30123456,P1,quizas", "estado_invalido"],
    ["dni,poliza,desde\n30123456,P1,ayer", "desde_invalido"],
    ["dni,poliza,hasta\n30123456,P1,mañana", "hasta_invalido"],
    ["dni,poliza,prima\n30123456,P1,mucho", "prima_invalida"],
    ["dni,ramo\n30123456,auto", "poliza_incompleta"],
    ["dni\n30123456,de más", "columnas_de_mas"],
  ])("%j da %s en la fila 2", (csv, codigo) => {
    const r = leer(csv);
    expect(r.filas).toEqual([]);
    expect(r.errores).toEqual([{ fila: 2, codigo }]);
    expect(ERRORES_DE_FILA).toContain(codigo);
  });

  it("una celda de fórmula en un nombre entra como texto: se neutraliza al exportar, no acá", () => {
    const r = leer("dni,nombre\n30123456,=HYPERLINK(1)");
    expect(r.filas[0]?.nombre).toBe("=HYPERLINK(1)");
  });
});
