/**
 * La guarda del UPDATE que reasigna un caso. No hay base: se mira el SQL,
 * porque quien decide es el EXISTS bajo RLS.
 */

import { PgDialect } from "drizzle-orm/pg-core";
import { describe, expect, it } from "vitest";

import { guardaDeAsignacion } from "@/server/cases/guarda-de-asignacion";

const ANA = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
const sqlDe = (destino: string | null) => new PgDialect().sqlToQuery(guardaDeAsignacion(null, destino)!);

describe("guardaDeAsignacion", () => {
  it("sólo asigna a quien edita y no está de baja", () => {
    const q = sqlDe(ANA);
    expect(q.sql).toContain("EXISTS (SELECT 1 FROM");
    expect(q.sql).toContain('"users"."role" in');
    expect(q.sql).toContain('"users"."dado_de_baja_en" is null');
    expect(q.params).toContain(ANA);
  });

  it("desasignar no pregunta por nadie", () => {
    expect(sqlDe(null).sql).not.toContain("EXISTS");
  });
});
