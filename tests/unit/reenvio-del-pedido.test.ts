/**
 * Funciones puras de P8: `decidirReenvio` y `clavesAbiertas`.
 *
 * `deFilasDelReenvio` no se testea acá directo: se arma `DatosDelReenvio` a
 * mano, que es lo que las dos funciones reciben.
 */

import { describe, it, expect } from "vitest";
import { decidirReenvio, clavesAbiertas, type DatosDelReenvio } from "@/server/confirmations/reenvio";
import { AuditEvent } from "@/lib/audit/log";

const AHORA = new Date("2026-09-25T12:00:00.000Z");

function datos(overrides: Partial<DatosDelReenvio> = {}): DatosDelReenvio {
  return {
    caso: {
      id: "caso-1",
      status: "info_faltante",
      channel: "email",
      assigned_to: null,
      updated_at: "2026-09-01T00:00:00.000Z",
      closed_at: null,
    },
    destinatario: "juan@x.com",
    ultimoEntrante: "2026-09-25T00:00:00.000Z",
    pedido: { claves: ["full_name"], enviado: "2026-09-01T00:00:00.000Z" },
    campos: [],
    docsAbiertos: [],
    confirmaciones: [],
    ultimoCierre: null,
    ...overrides,
  };
}

describe("decidirReenvio — cada motivo, en orden", () => {
  it("sin caso, motivo estado", () => {
    expect(decidirReenvio(datos({ caso: null }), AHORA, false)).toEqual({ ok: false, motivo: "estado" });
  });

  it("estado que no es abandonable ni cerrado, motivo estado", () => {
    const d = datos({ caso: { ...datos().caso!, status: "listo" } });
    expect(decidirReenvio(d, AHORA, false)).toEqual({ ok: false, motivo: "estado" });
  });

  it("cerrado con el último cierre por una persona y reabrir, cierre_no_es_abandono", () => {
    const d = datos({
      caso: { ...datos().caso!, status: "cerrado" },
      ultimoCierre: AuditEvent.CASE_CLOSED,
    });
    expect(decidirReenvio(d, AHORA, true)).toEqual({ ok: false, motivo: "cierre_no_es_abandono" });
  });

  it("cerrado sin pedir reabrir, cierre_no_es_abandono", () => {
    const d = datos({
      caso: { ...datos().caso!, status: "cerrado" },
      ultimoCierre: AuditEvent.CASE_CLOSED_ABANDONED,
    });
    expect(decidirReenvio(d, AHORA, false)).toEqual({ ok: false, motivo: "cierre_no_es_abandono" });
  });

  it("cerrado por abandono y reabrir, reabre true", () => {
    const d = datos({
      caso: { ...datos().caso!, status: "cerrado" },
      ultimoCierre: AuditEvent.CASE_CLOSED_ABANDONED,
    });
    const r = decidirReenvio(d, AHORA, true);
    expect(r.ok).toBe(true);
    expect(r.ok && r.reabre).toBe(true);
  });

  it("sin destinatario, sin_destinatario", () => {
    expect(decidirReenvio(datos({ destinatario: null }), AHORA, false)).toEqual({
      ok: false,
      motivo: "sin_destinatario",
    });
  });

  it("WhatsApp a 23 h del último entrante, sigue habilitado", () => {
    const d = datos({
      caso: { ...datos().caso!, channel: "whatsapp" },
      ultimoEntrante: new Date(AHORA.getTime() - 23 * 60 * 60 * 1000).toISOString(),
    });
    expect(decidirReenvio(d, AHORA, false).ok).toBe(true);
  });

  it("WhatsApp a 25 h del último entrante, ventana_cerrada", () => {
    const d = datos({
      caso: { ...datos().caso!, channel: "whatsapp" },
      ultimoEntrante: new Date(AHORA.getTime() - 25 * 60 * 60 * 1000).toISOString(),
    });
    expect(decidirReenvio(d, AHORA, false)).toEqual({ ok: false, motivo: "ventana_cerrada" });
  });

  it("mail ignora la ventana de WhatsApp", () => {
    const d = datos({
      caso: { ...datos().caso!, channel: "email" },
      ultimoEntrante: new Date(AHORA.getTime() - 25 * 60 * 60 * 1000).toISOString(),
    });
    expect(decidirReenvio(d, AHORA, false).ok).toBe(true);
  });

  it("nada pedido, nada_pendiente", () => {
    expect(decidirReenvio(datos({ pedido: { claves: [], enviado: null } }), AHORA, false)).toEqual({
      ok: false,
      motivo: "nada_pendiente",
    });
  });

  it("pedido hace menos de 10 minutos, reciente", () => {
    const d = datos({
      pedido: { claves: ["full_name"], enviado: new Date(AHORA.getTime() - 5 * 60 * 1000).toISOString() },
    });
    expect(decidirReenvio(d, AHORA, false)).toEqual({ ok: false, motivo: "reciente" });
  });

  it("todo en orden, ok true con las claves abiertas", () => {
    const r = decidirReenvio(datos(), AHORA, false);
    expect(r.ok).toBe(true);
    expect(r.ok && r.claves).toEqual(["full_name"]);
    expect(r.ok && r.reabre).toBe(false);
    expect(r.ok && r.to).toBe("juan@x.com");
  });
});

