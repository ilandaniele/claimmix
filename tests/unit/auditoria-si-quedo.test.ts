/**
 * `auditoriaSiQuedo` con el constructor de consultas real de Drizzle, sin base.
 *
 * Los tests de `patchCase` simulan `db.insert`, así que nunca vieron que
 * `insert().select()` exige cada columna de la tabla, en el mismo orden. Sin
 * eso Drizzle tira antes de mandar nada, el batch entero cae, y la
 * confirmación de listo, la reapertura y «Devolver al agente» respondían
 * «El caso cambió mientras lo mirabas».
 */

import { describe, it, expect } from "vitest";
import { drizzle } from "drizzle-orm/pg-proxy";
import { auditoriaSiQuedo } from "@/server/cases/auditoria-si-quedo";

const db = drizzle(async () => ({ rows: [] }));

describe("auditoriaSiQuedo", () => {
  it("arma el INSERT ... SELECT con todas las columnas de audit_log", () => {
    const consulta = auditoriaSiQuedo(
      db as never,
      {
        caseId: "00000000-0000-0000-0000-000000000001",
        actorId: "00000000-0000-0000-0000-000000000002",
        eventType: "case.status_changed",
        payload: { reason: "devolver_al_agente" },
        ip: "anonymous",
        ua: null,
      },
      "info_faltante"
    );

    const { sql: texto } = consulta.toSQL();
    expect(texto).toMatch(/^insert into "audit_log" \("id", "tenant_id", .*"created_at"\) select /);
    expect(texto).toContain("nextval");
    // La hora la pone el trigger con now(): comparar contra otra no matchea nunca.
    expect(texto).toMatch(/"cases"."updated_at" = now()/);
  });
});
