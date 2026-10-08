import { escapeHtml } from "@/server/email/render";
import { textoAHtml } from "@/core/email/html";
import { ARCHIVO_QUE_NO_ENTRO } from "@/core/mensajes/archivo-que-no-entro";

/**
 * Email template: attachment_too_large
 *
 * La persona mandó un archivo que pasó el tope de tamaño mientras el pedido
 * estaba en espera. Sale texto fijo, sin redactor: el redactor lee «ahí va la
 * foto» y agradece una foto que nunca entró.
 */

export interface AttachmentTooLargeData {
  caseId: string;
  /** La prosa ya redactada. Reemplaza el cuerpo y nada más. */
  cuerpo?: string | null;
}

export function renderAttachmentTooLarge(data: AttachmentTooLargeData): {
  subject: string;
  html: string;
  text: string;
  cuerpo: string;
} {
  const subject = `No pudimos recibir tu archivo - Caso #${data.caseId}`;

  const cuerpo = ARCHIVO_QUE_NO_ENTRO;
  const prosa = data.cuerpo?.trim() || cuerpo;

  // Un FRAGMENTO de `<p>`, sin DOCTYPE, como information_received.
  const html = `
    ${textoAHtml(prosa)}
    <p>Caso #${escapeHtml(data.caseId)}</p>
  `.trim();

  const text = [prosa, "", `Caso #${data.caseId}`].join("\n");

  return { subject, html, text, cuerpo };
}
