import { describe, expect, it } from "vitest";

import { leerPadron, type FilaPadron } from "@/core/padron/filas";
import {
  planearPadron,
  type ClienteExistente,
  type Existentes,
  type PolizaExistente,
} from "@/core/padron/plan";

const ANA: ClienteExistente = {
  id: "c-ana",
  dni: "30123456",
  full_name: "Ana Pérez",
  email: "ana@x.com",
  phone: null,
  birth_date: null,
  address: null,
};
const P1: PolizaExistente = {
  id: "p-1",
  customer_id: "c-ana",
  policy_number: "POL-1",
  policy_type: "auto",
  status: "active",
  start_date: "2025-01-01",
  end_date: "2025-12-31",
  premium_amount: "1000.00",
};

const vacio = (): Existentes => ({ clientes: new Map(), polizas: new Map() });
const con = (clientes: ClienteExistente[], polizas: PolizaExistente[] = []): Existentes => ({
  clientes: new Map(clientes.map((c) => [c.dni, c])),
  polizas: new Map(polizas.map((p) => [p.policy_number, p])),
});

let n = 0;
const nuevoId = () => `nuevo-${++n}`;

/** Filas desde un CSV real: el plan se prueba con lo que la lectura de verdad produce. */
function filas(csv: string): FilaPadron[] {
  const r = leerPadron(csv);
  if (!r.ok || r.errores.length) throw new Error("el CSV del test no es válido");
  return r.filas;
}