describe("clavesAbiertas", () => {
  const HOY = "2026-09-25";

  it("un campo confirmado queda cerrado", () => {
    const d = datos({
      pedido: { claves: ["full_name"], enviado: null },
      confirmaciones: [{ field_name: "full_name", status: "confirmed", suggested_value: "Juan Pérez" }],
    });
    expect(clavesAbiertas(d, HOY).claves).toEqual([]);
  });

  it("una clave de dato a 0.95, con missing_docs abierto para esa clave, queda cerrada", () => {
    const d = datos({
      pedido: { claves: ["patente_vehiculo"], enviado: null },
      campos: [{ field_key: "patente_vehiculo", field_value: "ABC123", confidence: 0.95 }],
      docsAbiertos: ["patente_vehiculo"],
    });
    expect(clavesAbiertas(d, HOY).claves).toEqual([]);
  });

  it("una clave de dato a 0.7 queda abierta con su valor conocido", () => {
    const d = datos({
      pedido: { claves: ["patente_vehiculo"], enviado: null },
      campos: [{ field_key: "patente_vehiculo", field_value: "ABC123", confidence: 0.7 }],
    });
    const r = clavesAbiertas(d, HOY);
    expect(r.claves).toEqual(["patente_vehiculo"]);
    expect(r.conocidos.patente_vehiculo).toBe("ABC123");
  });

  it("un documento con missing_docs abierto queda abierto", () => {
    const d = datos({
      pedido: { claves: ["fotos_danos"], enviado: null },
      docsAbiertos: ["fotos_danos"],
    });
    expect(clavesAbiertas(d, HOY).claves).toEqual(["fotos_danos"]);
  });

  it("un documento sin fila abierta en missing_docs queda cerrado", () => {
    const d = datos({
      pedido: { claves: ["fotos_danos"], enviado: null },
      docsAbiertos: [],
    });
    expect(clavesAbiertas(d, HOY).claves).toEqual([]);
  });

  it("party_a_plate a 0.9 cierra patente_vehiculo", () => {
    const d = datos({
      pedido: { claves: ["patente_vehiculo"], enviado: null },
      campos: [{ field_key: "party_a_plate", field_value: "ABC123", confidence: 0.9 }],
    });
    expect(clavesAbiertas(d, HOY).claves).toEqual([]);
  });

  it("un valor vago no se ofrece como conocido", () => {
    const d = datos({
      pedido: { claves: ["hora_siniestro"], enviado: null },
      campos: [{ field_key: "hora_siniestro", field_value: "no me acuerdo", confidence: 0.7 }],
    });
    const r = clavesAbiertas(d, HOY);
    expect(r.claves).toEqual(["hora_siniestro"]);
    expect(r.conocidos.hora_siniestro).toBeUndefined();
  });
});
