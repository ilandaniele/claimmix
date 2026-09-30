import { describe, expect, it } from "vitest";

import {
  ClienteCambioSchema,
  ClienteNuevoSchema,
  codigosDeRechazo,
  PolizaCambioSchema,
  PolizaNuevaSchema,
  soloLoPresente,
} from "@/core/padron/manual";

const CLIENTE = "6f1c1a52-0000-4000-8000-000000000001";

/** Los códigos con que un cuerpo se rechaza, o `null` si pasa. */
function rechazos(esquema: { safeParse(v: unknown): { success: boolean; error?: import("zod").ZodError } }, cuerpo: unknown) {
  const r = esquema.safeParse(cuerpo);
  return r.success ? null : codigosDeRechazo(r.error!);
}

describe("alta de cliente a mano", () => {
  it("normaliza y deja fuera lo vacío", () => {
    const r = ClienteNuevoSchema.parse({ nombre: " Ana  Pérez ", dni: "30.123.456", email: "", telefono: "", nacimiento: "" });
    expect(r).toEqual({ nombre: "Ana Pérez", dni: "30123456" });
  });

  it("pide nombre y DNI, cada uno con su código", () => {
    expect(rechazos(ClienteNuevoSchema, { dni: "30123456" })).toEqual(["nombre_requerido"]);
    expect(rechazos(ClienteNuevoSchema, { nombre: "Ana Pérez", dni: "  " })).toEqual(["dni_requerido"]);
    expect(rechazos(ClienteNuevoSchema, { nombre: "Ana Pérez", dni: "123" })).toEqual(["dni_invalido"]);
    expect(rechazos(ClienteNuevoSchema, { nombre: "Ana Pérez", dni: "30123456", email: "no" })).toEqual(["email_invalido"]);
  });

  it("junta varios rechazos sin repetirlos", () => {
    expect(rechazos(ClienteNuevoSchema, { nombre: "A", dni: "1", email: "x", telefono: "1" })).toEqual([
      "nombre_invalido",
      "dni_invalido",
      "email_invalido",
      "telefono_invalido",
    ]);
  });

  it("un campo de más, y el tenant_id en particular, se rechaza en vez de ignorarse", () => {
    expect(rechazos(ClienteNuevoSchema, { nombre: "Ana Pérez", dni: "30123456", tenant_id: "otro" })).toEqual([
      "datos_invalidos",
    ]);
  });

  it("un cuerpo que no es un objeto es «datos_invalidos»", () => {
    expect(rechazos(ClienteNuevoSchema, null)).toEqual(["datos_invalidos"]);
    expect(rechazos(ClienteNuevoSchema, "texto")).toEqual(["datos_invalidos"]);
  });
});

describe("edición de cliente a mano", () => {
  it("lo que no viene queda fuera; un campo vacío pide borrar el dato", () => {
    const r = ClienteCambioSchema.parse({ email: "", telefono: "291 642-6930" });
    expect(r).toEqual({ email: null, telefono: "291 642-6930" });
    expect(soloLoPresente(r)).toEqual({ email: null, telefono: "291 642-6930" });
  });

  it("el nombre vacío se ignora en vez de borrarse", () => {
    expect(ClienteCambioSchema.parse({ nombre: "" })).toEqual({});
  });

  it("el DNI no se cambia", () => {
    expect(rechazos(ClienteCambioSchema, { dni: "30123456" })).toEqual(["datos_invalidos"]);
  });
});

describe("alta de póliza a mano", () => {
  it("normaliza el número y toma los valores por defecto del servidor, no del esquema", () => {
    const r = PolizaNuevaSchema.parse({ customer_id: CLIENTE, numero: " pol 1 ", ramo: "", estado: "", prima: "1.234,50" });
    expect(r).toEqual({ customer_id: CLIENTE, numero: "POL1", prima: "1234.50" });
  });

  it("pide cliente y número", () => {
    expect(rechazos(PolizaNuevaSchema, { numero: "P1" })).toEqual(["cliente_invalido"]);
    expect(rechazos(PolizaNuevaSchema, { customer_id: "no-es-uuid", numero: "P1" })).toEqual(["cliente_invalido"]);
    expect(rechazos(PolizaNuevaSchema, { customer_id: CLIENTE })).toEqual(["poliza_invalida"]);
  });

  it("rechaza ramo, estado y fechas que no sirven", () => {
    expect(rechazos(PolizaNuevaSchema, { customer_id: CLIENTE, numero: "P1", ramo: "moto" })).toEqual(["ramo_invalido"]);
    expect(rechazos(PolizaNuevaSchema, { customer_id: CLIENTE, numero: "P1", estado: "?" })).toEqual(["estado_invalido"]);
    expect(rechazos(PolizaNuevaSchema, { customer_id: CLIENTE, numero: "P1", desde: "ayer" })).toEqual(["desde_invalido"]);
  });

  it("una vigencia invertida se rechaza", () => {
    expect(
      rechazos(PolizaNuevaSchema, { customer_id: CLIENTE, numero: "P1", desde: "2025-12-31", hasta: "2025-01-01" })
    ).toEqual(["vigencia_invertida"]);
  });

  it("el tenant_id no se acepta", () => {
    expect(rechazos(PolizaNuevaSchema, { customer_id: CLIENTE, numero: "P1", tenant_id: "otro" })).toEqual(["datos_invalidos"]);
  });
});

describe("edición de póliza a mano", () => {
  it("la vigencia se manda entera o no se manda", () => {
    expect(rechazos(PolizaCambioSchema, { desde: "2025-01-01" })).toEqual(["vigencia_incompleta"]);
    expect(rechazos(PolizaCambioSchema, { hasta: "2025-01-01" })).toEqual(["vigencia_incompleta"]);
    expect(PolizaCambioSchema.parse({ desde: "2025-01-01", hasta: "2025-12-31" })).toEqual({
      desde: "2025-01-01",
      hasta: "2025-12-31",
    });
  });

  it("las dos fechas vacías las borran", () => {
    expect(PolizaCambioSchema.parse({ desde: "", hasta: "" })).toEqual({ desde: null, hasta: null });
  });

  it("vacío en la prima la borra; vacío en ramo o estado los deja igual", () => {
    expect(PolizaCambioSchema.parse({ prima: "", ramo: "", estado: "" })).toEqual({ prima: null });
  });

  it("no cambia el número ni el titular", () => {
    expect(rechazos(PolizaCambioSchema, { numero: "P2" })).toEqual(["datos_invalidos"]);
    expect(rechazos(PolizaCambioSchema, { customer_id: CLIENTE })).toEqual(["datos_invalidos"]);
  });

  it("una vigencia invertida se rechaza", () => {
    expect(rechazos(PolizaCambioSchema, { desde: "2025-12-31", hasta: "2025-01-01" })).toEqual(["vigencia_invertida"]);
  });
});