describe("planearPadron (B16)", () => {
  it("un cliente y una póliza nuevos son dos altas con el id del cliente en la póliza", () => {
    n = 0;
    const plan = planearPadron(filas("dni,nombre,poliza,ramo\n30123456,Ana Pérez,POL-1,auto"), vacio(), nuevoId);
    expect(plan.errores).toEqual([]);
    expect(plan.resumen).toEqual({
      clientes: { altas: 1, cambios: 0, iguales: 0 },
      polizas: { altas: 1, cambios: 0, iguales: 0 },
    });
    expect(plan.clientes[0]).toMatchObject({ id: "nuevo-1", dni: "30123456", full_name: "Ana Pérez", email: null });
    expect(plan.polizas[0]).toMatchObject({
      customer_id: "nuevo-1",
      policy_number: "POL-1",
      policy_type: "auto",
      status: "active",
      start_date: null,
    });
  });

  it("una póliza sin ramo ni estado queda como «other» y activa", () => {
    const plan = planearPadron(filas("dni,nombre,poliza\n30123456,Ana Pérez,POL-9"), vacio(), nuevoId);
    expect(plan.polizas[0]).toMatchObject({ policy_type: "other", status: "active" });
  });

  it("tres pólizas del mismo DNI son un solo cliente", () => {
    const plan = planearPadron(
      filas("dni,nombre,poliza\n30123456,Ana Pérez,A1\n30123456,,A2\n30123456,ANA PEREZ,A3"),
      vacio(),
      nuevoId
    );
    expect(plan.errores).toEqual([]);
    expect(plan.resumen.clientes.altas).toBe(1);
    expect(plan.resumen.polizas.altas).toBe(3);
    expect(new Set(plan.polizas.map((p) => p.customer_id)).size).toBe(1);
  });

  it("lo que ya está igual es «sin cambios» y no se escribe", () => {
    const plan = planearPadron(
      filas("dni,nombre,email,poliza,ramo,desde,hasta,prima\n30123456,Ana Pérez,ana@x.com,POL-1,auto,2025-01-01,2025-12-31,1000"),
      con([ANA], [P1]),
      nuevoId
    );
    expect(plan.clientes).toEqual([]);
    expect(plan.polizas).toEqual([]);
    expect(plan.resumen).toEqual({
      clientes: { altas: 0, cambios: 0, iguales: 1 },
      polizas: { altas: 0, cambios: 0, iguales: 1 },
    });
  });

  it("una celda llena reemplaza y una vacía deja el dato como estaba", () => {
    const plan = planearPadron(
      filas("dni,telefono,email,poliza,estado,prima\n30123456,291 642-6930,,POL-1,vencida,"),
      con([ANA], [P1]),
      nuevoId
    );
    expect(plan.clientes).toEqual([{ ...ANA, phone: "291 642-6930" }]);
    expect(plan.polizas).toEqual([
      {
        customer_id: "c-ana",
        policy_number: "POL-1",
        policy_type: "auto",
        status: "expired",
        start_date: "2025-01-01",
        end_date: "2025-12-31",
        premium_amount: "1000.00",
      },
    ]);
    expect(plan.resumen).toEqual({
      clientes: { altas: 0, cambios: 1, iguales: 0 },
      polizas: { altas: 0, cambios: 1, iguales: 0 },
    });
  });

  it("un cliente nuevo sin nombre es un error, y sus pólizas no se escriben", () => {
    const plan = planearPadron(filas("dni,poliza\n30123456,POL-7"), vacio(), nuevoId);
    expect(plan.errores).toEqual([{ fila: 2, codigo: "nombre_requerido" }]);
    expect(plan.clientes).toEqual([]);
    expect(plan.polizas).toEqual([]);
  });

  it("un cliente existente no necesita nombre en el archivo", () => {
    const plan = planearPadron(filas("dni,telefono\n30123456,291 642-6930"), con([ANA]), nuevoId);
    expect(plan.errores).toEqual([]);
    expect(plan.clientes[0]).toMatchObject({ full_name: "Ana Pérez", phone: "291 642-6930" });
  });

  it("dos filas del mismo DNI que se contradicen: la segunda es un error", () => {
    const plan = planearPadron(
      filas("dni,nombre,email\n30123456,Ana Pérez,ana@x.com\n30123456,Ana Pérez,otra@x.com"),
      vacio(),
      nuevoId
    );
    expect(plan.errores).toEqual([{ fila: 3, codigo: "cliente_contradictorio" }]);
  });

  it("el mismo nombre escrito de otra forma, o el mismo teléfono con otro formato, no contradicen", () => {
    const plan = planearPadron(
      filas("dni,nombre,telefono\n30123456,Ana Pérez,291 642-6930\n30123456,perez ana,2916426930"),
      vacio(),
      nuevoId
    );
    expect(plan.errores).toEqual([]);
  });

  it("un número de póliza repetido en el archivo es un error", () => {
    const plan = planearPadron(
      filas("dni,nombre,poliza\n30123456,Ana Pérez,A1\n40123456,Luis Gómez,a1"),
      vacio(),
      nuevoId
    );
    expect(plan.errores).toEqual([{ fila: 3, codigo: "poliza_repetida" }]);
  });

  it("una póliza existente con otro titular no se pasa a otro cliente", () => {
    const plan = planearPadron(filas("dni,nombre,poliza\n40123456,Luis Gómez,POL-1"), con([ANA], [P1]), nuevoId);
    expect(plan.errores).toEqual([{ fila: 2, codigo: "poliza_de_otro_titular" }]);
    expect(plan.polizas).toEqual([]);
  });

  it("una vigencia invertida es un error, también contra las fechas que ya estaban", () => {
    expect(
      planearPadron(filas("dni,nombre,poliza,desde,hasta\n30123456,Ana Pérez,A1,2025-12-31,2025-01-01"), vacio(), nuevoId)
        .errores
    ).toEqual([{ fila: 2, codigo: "vigencia_invertida" }]);
    expect(
      planearPadron(filas("dni,poliza,desde\n30123456,POL-1,2026-06-01"), con([ANA], [P1]), nuevoId).errores
    ).toEqual([{ fila: 2, codigo: "vigencia_invertida" }]);
  });

  it("los errores salen ordenados por fila", () => {
    const plan = planearPadron(
      filas("dni,nombre,poliza\n30123456,Ana Pérez,A1\n40123456,,A2\n30123456,Ana Pérez,a1"),
      vacio(),
      nuevoId
    );
    expect(plan.errores.map((e) => e.fila)).toEqual([3, 4]);
  });

  describe("lo que ya está guardado con otra forma de escribirlo", () => {
    // Los mapas van por clave normalizada; cada fila conserva el texto que tiene la base.
    const guardadas = (): Existentes => ({
      clientes: new Map([["30123456", { ...ANA, dni: "30.123.456" }]]),
      polizas: new Map([["POL-8812-R", { ...P1, policy_number: "pol-8812-r" }]]),
    });

    it("el cliente y la póliza se reconocen y el plan los devuelve con el texto guardado, para que el ON CONFLICT los encuentre", () => {
      const plan = planearPadron(
        filas("dni,telefono,poliza,ramo\n30123456,291 642-6930,POL-8812-R,home"),
        guardadas(),
        nuevoId
      );
      expect(plan.errores).toEqual([]);
      expect(plan.resumen).toEqual({
        clientes: { altas: 0, cambios: 1, iguales: 0 },
        polizas: { altas: 0, cambios: 1, iguales: 0 },
      });
      expect(plan.clientes[0]).toMatchObject({ id: "c-ana", dni: "30.123.456" });
      expect(plan.polizas[0]).toMatchObject({ customer_id: "c-ana", policy_number: "pol-8812-r", policy_type: "home" });
    });

    it("una póliza guardada así, de otro titular, es un error y no un alta", () => {
      const plan = planearPadron(filas("dni,nombre,poliza\n40123456,Luis Gómez,POL-8812-R"), guardadas(), nuevoId);
      expect(plan.errores).toEqual([{ fila: 2, codigo: "poliza_de_otro_titular" }]);
      expect(plan.polizas).toEqual([]);
    });

    it("sin cambios cuenta iguales, aunque el texto guardado difiera del normalizado", () => {
      const plan = planearPadron(
        filas("dni,nombre,poliza,ramo\n30123456,Ana Pérez,POL-8812-R,auto"),
        guardadas(),
        nuevoId
      );
      expect(plan.resumen.clientes.iguales).toBe(1);
      expect(plan.resumen.polizas.iguales).toBe(1);
      expect(plan.clientes).toEqual([]);
      expect(plan.polizas).toEqual([]);
    });
  });
});
