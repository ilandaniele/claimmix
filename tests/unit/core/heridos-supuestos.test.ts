/**
 * «No hubo personas lastimadas», dicho por nadie.
 *
 * En el ensayo del 23/09 el bot le propuso ese «no» a quien nunca habló de
 * heridos, y un «ok» lo cerró. Si la persona no dijo nada, se le pregunta
 * abierto; si lo dijo, se respeta lo que entendió el modelo.
 */

import { describe, it, expect } from "vitest";

import {
  hablaDeHeridos,
  hayHeridos,
  respuestaAHeridos,
  sinHeridosSupuestos,
} from "@/core/case/heridos-supuestos";
import { extraccion } from "../../helpers/extraccion";

const campo = (field_key: string, field_value: string, confidence = 0.7) => ({
  field_key,
  field_value,
  confidence,
  source: "ai" as const,
});

const MINIMO = { extraction_model: "fixture", prompt_tokens: 0, completion_tokens: 0, cost_usd: 0 };

const SIN_HERIDOS = "Se me rompió el caño del baño y está todo mojado.";

describe("hablaDeHeridos", () => {
  it.each([
    "No hubo heridos",
    "nadie se lastimó",
    "mi hermana salió lastimada",
    "tiene una lesión en la pierna",
    "está lesionado",
    "salimos ilesos",
    // Negativos de verdad que el modelo leía bien y esto borraba.
    "Nadie, estamos todos bien",
    "Solo daños materiales",
    "nadie se hirió",
    "no nos pasó nada",
    "sin víctimas",
    "No injuries, nobody was hurt",
    "everyone is fine",
  ])("sí: %s", (texto) => {
    expect(hablaDeHeridos(texto)).toBe(true);
  });

  it.each([
    "que lastima lo del auto",
    SIN_HERIDOS,
    "un golpe en el paragolpes",
    // Fuera del léxico a propósito: cuesta una pregunta, no tapa nada.
    "la internaron con quemaduras",
    "fui víctima de un robo",
    "¿todo bien?",
  ])("no: %s", (texto) => {
    expect(hablaDeHeridos(texto)).toBe(false);
  });
});

describe("sinHeridosSupuestos", () => {
  it.each(["none", "no", "false", "sin heridos"])(
    "borra un «%s» que nadie dijo y deja la pregunta abierta",
    (valor) => {
      const claim = extraccion({
        ...MINIMO,
        fields: [campo("hay_heridos", valor), campo("accident_location", "Alem 100", 0.95)],
        fields_pending_confirmation: ["hay_heridos"],
      });

      const out = sinHeridosSupuestos(claim, SIN_HERIDOS);

      expect(out.fields.map((f) => f.field_key)).toEqual(["accident_location"]);
      expect(out.fields_pending_confirmation).toEqual(["hay_heridos"]);
    }
  );

  it("abre la pregunta aunque el negativo viniera seguro, bajo un alias", () => {
    const claim = extraccion({
      ...MINIMO,
      fields: [campo("injury_severity", "none", 0.95)],
      fields_pending_confirmation: ["accident_date"],
    });

    const out = sinHeridosSupuestos(claim, SIN_HERIDOS);

    expect(out.fields).toEqual([]);
    expect(out.fields_pending_confirmation).toEqual(["accident_date", "hay_heridos"]);
  });

  it("no duplica la pregunta si ya estaba pendiente con otro nombre", () => {
    const claim = extraccion({
      ...MINIMO,
      fields: [campo("heridos", "no")],
      fields_pending_confirmation: ["heridos"],
    });

    expect(sinHeridosSupuestos(claim, SIN_HERIDOS).fields_pending_confirmation).toEqual(["heridos"]);
  });

  it("pone en null una gravedad «none» supuesta, sin agregar pregunta", () => {
    const claim = extraccion({ ...MINIMO, fields: [], injury_severity: "none" });

    const out = sinHeridosSupuestos(claim, SIN_HERIDOS);

    expect(out.injury_severity).toBeNull();
    expect(out.fields_pending_confirmation).toEqual([]);
  });

  it("no toca un herido, aunque la persona no lo haya nombrado con esas palabras", () => {
    const claim = extraccion({
      ...MINIMO,
      fields: [campo("hay_heridos", "sí")],
      fields_pending_confirmation: ["hay_heridos"],
      injury_severity: "severe",
      severity: "high",
      missing_fields: ["dni"],
    });

    expect(sinHeridosSupuestos(claim, "la internaron con quemaduras")).toBe(claim);
  });

  it("respeta el negativo cuando la persona habló de heridos", () => {
    const claim = extraccion({
      ...MINIMO,
      fields: [campo("hay_heridos", "none")],
      injury_severity: "none",
    });

    expect(sinHeridosSupuestos(claim, "Choqué en Alem, no hubo heridos")).toBe(claim);
  });

  it("no cambia la gravedad del caso ni lo que falta", () => {
    const claim = extraccion({
      ...MINIMO,
      fields: [campo("hay_heridos", "none")],
      severity: "low",
      missing_fields: ["policy_number"],
    });

    const out = sinHeridosSupuestos(claim, SIN_HERIDOS);

    expect(out.severity).toBe("low");
    expect(out.missing_fields).toEqual(["policy_number"]);
    expect(claim.fields).toHaveLength(1);
  });
});

