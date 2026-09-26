import { describe, it, expect } from "vitest";

import {
  estadoDeRespuesta,
  vencimientoDeLaVentana,
  VENTANA_WHATSAPP_MS,
} from "@/core/whatsapp/puede-responder";

const AHORA = new Date("2026-09-25T12:00:00.000Z");

const BASE = {
  plan: "profesional",
  role: "analyst",
  channel: "whatsapp",
  status: "listo",
  ultimoEntrante: "2026-09-24T12:00:00.000Z", // exactamente 24 h antes de AHORA
  ahora: AHORA,
};

describe("estadoDeRespuesta", () => {
  it("habilita con Plan Pro, rol editor, canal WhatsApp, agente terminado y dentro de la ventana", () => {
    const r = estadoDeRespuesta({ ...BASE, ultimoEntrante: "2026-09-24T12:01:00.000Z" });
    expect(r).toEqual({ habilitada: true, motivo: null, vence_en: "2026-09-25T12:01:00.000Z" });
  });

  it("sin Plan Pro, motivo plan", () => {
    expect(estadoDeRespuesta({ ...BASE, plan: "piloto" })).toEqual({
      habilitada: false,
      motivo: "plan",
      vence_en: null,
    });
  });

  it.each(["viewer"])("con rol %s, motivo rol", (role) => {
    expect(estadoDeRespuesta({ ...BASE, role })).toEqual({
      habilitada: false,
      motivo: "rol",
      vence_en: null,
    });
  });

  it.each(["email", "email_sim"])("con canal %s, motivo canal", (channel) => {
    expect(estadoDeRespuesta({ ...BASE, channel })).toEqual({
      habilitada: false,
      motivo: "canal",
      vence_en: null,
    });
  });

  it.each(["recibido", "procesando", "info_faltante", "confirmacion_pendiente"])(
    "con el agente todavía en %s, motivo agente_activo",
    (status) => {
      expect(estadoDeRespuesta({ ...BASE, status })).toEqual({
        habilitada: false,
        motivo: "agente_activo",
        vence_en: null,
      });
    }
  );

  it("sin ningún entrante de WhatsApp todavía, motivo ventana", () => {
    expect(estadoDeRespuesta({ ...BASE, ultimoEntrante: null })).toEqual({
      habilitada: false,
      motivo: "ventana",
      vence_en: null,
    });
  });

  it("23:59 después del último entrante, todavía dentro de la ventana", () => {
    const ultimoEntrante = new Date(AHORA.getTime() - (VENTANA_WHATSAPP_MS - 60_000)).toISOString();
    const r = estadoDeRespuesta({ ...BASE, ultimoEntrante });
    expect(r.habilitada).toBe(true);
    expect(r.motivo).toBeNull();
  });

  it("24:01 después del último entrante, ya fuera de la ventana", () => {
    const ultimoEntrante = new Date(AHORA.getTime() - (VENTANA_WHATSAPP_MS + 60_000)).toISOString();
    expect(estadoDeRespuesta({ ...BASE, ultimoEntrante })).toEqual({
      habilitada: false,
      motivo: "ventana",
      vence_en: null,
    });
  });

  it("justo a las 24 h, ya fuera (borde estricto)", () => {
    const ultimoEntrante = new Date(AHORA.getTime() - VENTANA_WHATSAPP_MS).toISOString();
    expect(estadoDeRespuesta({ ...BASE, ultimoEntrante }).habilitada).toBe(false);
  });

  it("whatsapp_sim también cuenta como canal habilitado", () => {
    const r = estadoDeRespuesta({
      ...BASE,
      channel: "whatsapp_sim",
      ultimoEntrante: "2026-09-24T12:01:00.000Z",
    });
    expect(r.habilitada).toBe(true);
  });
});

describe("vencimientoDeLaVentana", () => {
  it("sin entrante todavía, null", () => {
    expect(vencimientoDeLaVentana(null, AHORA)).toBeNull();
  });

  it("dentro de la ventana, la fecha en la que vence", () => {
    const ultimoEntrante = "2026-09-24T12:01:00.000Z";
    const vence = vencimientoDeLaVentana(ultimoEntrante, AHORA);
    expect(vence?.toISOString()).toBe("2026-09-25T12:01:00.000Z");
  });

  it("justo a las 24 h, ya venció (borde estricto)", () => {
    const ultimoEntrante = new Date(AHORA.getTime() - VENTANA_WHATSAPP_MS).toISOString();
    expect(vencimientoDeLaVentana(ultimoEntrante, AHORA)).toBeNull();
  });

  it("un segundo antes de las 24 h, todavía no venció", () => {
    const ultimoEntrante = new Date(AHORA.getTime() - VENTANA_WHATSAPP_MS + 1000).toISOString();
    expect(vencimientoDeLaVentana(ultimoEntrante, AHORA)).not.toBeNull();
  });
});
