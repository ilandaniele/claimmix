/**
 * Qué le pidió el último mensaje que salió.
 *
 * Vive aparte del orquestador porque también lo lee el worker, después de
 * extraer y antes de guardar: un «No» suelto contesta lo que le preguntamos, y
 * el modelo no ve la pregunta. El worker se lo pasa al orquestador, así que
 * sigue siendo una consulta.
 */

import "server-only";

import { and, desc, eq, inArray, isNotNull } from "drizzle-orm";
import { enTenant, enTenantVarias, type ClienteDatos } from "@/data/scope";
import { claimFieldConfirmations, outboundMessages } from "@/lib/db/schema";
import { firstRow } from "@/lib/db/helpers";
import { logger } from "@/lib/observability/logger";

type FilaDelPedido = { asked_keys: string[] | null; created_at: string };

export function consultaDelPedido(db: ClienteDatos, caseId: string) {
  return db
    .select({ asked_keys: outboundMessages.asked_keys, created_at: outboundMessages.created_at })
    .from(outboundMessages)
    .where(
      and(
        eq(outboundMessages.case_id, caseId),
        // A simulated message counts. It is the message that would have
        // gone out, composed by the same writer, and a rehearsal in which
        // the agent never remembers having spoken is rehearsing something
        // other than production.
        inArray(outboundMessages.status, ["sent", "skipped_simulated"]),
        isNotNull(outboundMessages.asked_keys)
      )
    )
    .orderBy(desc(outboundMessages.created_at))
    .limit(1);
}

function noSeLeyo(err: unknown): void {
  const code = (err as { code?: string })?.code ?? (err instanceof Error ? err.name : "UnknownError");
  logger.error({ code }, "orchestrate.failed_to_read_the_last_ask");
}

/**
 * What the last message we actually sent asked for.
 *
 * Empty when nothing has gone out, or on any failure: the safe direction is to
 * believe we have never asked. A repeated question is a nuisance; a claim that
 * waits forever because we wrongly believed we had asked is a claim nobody is
 * working on.
 */
export async function lastAskedKeys(caseId: string, tenantId: string): Promise<string[]> {
  // Las consultas de acá ya no llevan filtro por inquilino: lo pone la base.
  try {
    const last = firstRow(await enTenant({ tenantId }, (db) => consultaDelPedido(db, caseId)));
    return last?.asked_keys ?? [];
  } catch (err) {
    noSeLeyo(err);
    return [];
  }
}

export interface UltimoPedido {
  claves: string[];
  /** Cuándo salió: lo que la persona escribió después es la respuesta. */
  enviado: string | null;
  /**
   * El valor de cada confirmación pendiente, que es el que mostró el pedido:
   * vacío si se preguntó abierto. Un «Sí» a «¿es correcto que no hubo
   * personas lastimadas?» no es un «sí, hubo».
   */
  propuestos: Record<string, string>;
}

/** Lo mismo que `lastAskedKeys`, más con qué valor se preguntó, en un viaje. */
export async function ultimoPedido(caseId: string, tenantId: string): Promise<UltimoPedido> {
  try {
    const [pedidos, pendientes] = await enTenantVarias<
      [FilaDelPedido[], Array<{ field_name: string; suggested_value: string | null }>]
    >({ tenantId }, (db) => [
      consultaDelPedido(db, caseId),
      db
        .select({
          field_name: claimFieldConfirmations.field_name,
          suggested_value: claimFieldConfirmations.suggested_value,
        })
        .from(claimFieldConfirmations)
        .where(
          and(eq(claimFieldConfirmations.case_id, caseId), eq(claimFieldConfirmations.status, "pending"))
        ),
    ]);
    const last = pedidos[0];
    return {
      claves: last?.asked_keys ?? [],
      enviado: last?.created_at ?? null,
      propuestos: Object.fromEntries(pendientes.map((p) => [p.field_name, p.suggested_value ?? ""])),
    };
  } catch (err) {
    noSeLeyo(err);
    return { claves: [], enviado: null, propuestos: {} };
  }
}
