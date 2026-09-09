import "server-only";

import { and, eq, sql } from "drizzle-orm";
import { db, tables } from "@/lib/db";
import { enTenant, type ClienteDatos, type TenantContext } from "@/data/scope";

const TRAINING_LIMIT = 8_000;

export interface FilaDeEntrenamiento {
  content: string | null;
}

/**
 * La consulta sola, para poder mandarla en un lote con las otras.
 *
 * El worker carga siete cosas antes de llamar al modelo y cada una era su
 * propio viaje a Neon. Separar el armado de la ejecución las deja ir juntas
 * sin copiar la consulta en dos lugares. Ver `cargarLoDelPrompt` en el worker.
 */
export function consultaAgentTraining(db: ClienteDatos) {
  const t = tables.agentTraining;
  return db
    .select({ content: t.content })
    .from(t)
    .where(eq(t.enabled, true))
    .orderBy(sql`${t.updated_at} DESC NULLS LAST`)
    .limit(5);
}

/** Lo que va al prompt, de las filas que devuelve la consulta de arriba. */
export function deAgentTraining(filas: FilaDeEntrenamiento[]): string {
  return filas
    .map((row) => row.content?.trim() ?? "")
    .filter(Boolean)
    .join("\n\n---\n\n")
    .slice(0, TRAINING_LIMIT);
}

export async function loadAgentTraining(tenantId: string): Promise<string> {
  // Las consultas de acá ya no llevan filtro por inquilino: lo pone la base.
  const tenantCtx: TenantContext = { tenantId };
  try {
    return deAgentTraining(await enTenant(tenantCtx, consultaAgentTraining));
  } catch (e) {
    console.error("[agent-training] load error:", (e as { code?: string })?.code);
    return "";
  }
}
