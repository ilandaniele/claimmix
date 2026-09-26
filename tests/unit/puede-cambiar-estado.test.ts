/**
 * Quién cambia el estado de un caso (P6): un editor, y si es analista, sólo
 * el suyo.
 */

import { describe, it, expect } from "vitest";
import { puedeCambiarEstado } from "@/lib/auth/roles";

describe("puedeCambiarEstado", () => {
  it("un viewer nunca puede", () => {
    expect(puedeCambiarEstado({ role: "viewer", id: "u1" }, "u1")).toBe(false);
  });

  it("un analyst puede si el caso es suyo", () => {
    expect(puedeCambiarEstado({ role: "analyst", id: "u1" }, "u1")).toBe(true);
  });

  it("un analyst no puede si el caso está sin asignar", () => {
    expect(puedeCambiarEstado({ role: "analyst", id: "u1" }, null)).toBe(false);
  });

  it("un analyst no puede si el caso es de otro", () => {
    expect(puedeCambiarEstado({ role: "analyst", id: "u1" }, "u2")).toBe(false);
  });

  it.each(["owner", "admin", "specialist"])(
    "un %s puede, esté o no asignado el caso",
    (role) => {
      expect(puedeCambiarEstado({ role, id: "u1" }, null)).toBe(true);
      expect(puedeCambiarEstado({ role, id: "u1" }, "u2")).toBe(true);
    }
  );
});
