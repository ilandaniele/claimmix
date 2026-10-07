/**
 * La clave del cupo de un remitente, sin el remitente en claro.
 *
 * `rate_limit_counters` no tiene RLS por inquilino: un teléfono o una dirección
 * escritos ahí los lee cualquiera con acceso a la tabla. La clave lleva el hash.
 */

import { describe, expect, it } from "vitest";
import { createHash } from "node:crypto";
import { claveDelRemitente } from "@/lib/rate-limit/remitente";

const TENANT = "10000000-0000-0000-0000-000000000001";

describe("claveDelRemitente", () => {
  it("la de WhatsApp es la de siempre: «whatsapp:» más 32 hex de inquilino, canal y teléfono", () => {
    const huella = createHash("sha256").update(`${TENANT}:whatsapp:5490000000001`).digest("hex").slice(0, 32);

    expect(claveDelRemitente("whatsapp", TENANT, "whatsapp", "5490000000001")).toBe(`whatsapp:${huella}`);
  });

  it("la de mail es «email:» más 32 hex, sin la dirección ni el inquilino", () => {
    const clave = claveDelRemitente("email", TENANT, "email", "persona@example.com");

    expect(clave).toMatch(/^email:[0-9a-f]{32}$/);
    expect(clave).not.toContain("persona");
    expect(clave).not.toContain("example");
    expect(clave).not.toContain(TENANT);
  });

  it("es estable: el mismo remitente cae siempre en la misma cubeta", () => {
    expect(claveDelRemitente("email", TENANT, "email", "persona@example.com")).toBe(
      claveDelRemitente("email", TENANT, "email", "persona@example.com")
    );
  });

  it("cambia con el remitente, el inquilino y el canal", () => {
    const base = claveDelRemitente("email", TENANT, "email", "persona@example.com");

    expect(claveDelRemitente("email", TENANT, "email", "otra@example.com")).not.toBe(base);
    expect(claveDelRemitente("email", "10000000-0000-0000-0000-000000000002", "email", "persona@example.com")).not.toBe(
      base
    );
    expect(claveDelRemitente("email", TENANT, "email_sim", "persona@example.com")).not.toBe(base);
  });

  it("no normaliza el remitente: quien la arma lo pasa ya normalizado (bareAddress)", () => {
    expect(claveDelRemitente("email", TENANT, "email", "Persona@Example.com")).not.toBe(
      claveDelRemitente("email", TENANT, "email", "persona@example.com")
    );
  });
});
