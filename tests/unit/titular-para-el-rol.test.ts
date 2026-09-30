/**
 * El titular de un caso según quién lo mira: la agenda y los desvíos lo listan
 * y los dos tapan el nombre igual, con una sola función.
 */

vi.mock("server-only", () => ({}));

import { describe, expect, it, vi } from "vitest";
import { CUSTOMER_PII_ROLES } from "@/lib/auth/roles";
import { OCULTO, titularParaElRol } from "@/server/cases/pii";

describe("titularParaElRol", () => {
  it.each(CUSTOMER_PII_ROLES)("%s ve el nombre", (rol) => {
    expect(titularParaElRol("Ana Pérez", rol)).toBe("Ana Pérez");
  });

  it.each(["analyst", "viewer", "rol_que_no_existe", ""])("«%s» ve OCULTO donde hay un nombre", (rol) => {
    expect(titularParaElRol("Ana Pérez", rol)).toBe(OCULTO);
  });

  it("donde no hay nombre no hay nada que tapar: sigue vacío para todos", () => {
    for (const rol of [...CUSTOMER_PII_ROLES, "analyst"]) expect(titularParaElRol(null, rol)).toBeNull();
  });

  it("un nombre vacío tampoco se tapa a quien no puede verlo, y no se inventa uno a quien sí", () => {
    expect(titularParaElRol("", "analyst")).toBeNull();
    expect(titularParaElRol("", "owner")).toBe("");
  });
});
