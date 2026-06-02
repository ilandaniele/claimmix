/**
 * Unit tests for PII redaction utilities.
 *
 * AC18: Logs must not contain DNI, policy numbers, or license plates.
 */

import { describe, it, expect } from "vitest";
import { redactString, redactObject } from "@/lib/audit/redact";

describe("redactString", () => {
  it("redacts Argentine DNI with dots (XX.XXX.XXX)", () => {
    const input = "El asegurado con DNI 35.123.456 presentó la denuncia.";
    const result = redactString(input);
    expect(result).toContain("[DNI]");
    expect(result).not.toContain("35.123.456");
  });

  it("redacts Argentine DNI without dots (XXXXXXXX)", () => {
    const input = "DNI 35123456 del solicitante.";
    const result = redactString(input);
    expect(result).toContain("[DNI]");
    expect(result).not.toContain("35123456");
  });

  it("redacts Argentine DNI with partial dots (X.XXX.XXX)", () => {
    const input = "Número de documento: 8.456.789";
    const result = redactString(input);
    expect(result).toContain("[DNI]");
    expect(result).not.toContain("8.456.789");
  });

  it("redacts policy number in POL-YYYY-NNN format", () => {
    const input = "Póliza POL-2024-001 registrada.";
    const result = redactString(input);
    expect(result).toContain("[POLIZA]");
    expect(result).not.toContain("POL-2024-001");
  });

  it("redacts license plate (ABC 123 format)", () => {
    const input = "El vehículo de patente ABC 123 estaba en la escena.";
    const result = redactString(input);
    expect(result).toContain("[PATENTE]");
    expect(result).not.toContain("ABC 123");
  });

  it("does not redact regular text", () => {
    const input = "El siniestro ocurrió el martes por la tarde.";
    const result = redactString(input);
    expect(result).toBe(input);
  });

  it("redacts multiple PII patterns in one string", () => {
    const input =
      "DNI 29.876.543 chocó contra el auto patente XYZ 789 (POL-2024-007).";
    const result = redactString(input);
    expect(result).not.toContain("29.876.543");
    expect(result).not.toContain("XYZ 789");
    expect(result).not.toContain("POL-2024-007");
  });

  it("handles empty string", () => {
    expect(redactString("")).toBe("");
  });
});

describe("redactObject", () => {
  it("redacts string values in a flat object", () => {
    const obj = {
      event: "auth.failure",
      note: "DNI 35.123.456 intentó ingresar",
    };
    const result = redactObject(obj);
    expect(result.note).not.toContain("35.123.456");
    expect(result.event).toBe("auth.failure");
  });

  it("redacts string values in nested objects", () => {
    const obj = {
      outer: "normal text",
      inner: {
        detail: "Póliza POL-2024-001 del asegurado",
      },
    };
    const result = redactObject(obj);
    const inner = result.inner as Record<string, unknown>;
    expect(inner.detail).not.toContain("POL-2024-001");
    expect(result.outer).toBe("normal text");
  });

  it("does not mutate the original object", () => {
    const obj = { message: "DNI 35.123.456 presente" };
    const result = redactObject(obj);
    expect(obj.message).toContain("35.123.456"); // original unchanged
    expect(result.message).not.toContain("35.123.456");
  });

  it("leaves non-string values unchanged", () => {
    const obj = {
      count: 42,
      active: true,
      items: ["a", "b"],
      nullVal: null,
    };
    const result = redactObject(obj);
    expect(result.count).toBe(42);
    expect(result.active).toBe(true);
    expect(result.items).toEqual(["a", "b"]);
    expect(result.nullVal).toBeNull();
  });
});
