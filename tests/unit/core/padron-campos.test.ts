import { describe, expect, it } from "vitest";

import {
  aDireccion,
  aDni,
  aEmail,
  aEstado,
  aFecha,
  aNacimiento,
  aNombre,
  aNumeroPoliza,
  aPrima,
  aRamo,
  aTelefono,
} from "@/core/padron/campos";

describe("campos del padrón (B16)", () => {
  it("DNI: deja los números y pide de 6 a 9", () => {
    expect(aDni("30.123.456")).toBe("30123456");
    expect(aDni(" 30 123 456 ")).toBe("30123456");
    expect(aDni("12345")).toBeNull();
    expect(aDni("1234567890")).toBeNull();
    expect(aDni("30123456A")).toBeNull();
    expect(aDni("")).toBeNull();
  });

  it("nombre y dirección: sin controles ni marcas bidireccionales, con espacios juntados", () => {
    expect(aNombre("  Ana   Pérez ")).toBe("Ana Pérez");
    expect(aNombre("A")).toBeNull();
    expect(aNombre("Ana\nPérez")).toBeNull();
    expect(aNombre("Ana‮Pérez")).toBeNull();
    expect(aNombre("x".repeat(201))).toBeNull();
    expect(aDireccion("Mitre 123")).toBe("Mitre 123");
    expect(aDireccion("Mitre\u0000 123")).toBeNull();
    expect(aDireccion("x".repeat(301))).toBeNull();
  });

  it("email: en minúsculas y con forma de email", () => {
    expect(aEmail("Ana@Correo.COM")).toBe("ana@correo.com");
    expect(aEmail("ana@")).toBeNull();
    expect(aEmail("sin arroba")).toBeNull();
  });

  it("teléfono: sólo números y signos, de 7 a 15 dígitos, se guarda como vino", () => {
    expect(aTelefono("+54 9 291 642-6930")).toBe("+54 9 291 642-6930");
    expect(aTelefono("123456")).toBeNull();
    expect(aTelefono("291-ABC-6930")).toBeNull();
    expect(aTelefono("1".repeat(16))).toBeNull();
  });

  it("fecha: ISO o día/mes/año, y sólo si el día existe", () => {
    expect(aFecha("2025-03-31")).toBe("2025-03-31");
    expect(aFecha("31/03/2025")).toBe("2025-03-31");
    expect(aFecha("1/3/2025")).toBe("2025-03-01");
    expect(aFecha("31/02/2025")).toBeNull();
    expect(aFecha("2025-13-01")).toBeNull();
    expect(aFecha("marzo")).toBeNull();
  });

  it("nacimiento: ni del futuro ni de antes de 1900", () => {
    expect(aNacimiento("1985-06-01")).toBe("1985-06-01");
    expect(aNacimiento("1899-12-31")).toBeNull();
    expect(aNacimiento("2999-01-01")).toBeNull();
  });

  it("número de póliza: sin espacios, en mayúsculas y con caracteres de número", () => {
    expect(aNumeroPoliza(" pol 123 ")).toBe("POL123");
    expect(aNumeroPoliza("AB-12/3.4")).toBe("AB-12/3.4");
    expect(aNumeroPoliza("=CMD()")).toBeNull();
    expect(aNumeroPoliza("A".repeat(61))).toBeNull();
  });

  it("ramo y estado: castellano, inglés, sin acentos ni mayúsculas", () => {
    expect(aRamo("Automóvil")).toBe("auto");
    expect(aRamo("HOGAR")).toBe("home");
    expect(aRamo("vida")).toBe("life");
    expect(aRamo("comercio")).toBe("business");
    expect(aRamo("otro")).toBe("other");
    expect(aRamo("moto")).toBeNull();
    expect(aEstado("Activa")).toBe("active");
    expect(aEstado("VENCIDA")).toBe("expired");
    expect(aEstado("anulada")).toBe("cancelled");
    expect(aEstado("pendiente")).toBeNull();
  });

  it("prima: 1234.56, 1234,56, 1.234,56 y 1,234.56 son la misma", () => {
    for (const s of ["1234.56", "1234,56", "1.234,56", "1,234.56", "$ 1.234,56"]) expect(aPrima(s)).toBe("1234.56");
    expect(aPrima("1500")).toBe("1500.00");
    expect(aPrima("1.500")).toBe("1500.00");
    expect(aPrima("12,5")).toBe("12.50");
    expect(aPrima("-5")).toBeNull();
    expect(aPrima("abc")).toBeNull();
    expect(aPrima("12345678901")).toBeNull();
  });
});
