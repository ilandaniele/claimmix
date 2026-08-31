/**
 * Un caso que dimos por «no es una denuncia» y que acaba de recibir un mensaje.
 *
 * ── El agujero ───────────────────────────────────────────────────────────────
 *
 * `no_relevante` es terminal en la máquina de estados y el worker no arranca
 * desde ahí. Así que alguien escribe «hola», el clasificador dice que no es una
 * denuncia, el caso queda cerrado, y cuando después escribe la denuncia de
 * verdad ese mensaje se guarda y no lo lee nadie. En un producto de intake es la
 * peor forma de fallar: la denuncia entró y se perdió adentro.
 *
 * Es el balde más grande de la base — 329 casos en `no_relevante` — así que el
 * día que llegue volumen real, es donde va a doler.
 *
 * ── Por qué esto NO rompe LLM08 ──────────────────────────────────────────────
 *
 * LLM08 dice que la IA no puede sacar un caso de un estado terminal, y sigue sin
 * poder: esta transición NO la decide el modelo. La dispara que una persona haya
 * mandado un mensaje, que es un hecho del servidor, y ocurre en el camino de
 * ingreso —antes de que el worker corra y mucho antes de que el modelo opine—.
 * Es la simétrica del comentario que ya estaba en `fsm.ts`: «`no_relevante` lo
 * pone el clasificador por un camino controlado del servidor, no la salida del
 * LLM directamente». Sacarlo, también.
 *
 * Y no reabre nada por su cuenta: vuelve a `recibido`, que es el principio del
 * flujo normal. Si el mensaje nuevo tampoco es una denuncia, la extracción lo
 * vuelve a dejar en `no_relevante`, que es la ida y vuelta correcta.
 *
 * ── Sólo el correo, y no por olvido ──────────────────────────────────────────
 *
 * WhatsApp no lo necesita: `findExistingWhatsAppCase` reutiliza un caso SÓLO si
 * está en `recibido`, `info_faltante` o `confirmacion_pendiente`, así que un
 * mensaje nuevo sobre un caso no-relevante ya abre un caso nuevo. Se descubrió
 * al revés de lo esperado — puse la llamada en los dos canales y un test de
 * WhatsApp que ya existía se puso rojo porque la consulta de más le corrió el
 * mock: era código muerto.
 *
 * El correo sí lo necesita porque `threadLookup` busca por hilo y NO filtra por
 * estado: una respuesta en el mismo hilo cae en el caso viejo, esté como esté. Y
 * ahí reabrir es lo correcto y abrir uno nuevo no lo sería, porque en correo el
 * hilo es la conversación.
 */

import "server-only";

import { eq } from "drizzle-orm";

import { cases } from "@/lib/db/schema";
import { enTenant, type TenantContext } from "@/data/scope";
import { firstRow } from "@/lib/db/helpers";
import { isValidTransition } from "@/core/case/fsm";
import { writeAuditLog, AuditEvent } from "@/lib/audit/log";

/**
 * Devuelve el caso a `recibido` si estaba dado por no-relevante.
 *
 * Se llama justo después de guardar un mensaje entrante sobre un caso que ya
 * existía. No tira nunca: que la reapertura falle no puede tumbar el ingreso de
 * un mensaje, que es lo único que no se puede perder.
 *
 * @returns true si lo reabrió.
 */
export async function reabrirSiEraNoRelevante(
  caseId: string,
  tenantId: string
): Promise<boolean> {
  const tenantCtx: TenantContext = { tenantId };

  try {
    const fila = firstRow(
      await enTenant(tenantCtx, (db) =>
        db.select({ status: cases.status }).from(cases).where(eq(cases.id, caseId)).limit(1)
      )
    );
    if (!fila || fila.status !== "no_relevante") return false;

    /*
     * La máquina de estados sigue mandando.
     *
     * Se le pregunta en vez de escribir directo: si algún día alguien saca la
     * arista `no_relevante → recibido`, esto deja de reabrir en lugar de
     * escribir un estado que la máquina no reconoce.
     */
    if (!isValidTransition("no_relevante", "recibido")) return false;

    await enTenant(tenantCtx, (db) =>
      db
        .update(cases)
        .set({ status: "recibido", updated_at: new Date().toISOString() })
        .where(eq(cases.id, caseId))
    );

    await writeAuditLog({
      tenant_id: tenantId,
      actor_id: null,
      event_type: AuditEvent.CASE_REOPENED,
      target_type: "case",
      target_id: caseId,
      payload: { desde: "no_relevante", motivo: "mensaje_entrante" },
    });

    console.info(
      JSON.stringify({
        level: "info",
        service: "claimmix",
        msg: "case.reabierto_por_mensaje",
        case_id: caseId,
      })
    );

    return true;
  } catch (err) {
    /*
     * El mensaje ya está guardado; lo que se pierde acá es la reapertura.
     * Fallar de este lado deja el caso como estaba —el defecto viejo— pero
     * tirar dejaría el mensaje sin entrar, que es peor.
     */
    console.error(
      "[reabrir-no-relevante] no se pudo reabrir:",
      err instanceof Error ? err.name : "UnknownError",
      "case:",
      caseId
    );
    return false;
  }
}
