/**
 * La dirección que nunca recibe un aviso de caso urgente, ni siquiera si un
 * admin la carga en /configuracion o si queda en la variable de entorno.
 */

import { describe, it, expect } from "vitest";
import { vedadaParaAlertas } from "@/lib/email/reserved";

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
