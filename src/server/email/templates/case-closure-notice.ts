/**
 * Email template: case_closure_notice
 *
 * El aviso de que el caso se cerró por falta de respuesta (B4). Texto fijo,
 * sin redactor ni modelo: no hay nada que adaptar y no conviene que un modelo
 * improvise sobre un caso que ya nadie mira.
 */

import { escapeHtml } from "@/core/email/html";
import { t } from "@/lib/i18n";

export function renderCaseClosureNotice(data: { caseId: string }): {
  subject: string;
  html: string;
  text: string;
  cuerpo: string;
} {
  const subject = `${t("cierre.aviso.asunto")} - Caso #${data.caseId}`;
  const cuerpo = t("cierre.aviso.cuerpo");
  const html = `<p>${escapeHtml(cuerpo)}</p>\n<p>Caso #${escapeHtml(data.caseId)}</p>`;
  const text = [cuerpo, "", `Caso #${data.caseId}`].join("\n");
  return { subject, html, text, cuerpo };
}