describe("respuestaAHeridos", () => {
  const sola = ["hay_heridos"];

  it.each([
    "No",
    "no.",
    "Nadie",
    "Ninguno",
    "No hubo",
    "Estamos todos bien",
    "no, solo el auto",
    "Nadie, estamos todos bien",
    "No 🙏",
    "Hola, no. Gracias",
    "No.\n\nSaludos,\nJuan Pérez",
  ])("no: %s", (texto) => {
    expect(respuestaAHeridos(sola, texto)).toBe("no");
  });

  it.each(["Sí", "si", "Sí, gracias", "Sí, mi hijo tiene un golpe"])("sí: %s", (texto) => {
    expect(respuestaAHeridos(sola, texto)).toBe("sí");
  });

  it.each([
    "No sé",
    "No tengo la póliza",
    "No, pero mi hijo se golpeó",
    "No, sólo mi hijo",
    "ok",
    "Si no me equivoco fue ayer",
    "Sí, no",
    "",
  ])("nada: %s", (texto) => {
    expect(respuestaAHeridos(sola, texto)).toBeNull();
  });

  it("con más cosas preguntadas, un «No» no dice a cuál", () => {
    expect(respuestaAHeridos(["dni", "hay_heridos"], "No")).toBeNull();
    expect(respuestaAHeridos([], "No")).toBeNull();
  });

  it("toma la pregunta bajo un alias", () => {
    expect(respuestaAHeridos(["heridos"], "No")).toBe("no");
  });

  // «¿Es correcto que no hubo personas lastimadas?» + «Sí» es «sí, nadie», y
  // + «No» es «sí hubo»: eso lo cierra la confirmación, con el valor a la vista.
  it.each([
    [{ hay_heridos: "none" }],
    [{ hay_heridos: "no" }],
    [{ hay_heridos: "sí" }],
    [{ injury_severity: "none" }],
  ])("no lee un «Sí» ni un «No» a un pedido con valor: %j", (propuestos) => {
    for (const texto of ["Sí", "No", "Nadie"]) {
      expect(respuestaAHeridos(sola, texto, propuestos)).toBeNull();
    }
  });

  it("lee la respuesta cuando lo pendiente se preguntó abierto", () => {
    expect(respuestaAHeridos(sola, "No", { hay_heridos: "" })).toBe("no");
    expect(respuestaAHeridos(sola, "Sí", { hay_heridos: "", dni: "30111222" })).toBe("sí");
  });

  // La firma sin «Saludos» arriba, y lo que manda después.
  it.each([
    ["No\nJuan Pérez\nTel 291 555-1234"],
    ["Nadie\nMaría José Gómez"],
    ["No\n\nJuan Pérez\n+54 9 291 555-1234\njuan@correo.com"],
    ["No\nEnviado desde mi iPhone"],
    [["No", "gracias"]],
    [["No", "[Imagen adjunta sin texto]"]],
    [["No", ""]],
    [["Nadie", "Estamos todos bien, gracias"]],
  ])("no: %j", (texto) => {
    expect(respuestaAHeridos(sola, texto)).toBe("no");
  });

  it.each([[["Sí", "gracias"]], ["Sí\nJuan Pérez"]])("sí: %j", (texto) => {
    expect(respuestaAHeridos(sola, texto)).toBe("sí");
  });

  // Lo que parece una firma pero habla de alguien no se tira.
  it.each([
    ["No\nSólo Mi Hijo"],
    ["No\nMi Hijo"],
    ["No\nHijo Lastimado"],
    ["No\nmi hijo se golpeó"],
    [["No", "mi hijo se golpeó"]],
    [["No", "Sí"]],
    [[]],
  ])("nada: %j", (texto) => {
    expect(respuestaAHeridos(sola, texto)).toBeNull();
  });
});

