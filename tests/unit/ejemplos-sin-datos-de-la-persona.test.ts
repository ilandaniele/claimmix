/**
 * `ejemploSinDatosDeLaPersona` es lo que hace que un caso real pueda volverse
 * ejemplo de referencia: tacha el nombre y el DNI de la persona en todo el
 * ejemplo, no sólo en el campo que la extracción reconoció como tal — el
 * texto libre puede repetir el nombre en cualquier parte.
 */

import { describe, expect, it } from "vitest";

import { ejemploSinDatosDeLaPersona } from "@/server/training/sin-datos-de-la-persona";
import { deEjemplos, type FilaDeEjemplo } from "@/server/training/examples";

describe("ejemploSinDatosDeLaPersona", () => {
  it("tacha el nombre y el DNI, en el cuerpo y en los campos confirmados", () => {
    const ejemplo = {
      input_payload: {
        subject: "Choque en ruta",
        body: "Habla Martín Sosa, mi DNI es 30.145.882.",
      },
      expected_output: {
        confirmed_fields: [
          { field_key: "full_name", field_value: "Martín Sosa", confidence: 0.95 },
          { field_key: "dni", field_value: "30.145.882", confidence: 0.95 },
        ],
      },
    };

    const resultado = ejemploSinDatosDeLaPersona(ejemplo);

    expect((resultado.input_payload as { body: string }).body).toBe(
      "Habla [NOMBRE], mi DNI es [DNI]."
    );
    const confirmados = (
      resultado.expected_output as { confirmed_fields: Array<{ field_value: string }> }
    ).confirmed_fields;
    expect(confirmados[0].field_value).toBe("[NOMBRE]");
    expect(confirmados[1].field_value).toBe("[DNI]");
  });

  it("«Sosa» sola, sin el nombre de pila al lado, también se tacha", () => {
    const ejemplo = {
      input_payload: { subject: "", body: "El Sr. Sosa llamó de nuevo." },
      expected_output: {
        confirmed_fields: [{ field_key: "full_name", field_value: "Martín Sosa", confidence: 0.9 }],
      },
    };

    const resultado = ejemploSinDatosDeLaPersona(ejemplo);

    expect((resultado.input_payload as { body: string }).body).toBe(
      "El Sr. [NOMBRE] llamó de nuevo."
    );
  });

  it("no toca «Martínez» cuando el nombre confirmado es «Martín Sosa»", () => {
    const ejemplo = {
      input_payload: {
        subject: "",
        body: "Habló con el Dr. Martínez, no con el asegurado Martín Sosa.",
      },
      expected_output: {
        confirmed_fields: [{ field_key: "full_name", field_value: "Martín Sosa", confidence: 0.9 }],
      },
    };

    const resultado = ejemploSinDatosDeLaPersona(ejemplo);
    const body = (resultado.input_payload as { body: string }).body;

    expect(body).toContain("Martínez");
    expect(body).toContain("[NOMBRE]");
  });

  it("reconoce el nombre y el DNI guardados con las claves en castellano", () => {
    const ejemplo = {
      input_payload: { subject: "", body: "Soy Martín Sosa, DNI 30145882. Otro dato: Sosa." },
      expected_output: {
        confirmed_fields: [
          { field_key: "nombre_asegurado", field_value: "Martín Sosa", confidence: 0.9 },
        ],
        agent_output: { extracted_fields: { dni_asegurado: "30145882" } },
      },
    };

    const body = (ejemploSinDatosDeLaPersona(ejemplo).input_payload as { body: string }).body;

    expect(body).toBe("Soy [NOMBRE], DNI [DNI]. Otro dato: [NOMBRE].");
  });

  it("saca sender_email de donde aparezca", () => {
    const ejemplo = {
      input_payload: { subject: "x", body: "y", sender_email: "persona@mail.com" },
      expected_output: {},
    };

    const resultado = ejemploSinDatosDeLaPersona(ejemplo);
    const payload = resultado.input_payload as Record<string, unknown>;

    expect("sender_email" in payload).toBe(false);
  });

  it("deja el resto de los campos intacto", () => {
    const ejemplo = {
      input_payload: { subject: "Choque", body: "sin datos de nadie" },
      expected_output: { agent_output: { claim_type: "choque", policy_number: "POL-1234" } },
    };

    const resultado = ejemploSinDatosDeLaPersona(ejemplo);
    const agentOutput = (
      resultado.expected_output as { agent_output: { claim_type: string; policy_number: string } }
    ).agent_output;

    expect((resultado.input_payload as { subject: string }).subject).toBe("Choque");
    expect(agentOutput.claim_type).toBe("choque");
    expect(agentOutput.policy_number).toBe("POL-1234");
  });

  it("un payload que no es un objeto vuelve sin tocar", () => {
    expect(ejemploSinDatosDeLaPersona(null as never)).toBe(null);
    expect(ejemploSinDatosDeLaPersona(42 as never)).toBe(42);
  });
});

describe("deEjemplos — tacha antes de armar el few-shot", () => {
  it("una fila guardada con el nombre real llega al prompt como «[NOMBRE]»", () => {
    const fila: FilaDeEjemplo = {
      id: "id-1",
      input_payload: { subject: "Choque", body: "Habla Martín Sosa por el siniestro." },
      expected_output: {
        confirmed_fields: [{ field_key: "full_name", field_value: "Martín Sosa", confidence: 0.9 }],
      },
    };

    const [ejemplo] = deEjemplos([fila], []);

    expect(ejemplo.input.body).toContain("[NOMBRE]");
    expect(ejemplo.input.body).not.toContain("Martín Sosa");
  });
});
