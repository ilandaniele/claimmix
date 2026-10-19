/**
 * `esPermisoRevocado` decide si hay que mostrar la casilla vencida. Sólo vale
 * lo que Google llama `invalid_grant`: un 400 pelado también es un destinatario
 * malo o un pedido mal armado, y un 401 se arregla refrescando.
 */

import { describe, expect, it } from "vitest";
import { CASILLA_VENCIDA, esPermisoRevocado } from "@/core/gmail";

describe("CASILLA_VENCIDA", () => {
  it("es lo que contesta Google", () => {
    expect(CASILLA_VENCIDA).toBe("invalid_grant");
  });
});

describe("esPermisoRevocado", () => {
  it("el cuerpo de la respuesta de Google trae invalid_grant", () => {
    const err = {
      response: { status: 400, data: { error: "invalid_grant", error_description: "Token has been expired or revoked." } },
    };
    expect(esPermisoRevocado(err)).toBe(true);
  });

  it("el mensaje del error es invalid_grant", () => {
    expect(esPermisoRevocado(new Error("invalid_grant"))).toBe(true);
  });

  it("un ReAuth lo trae adentro de un JSON en el mensaje", () => {
    const reauth = JSON.stringify({ error: "invalid_grant", error_subtype: "invalid_rapt" });
    expect(esPermisoRevocado(new Error(reauth))).toBe(true);
  });

  it.each([
    ["un 400 que no es invalid_grant", { code: 400, response: { status: 400, data: { error: "invalid_request" } } }],
    ["un 400 sin cuerpo", Object.assign(new Error("Bad Request"), { code: 400 })],
    ["un 401", { code: 401 }],
    ["null", null],
    ["undefined", undefined],
    ["el texto suelto", "invalid_grant"],
  ])("%s no es un permiso revocado", (_, err) => {
    expect(esPermisoRevocado(err)).toBe(false);
  });
});