describe("sinHeridosSupuestos con la respuesta a la pregunta abierta", () => {
  it("un «no» cierra el campo aunque el texto no nombre heridos", () => {
    const claim = extraccion({
      ...MINIMO,
      fields: [campo("hay_heridos", "none")],
      fields_pending_confirmation: ["hay_heridos"],
      missing_fields: ["hay_heridos"],
      severity: "low",
    });

    const out = sinHeridosSupuestos(claim, "No", "no");

    expect(out.fields).toEqual([campo("hay_heridos", "no", 0.95)]);
    expect(out.fields_pending_confirmation).toEqual([]);
    expect(out.missing_fields).toEqual([]);
    expect(out.injury_severity).toBe("none");
    expect(out.severity).toBe("low");
  });

  it("un «sí» deja el campo, sube la gravedad y deriva", () => {
    const claim = extraccion({
      ...MINIMO,
      fields: [],
      fields_pending_confirmation: ["hay_heridos"],
      severity: "low",
    });

    const out = sinHeridosSupuestos(claim, "Sí", "sí");

    expect(out.fields).toEqual([campo("hay_heridos", "sí", 0.95)]);
    expect(out.fields_pending_confirmation).toEqual([]);
    expect(out.severity).toBe("high");
    expect(out.requires_specialist).toBe(true);
    expect(out.injury_severity).toBeNull();
  });

  it("un «sí» no baja una gravedad crítica", () => {
    const claim = extraccion({ ...MINIMO, fields: [], severity: "critical" });

    expect(sinHeridosSupuestos(claim, "Sí", "sí").severity).toBe("critical");
  });

  it("un «no» no tapa una herida que el modelo leyó", () => {
    const claim = extraccion({ ...MINIMO, fields: [], injury_severity: "minor", severity: "high" });

    expect(sinHeridosSupuestos(claim, "No", "no")).toBe(claim);
  });
});

/*
 * De acá sale si la derivación abre con la frase de cuidado. El «Sí» a la
 * pregunta abierta deriva con `injury_severity` en null: sólo el campo lo dice.
 */
describe("hayHeridos", () => {
  type Severidad = Parameters<typeof hayHeridos>[0]["injury_severity"];

  it.each(["minor", "severe", "fatal"] as const)("sí: injury_severity %s", (injury_severity) => {
    expect(hayHeridos({ injury_severity, fields: [] })).toBe(true);
  });

  it("sí: el campo en «sí» con la gravedad sin saber", () => {
    expect(hayHeridos({ injury_severity: null, fields: [campo("hay_heridos", "sí", 0.95)] })).toBe(true);
  });

  it("sí: un alias del campo", () => {
    expect(hayHeridos({ injury_severity: null, fields: [campo("heridos", "true")] })).toBe(true);
  });

  it("sí: en mayúsculas, porque `valorLegible` lee sin distinguir", () => {
    expect(hayHeridos({ injury_severity: "SEVERE" as Severidad, fields: [] })).toBe(true);
  });

  it.each([
    ["none, sin campo", "none", []],
    ["null, sin campo", null, []],
    ["null, campo «no»", null, [campo("hay_heridos", "no")]],
    ["null, campo «none»", null, [campo("hay_heridos", "none")]],
    ["otro campo en «sí»", null, [campo("testigos", "sí")]],
  ] as const)("no: %s", (_, injury_severity, fields) => {
    expect(hayHeridos({ injury_severity, fields: [...fields] })).toBe(false);
  });
});
