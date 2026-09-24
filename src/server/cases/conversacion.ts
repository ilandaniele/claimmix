/**
 * La conversación entera de un caso: lo que escribió la persona y lo que le
 * contestó el agente, por mail o por WhatsApp, en orden y en un solo viaje.
 *
 * Sin enmascarar ni recortar el texto: eso depende de quién mira, y lo decide
 * la ruta.
 */
import "server-only";

import { and, count, desc, eq, or } from "drizzle-orm";
import { enTenantVarias, type TenantContext } from "@/data/scope";
import { readable } from "@/core/email/texto-legible";
import {
  cases,
  claimAttachments,
  claimMessages,
  outboundMessages,
  rawMessages,
} from "@/lib/db/schema";

export interface MensajeDeLaConversacion {
  id: string;
  direction: "inbound" | "outbound";
  provider: string;
  subject: string | null;
  from_addr: string | null;
  body_text: string | null;
  received_at: string;
  estado_envio: string | null;
  attachment_count: number;
}

/** Lo que contesta `GET /api/cases/:id/messages`. */
export interface Conversacion {
  messages: MensajeDeLaConversacion[];
  /** Hubo más de `TOPE_MENSAJES` y se muestran sólo los últimos. */
  recortada: boolean;
}

export const TOPE_MENSAJES = 50;

/*
 * Cada fuente trae uno más que el tope: los últimos N de la unión están
 * siempre entre los últimos N de cada fuente, y el que sobra dice si hubo
 * corte.
 */
const POR_FUENTE = TOPE_MENSAJES + 1;

type DelHilo = Omit<MensajeDeLaConversacion, "estado_envio"> & { status: string };
type Simulado = Omit<MensajeDeLaConversacion, "direction" | "estado_envio" | "attachment_count">;
type Saliente = {
  id: string;
  channel: string;
  rendered_body: string;
  status: string;
  created_at: string;
};

/** `null` si el caso no existe o no es del inquilino: la ruta contesta 404. */
export async function conversacionDelCaso(
  ctx: TenantContext,
  caseId: string
): Promise<Conversacion | null> {
  const [caso, hilo, simulados, salientes] = await enTenantVarias<
    [Array<{ id: string }>, DelHilo[], Simulado[], Saliente[]]
  >(ctx, (db) => [
    db.select({ id: cases.id }).from(cases).where(eq(cases.id, caseId)).limit(1),
    /*
     * Las dos direcciones juntas. El mail que sale de verdad escribe en
     * `claim_messages` y en `outbound_messages`, y en la segunda guarda el
     * HTML: el texto plano está acá. Lo saliente no tiene adjuntos y cuenta 0.
     */
    db
      .select({
        id: claimMessages.id,
        direction: claimMessages.direction,
        provider: claimMessages.provider,
        subject: claimMessages.subject,
        from_addr: claimMessages.from_addr,
        body_text: claimMessages.body_text,
        received_at: claimMessages.received_at,
        status: claimMessages.status,
        attachment_count: count(claimAttachments.id),
      })
      .from(claimMessages)
      .leftJoin(claimAttachments, eq(claimAttachments.claim_message_id, claimMessages.id))
      .where(eq(claimMessages.case_id, caseId))
      .groupBy(claimMessages.id)
      .orderBy(desc(claimMessages.received_at))
      .limit(POR_FUENTE),
    /*
     * El alta simulada (`/api/intake/simulate` y `batch-simulate`) guarda lo
     * que escribió la persona sólo acá. Sólo 'email_sim': WhatsApp también
     * escribe en `raw_messages`, pero una copia de lo que ya está en
     * `claim_messages`, y el ensayo por mail entra por `claim_messages` sin
     * dejar fila acá.
     */
    db
      .select({
        id: rawMessages.id,
        provider: rawMessages.channel,
        subject: rawMessages.subject,
        from_addr: rawMessages.from_addr,
        body_text: rawMessages.body,
        received_at: rawMessages.received_at,
      })
      .from(rawMessages)
      .where(and(eq(rawMessages.case_id, caseId), eq(rawMessages.channel, "email_sim")))
      .orderBy(desc(rawMessages.received_at))
      .limit(POR_FUENTE),
    /*
     * De `outbound_messages` sólo WhatsApp, que escribe nada más que ahí, y la
     * vista previa del mail simulado (destinatario example.*), que tampoco
     * escribe en `claim_messages`. Queda afuera la fila 'email_sim' que deja el
     * worker encolada y nunca se manda.
     */
    db
      .select({
        id: outboundMessages.id,
        channel: outboundMessages.channel,
        rendered_body: outboundMessages.rendered_body,
        status: outboundMessages.status,
        created_at: outboundMessages.created_at,
      })
      .from(outboundMessages)
      .where(
        and(
          eq(outboundMessages.case_id, caseId),
          or(
            eq(outboundMessages.channel, "whatsapp"),
            and(
              eq(outboundMessages.channel, "email"),
              eq(outboundMessages.status, "skipped_simulated")
            )
          )
        )
      )
      .orderBy(desc(outboundMessages.created_at))
      .limit(POR_FUENTE),
  ]);

  if (caso.length === 0) return null;

  const mensajes: MensajeDeLaConversacion[] = [
    ...hilo.map(({ status, ...m }) => ({
      ...m,
      // Lo entrante tiene estado de recepción, no de envío.
      estado_envio: m.direction === "outbound" ? status : null,
    })),
    ...simulados.map((m) => ({
      ...m,
      direction: "inbound" as const,
      estado_envio: null,
      attachment_count: 0,
    })),
    ...salientes.map((m) => ({
      id: m.id,
      direction: "outbound" as const,
      provider: m.channel,
      subject: null,
      from_addr: null,
      body_text: m.channel === "email" ? readable(m.rendered_body) : m.rendered_body,
      received_at: m.created_at,
      estado_envio: m.status,
      attachment_count: 0,
    })),
  ];

  // Date.parse y no comparar texto: el driver no promete un formato fijo.
  mensajes.sort((x, y) => Date.parse(x.received_at) - Date.parse(y.received_at));

  /*
   * Los últimos y no los primeros: el caso se trabaja desde donde quedó la
   * charla, y la denuncia original sigue a mano en el acordeón del mensaje
   * crudo. El corte es sobre la unión y no por fuente, para que ninguna
   * respuesta quede sin el mensaje que contesta dentro de la ventana.
   */
  return {
    messages: mensajes.slice(-TOPE_MENSAJES),
    recortada: mensajes.length > TOPE_MENSAJES,
  };
}
