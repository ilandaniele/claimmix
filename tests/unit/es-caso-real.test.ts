// @vitest-environment node
/**
 * `esCasoReal` reconoce como reales los mismos canales que el resto del
 * sistema (`CANALES_REALES`): un canal nuevo que se sume ahí no puede quedar
 * afuera del export al Core.
 */

import { PgDialect } from "drizzle-orm/pg-core";
import { describe, expect, it } from "vitest";

import { CANALES_REALES } from "@/lib/schemas/cases";
import { esCasoReal } from "@/server/core-sync/lectura";

describe("esCasoReal", () => {
  it("lista exactamente los canales reales", () => {
    const canales = CANALES_REALES.map((c) => `'${c}'`).join(", ");
    expect(new PgDialect().sqlToQuery(esCasoReal).sql).toContain(`"cases"."channel" in (${canales})`);
  });
});
