/**
 * AC24 en el pedido de datos: lo que se le repite a la persona («entendimos …»)
 * sale con el documento y la póliza tapados, igual que en un conflicto.
 */

import { describe, it, expect } from "vitest";
import { clavesAbiertas, type DatosDelReenvio } from "@/server/confirmations/reenvio";

const HOY = "2026-09-25";

function datos(overrides: Partial<DatosDelReenvio> = {}): DatosDelReenvio {
  return {
    caso: {
      id: "caso-1",
      status: "info_faltante",
      channel: "email",
      assigned_to: null,
      updated_at: "2026-09-01T00:00:00.000Z",
      closed_at: null,
    },
    destinatario: "juan@x.com",
    ultimoEntrante: "2026-09-25T00:00:00.000Z",
    pedido: { claves: ["full_name"], enviado: "2026-09-01T00:00:00.000Z" },
    campos: [],
    docsAbiertos: [],
    confirmaciones: [],
    ultimoCierre: null,
    ...overrides,
  };
}

describe("clavesAbiertas — el valor conocido sale tapado", () => {
  it("el DNI queda con los últimos 4 dígitos", () => {
    const r = clavesAbiertas(
      datos({
        pedido: { claves: ["dni"], enviado: null },
        campos: [{ field_key: "dni", field_value: "20345678", confidence: 0.7 }],
      }),
      HOY
    );
    expect(r.claves).toEqual(["dni"]);
    expect(r.conocidos.dni).toBe("****5678");
  });

  it("la póliza conserva el prefijo y tapa el número", () => {
    const r = clavesAbiertas(
      datos({
        pedido: { claves: ["policy_number"], enviado: null },
        campos: [{ field_key: "policy_number", field_value: "POL-12345678", confidence: 0.7 }],
      }),
      HOY
    );
    expect(r.claves).toEqual(["policy_number"]);
    expect(r.conocidos.policy_number).toBe("POL-****5678");
  });

  it("un alias del DNI también sale tapado", () => {
    const r = clavesAbiertas(
      datos({
        pedido: { claves: ["dni_asegurado"], enviado: null },
        campos: [{ field_key: "dni_asegurado", field_value: "20345678", confidence: 0.7 }],
      }),
      HOY
    );
    expect(r.conocidos.dni_asegurado).toBe("****5678");
  });

  it("una patente sigue saliendo entera", () => {
    const r = clavesAbiertas(
      datos({
        pedido: { claves: ["patente_vehiculo"], enviado: null },
        campos: [{ field_key: "patente_vehiculo", field_value: "ABC123", confidence: 0.7 }],
      }),
      HOY
    );
    expect(r.conocidos.patente_vehiculo).toBe("ABC123");
  });
});
