import { after } from "next/server";
import "server-only";
import { getWorkerBaseUrl } from "@/server/email/dispatch-url";
import { internalAuthHeaders } from "@/lib/security/internal-auth";
import { logger } from "@/lib/observability/logger";

/**
 * Larga la extracción y sigue. El encabezado de gmail-poller.ts dice
 * «fire-and-forget» desde siempre; el código la esperaba. Lo comparten el poller
 * y el formulario web.
 *
 * ── Qué costaba esperarla ──────────────────────────────────────────────────
 *
 * `/api/worker/extract` corre `runIntakeAgent` entero y recién ahí contesta,
 * y tenía su propio techo de 60 s. El poller lo esperaba con `await fetch`,
 * o sea que gastaba SU techo de 60 s en el trabajo del otro. Los dos se
 * morían juntos.
 *
 * Pasó el 2026-09-08 con el correo del timbre: el poller devolvió 504 a los
 * sesenta segundos exactos, y el caso quedó con los campos extraídos y sin
 * un solo evento después de `intake.agent_decision`. Al asegurado no le
 * contestó nadie. En WhatsApp, que ya usaba `after()`, el mismo minuto
 * anduvo bien.
 *
 * ── Por qué `after()` y no soltar la promesa ───────────────────────────────
 *
 * Soltarla sin esperarla no sirve: la plataforma congela la función en
 * cuanto el handler devuelve, y el pedido se puede perder antes de salir.
 * `after()` es lo que mantiene viva la invocación DESPUÉS de responder, y es
 * lo mismo que hace el webhook de WhatsApp.
 *
 * El worker es otra invocación, con su propio reloj: que a este poller se le
 * acabe el tiempo ya no lo interrumpe.
 *
 * Fuera de un pedido —una prueba, un script— `after()` tira, y ahí se espera
 * como antes. Es lo que quiere una prueba: que al terminar la llamada el
 * trabajo esté hecho.
 */
export async function dispatchExtractionWorker(
  caseId: string,
  tenantId: string
): Promise<void> {
  try {
    after(() => llamarAlWorker(caseId, tenantId));
  } catch {
    await llamarAlWorker(caseId, tenantId);
  }
}

async function llamarAlWorker(caseId: string, tenantId: string): Promise<void> {
  try {
    const response = await fetch(`${getWorkerBaseUrl()}/api/worker/extract`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        ...internalAuthHeaders(),
      },
      body: JSON.stringify({ caseId, tenantId }),
    });

    if (!response.ok) {
      logger.error({ detalle: `HttpError status=${response.status}`, case_id: caseId }, "worker.dispatch_error");
    }
  } catch (err) {
    const name = err instanceof Error ? err.name : "UnknownError";
    logger.error({ error_name: name, case_id: caseId }, "worker.dispatch_error");
  }
}
