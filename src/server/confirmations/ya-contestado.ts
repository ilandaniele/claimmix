/**
 * ¿Ya le contestamos al último mensaje que escribió?
 *
 * Existe por la corrida heredada: `acquireExtractionLease` puede encontrar una
 * reserva vencida sin la marca de pendiente, que es el caso de una corrida
 * muerta que ya alcanzó a contestar antes de que el proceso se cortara.
 * Retomarla de cero mandaría lo mismo otra vez. Esta consulta es lo único que
 * distingue "ya contestamos" de "llegó algo nuevo y hay que contestar".
 */

import "server-only";

import { and, desc, eq, inArray, lte } from "drizzle-orm";
import { enTenantVarias } from "@/data/scope";
import { claimMessages, outboundMessages } from "@/lib/db/schema";
import { firstRow } from "@/lib/db/helpers";
import { logger } from "@/lib/observability/logger";
import { yaSeLeContesto } from "@/core/case/reply-decision";

/**
 * Sólo esto cuenta como "salió". `queued` no: un mail que quedó en cola y
 * nunca salió no contestó nada, y ante la duda se contesta.
 */
const ESTADOS_DE_SALIDA = ["sent", "skipped_simulated"] as const;

/**
 * `hasta` es cuándo la corrida pidió la reserva. Lo que llegó después no lo
 * vio la corrida muerta, así que no cuenta como "el último mensaje": si
 * contara, un mensaje nuevo taparía la respuesta que ya salió y se mandaría
 * otra vez. Ese mensaje nuevo dejó la marca y tiene su propia corrida.
 */
export async function yaContestamosElUltimoMensaje(
  caseId: string,
  tenantId: string,
  hasta: string
): Promise<boolean> {
  try {
    const [entrada, salida] = await enTenantVarias<
      [Array<{ received_at: string }>, Array<{ created_at: string }>]
    >({ tenantId }, (db) => [
      db
        .select({ received_at: claimMessages.received_at })
        .from(claimMessages)
        .where(
          and(
            eq(claimMessages.case_id, caseId),
            eq(claimMessages.direction, "inbound"),
            lte(claimMessages.received_at, hasta)
          )
        )
        .orderBy(desc(claimMessages.received_at))
        .limit(1),
      db
        .select({ created_at: outboundMessages.created_at })
        .from(outboundMessages)
        .where(
          and(
            eq(outboundMessages.case_id, caseId),
            inArray(outboundMessages.status, ESTADOS_DE_SALIDA)
          )
        )
        .orderBy(desc(outboundMessages.created_at))
        .limit(1),
    ]);

    return yaSeLeContesto(
      firstRow(entrada)?.received_at ?? null,
      firstRow(salida)?.created_at ?? null
    );
  } catch (err) {
    // Contestar es la dirección segura acá: ante la duda, no callarse.
    logger.error({ code: errCode(err) }, "orchestrate.ya_contestado_fallo");
    return false;
  }
}

function errCode(err: unknown): string {
  return (
    (err as { code?: string })?.code ??
    (err instanceof Error ? err.name : "UnknownError")
  );
}
