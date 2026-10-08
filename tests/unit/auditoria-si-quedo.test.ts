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
import { sql } from "drizzle-orm";
import { drizzle } from "drizzle-orm/pg-proxy";
import { auditoriaSiEsDerivacionNueva, auditoriaSiQuedo } from "@/server/cases/auditoria-si-quedo";

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

describe("auditoriaSiEsDerivacionNueva", () => {
  const consulta = () =>
    auditoriaSiEsDerivacionNueva(db as never, {
      caseId: "00000000-0000-0000-0000-000000000001",
      actorId: null,
      eventType: "claim.specialist_required",
      payload: sql<Record<string, unknown>>`'{"severity":"high"}'::jsonb`,
    }).toSQL();

  it("arma el INSERT ... SELECT con todas las columnas de audit_log y devuelve la fila", () => {
    const { sql: texto } = consulta();
    expect(texto).toMatch(/^insert into "audit_log" \("id", "tenant_id", .*"created_at"\) select /);
    expect(texto).toMatch(/returning "id"$/);
  });

  it("sólo inserta si el caso no tiene ya una derivación posterior a la ancla", () => {
    const { sql: texto } = consulta();
    expect(texto).toContain("not exists");
    expect(texto).toContain("greatest");
    expect(texto).toContain("x.event_type = 'claim.specialist_required'");
    expect(texto).toContain("x.created_at >");
  });

  it("la ancla la mueve una persona o una salida de los escalados, no Re-analizar", () => {
    const { sql: texto } = consulta();
    expect(texto).toContain("a.actor_id is not null");
    expect(texto).not.toContain("re_analyze_triggered");
    expect(texto).toContain("not in ('escalado', 'requiere_especialista')");
  });

  it("la extracción no mueve la ancla: el worker la anota después de derivar", () => {
    const { sql: texto } = consulta();
    expect(texto).toContain("a.event_type in ('case.status_changed'");
    expect(texto).not.toContain("ai.extraction_complete");
    expect(texto).not.toContain("ai.extracted");
  });
});
