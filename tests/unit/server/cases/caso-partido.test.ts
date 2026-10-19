/** Constructores de SQL del caso partido por un siniestro nuevo. */

import { describe, it, expect } from "vitest";
import { PgDialect } from "drizzle-orm/pg-core";
import { cases } from "@/lib/db/schema";
import { casoDondeEstaHoy, casoQueSigue, fuePartido } from "@/server/cases/caso-partido";

const dialecto = new PgDialect();

describe("fuePartido", () => {
  it("mira la auditoría del caso de afuera", () => {
    const { sql, params } = dialecto.sqlToQuery(fuePartido(cases.id));
    expect(sql).toContain('"cases"."id"::text');
    expect(sql).toContain("exists (select 1 from audit_log p");
    expect(params).toEqual(["claim.late_message_split"]);
  });
});

describe("casoDondeEstaHoy", () => {
  it("lee el caso del mensaje con lock y cae en el de entrada", () => {
    const { sql, params } = dialecto.sqlToQuery(casoDondeEstaHoy("m", "c"));
    expect(sql).toContain("for share)");
    expect(sql).toContain("coalesce(");
    expect(params).toEqual(["m", "c"]);
  });
});

describe("casoQueSigue", () => {
  it("sigue al caso nuevo del corte, o se queda en el mismo", () => {
    const { sql, params } = dialecto.sqlToQuery(casoQueSigue("c"));
    expect(sql).toContain("'caso_nuevo'");
    expect(sql).toContain("limit 1");
    expect(params).toEqual(["c", "claim.late_message_split", "c"]);
  });
});
