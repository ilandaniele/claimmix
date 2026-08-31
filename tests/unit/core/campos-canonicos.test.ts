/**
 * Los sinónimos del extractor, resueltos antes de buscar a la persona.
 *
 * El buscador de clientes lee `fields.dni`, `fields.email`, `fields.phone` y
 * `fields.policy_number`. El extractor manda esos nombres o los de al lado
 * —`dni_asegurado`, `telefono_contacto`, `numero_poliza`— según el día. Cuando
 * elegía el segundo, la búsqueda daba cero y nadie se enteraba: la persona había
 * dado su DNI y le pedíamos de nuevo lo que acababa de dar.
 */

import { describe, it, expect } from "vitest";

import { canonizarCampos } from "@/core/case/campos-canonicos";

const CANONICAS = ["dni", "phone", "policy_number", "full_name"];

function campo(field_key: string, field_value: string) {
  return { field_key, field_value };
}

describe("canonizarCampos", () => {
  it("un alias llena también la clave canónica", () => {
    const r = canonizarCampos([campo("dni_asegurado", "27654321")], null, CANONICAS);

    expect(r.dni).toBe("27654321");
    // Y la cruda sigue donde estaba: hay código que lee por nombre.
    expect(r.dni_asegurado).toBe("27654321");
  });

  it("resuelve los cuatro sinónimos por los que se busca a una persona", () => {
    const r = canonizarCampos(
      [
        campo("dni_asegurado", "27654321"),
        campo("telefono_contacto", "+5491100000000"),
        campo("numero_poliza", "POL-8812-R"),
        campo("nombre_asegurado", "Cecilia Ferrari"),
      ],
      null,
      CANONICAS
    );

    expect(r.dni).toBe("27654321");
    expect(r.phone).toBe("+5491100000000");
    expect(r.policy_number).toBe("POL-8812-R");
    expect(r.full_name).toBe("Cecilia Ferrari");
  });

  it("el alias NO pisa a la canónica cuando vienen las dos", () => {
    /*
     * Un mismo mensaje produce de rutina las dos con el mismo valor. Cuando
     * difieren, la canónica es la que el resto del sistema viene leyendo, y
     * cambiarla por atrás sería mover el dato sin que nadie lo pida.
     */
    const r = canonizarCampos(
      [campo("dni", "11111111"), campo("dni_asegurado", "99999999")],
      null,
      CANONICAS
    );

    expect(r.dni).toBe("11111111");
  });

  it("y tampoco importa el orden en que vengan", () => {
    // La otra mitad: si el alias llegara primero, ganaría por ser el último en
    // escribir. La clave cruda se asigna siempre, así que la canónica real pisa.
    const r = canonizarCampos(
      [campo("dni_asegurado", "99999999"), campo("dni", "11111111")],
      null,
      CANONICAS
    );

    expect(r.dni).toBe("11111111");
  });

  it("una canónica vacía sí la llena el alias", () => {
    // Un `""` no es un valor que haya que proteger: es la ausencia del dato.
    const r = canonizarCampos(
      [campo("dni", ""), campo("dni_asegurado", "27654321")],
      null,
      CANONICAS
    );

    expect(r.dni).toBe("27654321");
  });

  it("un alias sin valor no inventa la canónica", () => {
    const r = canonizarCampos([campo("dni_asegurado", "")], null, CANONICAS);

    expect(r.dni).toBeUndefined();
  });

  it("`extracted_fields` se superpone al final, pero sólo con valor", () => {
    /*
     * A esta altura `fields[]` ya trae lo que salió de la hidratación y del
     * parser de respaldo. Un `""` del modelo —que los manda— borraría un valor
     * que sí encontramos en el texto, y el buscador se quedaría justo sin la
     * clave por la que iba a encontrar a la persona.
     */
    /*
     * Los dos teléfonos tienen que ser DISTINTOS, o el test no distingue nada.
     *
     * Al cambiar el número inventado por el del bloque de ejemplo, los dos lados
     * quedaron con el mismo valor un momento y la afirmación pasaba a ser cierta
     * pasara lo que pasara. Los dos que están acá son del bloque permitido y no
     * son de nadie.
     */
    const r = canonizarCampos(
      [campo("dni", "27654321"), campo("phone", "+549110000000")],
      { dni: "", phone: "+5491100000000" },
      CANONICAS
    );

    // El `""` NO borra el valor que salió del texto…
    expect(r.dni).toBe("27654321");
    // …y el valor que sí trajo el modelo SÍ pisa al anterior.
    expect(r.phone).toBe("+5491100000000");
  });

  it("sin campos devuelve un diccionario vacío, no undefined", () => {
    expect(canonizarCampos([], null, CANONICAS)).toEqual({});
  });

  it("una clave que no es alias de nada queda tal cual", () => {
    const r = canonizarCampos([campo("hora_siniestro", "14:30")], null, CANONICAS);

    expect(r.hora_siniestro).toBe("14:30");
  });
});
