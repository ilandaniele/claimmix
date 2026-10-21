/**
 * La dirección que nunca recibe un aviso de caso urgente, ni siquiera si un
 * admin la carga en /configuracion o si queda en la variable de entorno.
 */

import { describe, it, expect } from "vitest";
import { casillaDeGmail, vedadaParaAlertas } from "@/lib/email/reserved";

describe("vedadaParaAlertas", () => {
  it("reconoce la dirección vedada, con puntos, mayúsculas y sub-direccionamiento", () => {
    expect(vedadaParaAlertas("ilan.daniele@gmail.com")).toBe(true);
    expect(vedadaParaAlertas("Ilan.Daniele@Gmail.com")).toBe(true);
    // googlemail.com, no gmail.com: es el mismo alias que valida reserved.ts,
    // y evita repetir la dirección real con otra ortografía (scripts/check-personal-data.sh).
    expect(vedadaParaAlertas("ilandaniele@googlemail.com")).toBe(true);
    expect(vedadaParaAlertas("i.lan.daniele+alertas@googlemail.com")).toBe(true);
    expect(vedadaParaAlertas("Ilan Daniele <ilan.daniele@gmail.com>")).toBe(true);
  });

  it("no confunde una dirección parecida, ni otro dominio", () => {
    expect(vedadaParaAlertas("ilan.daniele@otro.com")).toBe(false);
    expect(vedadaParaAlertas("ilan.daniele2@googlemail.com")).toBe(false);
    expect(vedadaParaAlertas("otra@googlemail.com")).toBe(false);
  });

  it("sin dirección, no", () => {
    expect(vedadaParaAlertas("")).toBe(false);
    expect(vedadaParaAlertas(null)).toBe(false);
    expect(vedadaParaAlertas(undefined)).toBe(false);
  });
});

describe("casillaDeGmail", () => {
  it("saca los puntos, el alias y las mayúsculas, y conserva el dominio", () => {
    expect(casillaDeGmail("Je.Fa+Admin@GoogleMail.com")).toBe("jefa@googlemail.com");
    expect(casillaDeGmail("jefa+a+b@googlemail.com")).toBe("jefa@googlemail.com");
    expect(casillaDeGmail("  jefa@googlemail.com ")).toBe("jefa@googlemail.com");
  });

  it.each([
    "Jefa <jefa+x@googlemail.com>",
    "x <jefa@googlemail.com>",
    '"jefa"@googlemail.com',
    "je fa@googlemail.com",
    "jefa(c)@googlemail.com",
    "jefa'x@googlemail.com",
    'jefa+"x"@googlemail.com',
    "jefa+(c)@googlemail.com",
    "jefa+a,b@googlemail.com",
    "jefa+<x>@googlemail.com",
    "jefa@icloud.com",
    "jefa@seguros.com.ar",
    "jefa@googlemail.com.ar",
    "jefa@sub.googlemail.com",
    "+x@googlemail.com",
    "",
    null,
    undefined,
  ])("%j no es una casilla de Gmail", (valor) => {
    expect(casillaDeGmail(valor)).toBeNull();
  });
});
