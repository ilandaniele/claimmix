/**
 * El conjunto de ejemplos con el que se entrena, sin importar contra quién.
 *
 * Esto estaba escrito dos veces, idéntico, en `fine-tuning.ts` y en
 * `vertex-ai-fine-tuning.ts`. Lo que cambia de verdad entre los dos proveedores
 * es el FORMATO de cada línea del JSONL —uno quiere `messages`, el otro
 * `contents`— y eso se queda en cada módulo. Qué ejemplos entran, cómo se
 * deduplican y cómo se arma la salida esperada es la misma decisión para los
 * dos: si mañana se decide incluir también los ejemplos revisados por un
 * especialista, tiene que cambiar en un solo lugar.
 */

import "server-only";

import { createHash } from "crypto";
import { and, desc, eq, inArray } from "drizzle-orm";

import { enTenant, type TenantContext } from "@/data/scope";
import { tables } from "@/lib/db";

/**
 * Huella de un ejemplo, para descartar repetidos.
 *
 * Sobre el contenido y no sobre el id: dos filas distintas con el mismo par
 * entrada/salida le enseñan al modelo lo mismo dos veces, que es peor que
 * enseñárselo una — le da más peso a un caso por el accidente de haberse
 * cargado dos veces.
 */
export function stableHash(value: unknown): string {
  return createHash("sha256").update(JSON.stringify(value)).digest("hex");
}

/**
 * La salida que se le pide al modelo, a partir de lo que quedó guardado.
 *
 * Si un humano confirmó campos, esos ganan sobre lo que había propuesto el
 * agente: entrenar contra la propuesta original sería enseñarle a repetir el
 * error que alguien ya corrigió.
 */
export function buildExpectedOutput(
  expectedOutput: Record<string, unknown>
): Record<string, unknown> {
  const agentOutput =
    expectedOutput.agent_output && typeof expectedOutput.agent_output === "object"
      ? { ...(expectedOutput.agent_output as Record<string, unknown>) }
      : { ...expectedOutput };

  const confirmed = Array.isArray(expectedOutput.confirmed_fields)
    ? expectedOutput.confirmed_fields
    : [];
  if (confirmed.length > 0) {
    agentOutput.fields = confirmed;
  }
  return agentOutput;
}

export interface TrainingExample {
  id: string;
  input_payload: Record<string, unknown>;
  expected_output: Record<string, unknown>;
  created_at: string;
}

/** Sólo casos simulados: con datos de personas reales no se entrena un modelo. */
export async function approvedExamplesForTenant(
  tenantId: string
): Promise<TrainingExample[]> {
  // Las consultas de acá ya no llevan filtro por inquilino: lo pone la base.
  const tenantCtx: TenantContext = { tenantId };
  const t = tables.trainingExamples;

  const rows = await enTenant(tenantCtx, (db) =>
    db
      .select({
        id: t.id,
        input_payload: t.input_payload,
        expected_output: t.expected_output,
        created_at: t.created_at,
      })
      .from(t)
      .innerJoin(tables.cases, eq(tables.cases.id, t.case_id))
      .where(
        and(
          eq(t.status, "approved"),
          inArray(tables.cases.channel, ["email_sim", "whatsapp_sim"])
        )
      )
      .orderBy(desc(t.created_at))
      .limit(500)
  );

  const seen = new Set<string>();
  return rows
    .map((row) => ({
      ...row,
      input_payload: (row.input_payload ?? {}) as Record<string, unknown>,
      expected_output: (row.expected_output ?? {}) as Record<string, unknown>,
    }))
    .filter((row) => {
      const hash = stableHash([row.input_payload, row.expected_output]);
      if (seen.has(hash)) return false;
      seen.add(hash);
      return true;
    }) as TrainingExample[];
}
