/**
 * Lo que el asegurado escribió, para un caso.
 *
 * Estaba escrito dos veces en la pantalla de detalle: una para mostrar el
 * acordeón con los últimos mensajes, otra para sacar el texto del más nuevo
 * cuando la extracción no dejó campos y hay que releerlo con el parser. Las dos
 * consultaban las mismas dos tablas con la misma cascada y diferían sólo en el
 * orden, el tope y qué columnas pedían.
 *
 * ── Por qué primero `raw_messages` y después `claim_messages` ───────────────
 *
 * NO es «lo simulado le gana a lo real», que es lo que uno supondría por el
 * nombre: en `raw_messages` escribe también la ingesta real de WhatsApp
 * (`intake-agent.ts`, justo después de escribir en `claim_messages`).
 *
 * Es que `raw_messages` guarda el mensaje ENTERO y verbatim —cuerpo completo,
 * asunto, remitente—, mientras que `claim_messages` es el hilo de la
 * conversación, con el texto ya recortado para mostrar. Para releer con el
 * parser y para mostrar el original, se quiere lo primero; lo segundo es el
 * respaldo para los casos viejos que sólo tienen el hilo.
 */

import "server-only";

import { and, asc, desc, eq } from "drizzle-orm";

import { enTenant, type TenantContext } from "@/data/scope";
import { claimMessages, rawMessages } from "@/lib/db/schema";

export interface MensajeEntrante {
  subject: string | null;
  body: string;
  from_addr: string;
  received_at: string;
}

export interface OpcionesDeLectura {
  /** `nuevos` para el más reciente primero; `viejos` para leer la conversación. */
  orden?: "nuevos" | "viejos";
  tope?: number;
}

/**
 * Los mensajes entrantes del caso, del más completo al menos.
 *
 * Devuelve `[]` si falla la consulta y no tira: es una pantalla de lectura, y
 * quedarse sin el acordeón es mejor que no poder abrir el caso.
 */
export async function mensajesEntrantes(
  ctx: TenantContext,
  caseId: string,
  { orden = "nuevos", tope = 1 }: OpcionesDeLectura = {}
): Promise<MensajeEntrante[]> {
  const porFecha = orden === "nuevos" ? desc : asc;

  try {
    const crudos = await enTenant(ctx, (db) =>
      db
        .select({
          subject: rawMessages.subject,
          body: rawMessages.body,
          from_addr: rawMessages.from_addr,
          received_at: rawMessages.received_at,
        })
        .from(rawMessages)
        .where(eq(rawMessages.case_id, caseId))
        .orderBy(porFecha(rawMessages.received_at))
        .limit(tope)
    );

    if (crudos.length > 0) {
      return crudos.map((m) => ({
        subject: m.subject,
        body: m.body ?? "",
        from_addr: m.from_addr ?? "",
        received_at: m.received_at,
      }));
    }

    const delHilo = await enTenant(ctx, (db) =>
      db
        .select({
          subject: claimMessages.subject,
          body_text: claimMessages.body_text,
          from_addr: claimMessages.from_addr,
          received_at: claimMessages.received_at,
        })
        .from(claimMessages)
        .where(
          and(eq(claimMessages.case_id, caseId), eq(claimMessages.direction, "inbound"))
        )
        .orderBy(porFecha(claimMessages.received_at))
        .limit(tope)
    );

    return delHilo.map((m) => ({
      subject: m.subject,
      body: m.body_text ?? "",
      from_addr: m.from_addr ?? "",
      received_at: m.received_at,
    }));
  } catch {
    return [];
  }
}

/**
 * El último mensaje, para volver a leerlo con el parser cuando la extracción no
 * dejó campos.
 */
export async function ultimoMensajeEntrante(
  ctx: TenantContext,
  caseId: string
): Promise<{ subject: string; body: string; senderEmail: string }> {
  const [ultimo] = await mensajesEntrantes(ctx, caseId, { orden: "nuevos", tope: 1 });

  return {
    subject: ultimo?.subject ?? "",
    body: ultimo?.body ?? "",
    senderEmail: ultimo?.from_addr ?? "",
  };
}
