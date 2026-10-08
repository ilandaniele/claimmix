/**
 * El asunto y el remitente de la vista de «No relevantes», según el rol.
 *
 * Lo que se prueba es el CORTE: quién ve la dirección de la persona y el
 * asunto sin tapar. Un analista y un viewer no entran a `/api/customers`; esta
 * lista no les puede dar por la ventana lo que la puerta les niega.
 */

vi.mock("server-only", () => ({}));

import { describe, it, expect, vi } from "vitest";
import { OCULTO, remitenteYAsuntoParaElRol } from "@/server/cases/pii";

const DNI = "27.654.321";
const POLIZA = "POL-8812-R";

const FILA = {
  id: "c-1",
  asunto: `Consulta póliza POL-2026-123 DNI ${DNI}`,
  remitente: "ana@example.com",
};

describe("remitenteYAsuntoParaElRol", () => {
  it.each(["analyst", "viewer"])("a un %s le sale la dirección oculta y el asunto sin identificadores", (rol) => {
    const [visto] = remitenteYAsuntoParaElRol([FILA], rol);

    expect(visto!.remitente).toBe(OCULTO);
    expect(visto!.asunto).not.toContain(DNI);
    expect(visto!.asunto).not.toContain("POL-2026-123");
    expect(visto!.asunto).toContain("Consulta");
    expect(visto!.id).toBe("c-1");
  });

  it.each(["owner", "admin", "specialist"])("a un %s le sale todo en claro", (rol) => {
    const [visto] = remitenteYAsuntoParaElRol([FILA], rol);

    expect(visto!.remitente).toBe("ana@example.com");
    expect(visto!.asunto).toBe(FILA.asunto);
  });

  it("un rol que no se conoce no ve la dirección", () => {
    const [visto] = remitenteYAsuntoParaElRol([FILA], "fake-role");

    expect(visto!.remitente).toBe(OCULTO);
  });

  it("sin remitente o sin asunto no inventa nada que tapar", () => {
    const [visto] = remitenteYAsuntoParaElRol([{ id: "c-2", asunto: null, remitente: null }], "viewer");

    expect(visto!.remitente).toBeNull();
    expect(visto!.asunto).toBeNull();
  });

  it("las filas sin esos campos —las de las demás vistas— pasan iguales", () => {
    const sinCampos: { id: string; policy_number: string; asunto?: string | null } = {
      id: "c-3",
      policy_number: POLIZA,
    };
    const [visto] = remitenteYAsuntoParaElRol([sinCampos], "viewer");

    expect(visto).toBe(sinCampos);
    expect(visto).not.toHaveProperty("asunto");
    expect(visto).not.toHaveProperty("remitente");
  });

  it("no muta la fila de entrada", () => {
    const entrada = { ...FILA };
    remitenteYAsuntoParaElRol([entrada], "viewer");

    expect(entrada).toEqual(FILA);
  });
});
