/**
 * Qué filas de auditoría cuentan el trayecto de un caso (B14, B15, B22).
 *
 * `ES_INTERVENCION` es un `Record` exhaustivo sobre `AuditEventType`: el
 * compilador ya obliga a decidir cada evento nuevo. Lo que se prueba acá es lo
 * que el compilador no ve: que no sobren claves, que las decisiones que
 * mueven el número sigan siendo esas, y que los nombres sean escribibles en el
 * SQL como literales.
 */

import { describe, it, expect } from "vitest";
import { AuditEvent } from "@/lib/audit/log";
import { EVENTOS_DE_INTERVENCION, ES_INTERVENCION } from "@/core/metricas/intervencion";
import {
  EVENTOS_CON_ESTADO,
  EVENTOS_DE_TRAYECTO,
  EXTRACCION_INTERMEDIA,
} from "@/core/metricas/transiciones";

const NOMBRE_LITERAL = /^[a-z_.]+$/;

describe("ES_INTERVENCION", () => {
  it("decide cada evento de auditoría, y sólo esos", () => {
    expect(Object.keys(ES_INTERVENCION).sort()).toEqual(Object.values(AuditEvent).sort());
  });

  it("lo que hace una persona desde la pantalla interviene", () => {
    for (const e of [
      AuditEvent.CASE_STATUS_CHANGED,
      AuditEvent.CASE_CLOSED,
      AuditEvent.CASE_ASSIGNED,
      AuditEvent.CASE_HUMAN_REPLY,
      AuditEvent.CASE_MARKED_ANSWERED,
      AuditEvent.CASE_READY_CONFIRMED,
    ]) {
      expect(ES_INTERVENCION[e], e).toBe(true);
    }
  });

  it("lo que hace el agente o un proceso no interviene", () => {
    for (const e of [
      "ai.extraction_started",
      "ai.extraction_complete",
      "doc.received",
      "claim.specialist_alerted",
      "claim.reminder_sent",
      "assistant.query",
    ] as const) {
      expect(ES_INTERVENCION[e], e).toBe(false);
    }
  });

  it("el reanálisis, que no es un AuditEvent, se suma a mano", () => {
    expect(EVENTOS_DE_INTERVENCION).toContain("case.re_analyze_triggered");
    expect(new Set(EVENTOS_DE_INTERVENCION).size).toBe(EVENTOS_DE_INTERVENCION.length);
  });
});

describe("los nombres que viajan como literales en el SQL", () => {
  it("todos los eventos del trayecto pasan la validación de `literales`", () => {
    for (const e of EVENTOS_DE_TRAYECTO) expect(e, e).toMatch(NOMBRE_LITERAL);
    for (const e of EVENTOS_DE_INTERVENCION) expect(e, e).toMatch(NOMBRE_LITERAL);
  });

  it("el trayecto no repite eventos, y contiene los de estado y los de intervención", () => {
    expect(new Set(EVENTOS_DE_TRAYECTO).size).toBe(EVENTOS_DE_TRAYECTO.length);
    for (const e of [...EVENTOS_CON_ESTADO, ...EVENTOS_DE_INTERVENCION]) {
      expect(EVENTOS_DE_TRAYECTO).toContain(e);
    }
  });

  it("los eventos que dan estado son eventos que el sistema escribe de verdad", () => {
    const conocidos = new Set<string>(Object.values(AuditEvent));
    for (const e of EVENTOS_CON_ESTADO) expect(conocidos.has(e), e).toBe(true);
  });

  it("el `listo` intermedio de la extracción es de un evento con estado", () => {
    expect(EVENTOS_CON_ESTADO).toContain(EXTRACCION_INTERMEDIA.evento);
    expect(EXTRACCION_INTERMEDIA.estado).toBe("listo");
  });
});
