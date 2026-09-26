/**
 * AttachmentsPanel — Client Component for AC23.
 *
 * Lists claim_attachments for a case.
 * Shows: filename, content_type badge, file size, download link (opens in new tab).
 * A row with `rejected_reason` shows why the file was not stored instead of its
 * size: the reason is the part the analyst can act on. And when the download
 * was cut midway, that size is only a sentinel.
 *
 * AC23 PII protection: attachment URLs (external_url) are NEVER logged to console
 * or sent to any analytics. They are rendered as href-only anchor tags.
 */

"use client";

import { useT } from "@/lib/i18n/LocaleContext";
import type { TranslationKey } from "@/lib/i18n";

interface Attachment {
  id: string;
  filename: string;
  content_type: string;
  size_bytes: number;
  external_url: string;
  uploaded_at: string | null;
  /** Por qué no quedó guardado, o `null` si quedó. */
  rejected_reason: string | null;
}

interface AttachmentsPanelProps {
  attachments: Attachment[];
  caseId: string;
  puedeAbrir: boolean;
}

/** Format bytes as human-readable size string (e.g. "1.2 MB") */
function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

/**
 * ¿Se puede poner esto en un `href`?
 *
 * Sólo `http` y `https`. Cualquier otro esquema —`javascript:`, `data:`,
 * `vbscript:`— es una forma de ejecutar algo, no de ir a algún lado.
 */
function esEnlaceSeguro(url: string | null | undefined): boolean {
  if (!url) return false;
  try {
    const { protocol } = new URL(url);
    return protocol === "http:" || protocol === "https:";
  } catch {
    // Una URL relativa no parsea sin base, y tampoco es un destino que este
    // panel deba abrir: los adjuntos viven afuera.
    return false;
  }
}

/** Los motivos que escribe `rehostAndRecordAttachments`, y nada más. */
const MOTIVOS_CONOCIDOS = new Set([
  "size_exceeded",
  "content_type_not_allowed",
  "storage_upload_failed",
  "rehost_timeout",
  "aggregate_size_exceeded",
  "decode_failed",
]);

/**
 * El motivo del rechazo, traducido a algo que se pueda hacer.
 *
 * Los valores son códigos internos. Pintados crudos le dejaban al analista un
 * «size_exceeded» que no le dice qué pedirle al asegurado.
 *
 * Devuelve `null` cuando el código no está en la lista. El historial guarda
 * motivos que no son de adjuntos y que no hay que tocar: prosa fija escrita en
 * el código —`close-abandoned.ts` cierra con «sin respuesta del denunciante»—
 * y códigos internos de otras partes —«conflict», «unsafe_run»— que hoy salen
 * crudos. Cada llamador decide qué hacer con eso.
 */
export function claveDeMotivoDeRechazo(motivo: string): TranslationKey | null {
  return MOTIVOS_CONOCIDOS.has(motivo)
    ? (`attachment.rejected.${motivo}` as TranslationKey)
    : null;
}

/** Map content_type to display label */
function contentTypeBadge(contentType: string): {
  label: string;
  classes: string;
} {
  const lower = contentType.toLowerCase();
  if (lower.includes("pdf"))
    return { label: "PDF", classes: "bg-red-100 text-red-700" };
  if (lower.includes("jpeg") || lower.includes("jpg"))
    return { label: "JPG", classes: "bg-blue-100 text-blue-700" };
  if (lower.includes("png"))
    return { label: "PNG", classes: "bg-indigo-100 text-indigo-700" };
  if (lower.includes("docx") || lower.includes("doc"))
    return { label: "DOC", classes: "bg-sky-100 text-sky-700" };
  return { label: "FILE", classes: "bg-slate-100 text-slate-600" };
}

export function AttachmentsPanel({ attachments }: AttachmentsPanelProps) {
  const t = useT();
  if (attachments.length === 0) {
    return (
      <p className="text-sm text-slate-500">
        {t("case.detail.noAttachments")}
      </p>
    );
  }

  return (
    <div className="space-y-2">
      <p className="text-xs text-slate-500">
        {attachments.length} {t("case.detail.attachmentCount")}
      </p>
      <div className="space-y-2">
        {attachments.map((attachment) => {
          const badge = contentTypeBadge(attachment.content_type);
          const rechazado = attachment.rejected_reason;
          return (
            <div
              key={attachment.id}
              className={`flex items-center justify-between rounded-lg border px-4 py-3 gap-3 ${
                rechazado
                  ? "border-amber-300 bg-amber-50"
                  : "border-slate-200 bg-white"
              }`}
            >
              <div className="flex items-center gap-3 flex-1 min-w-0">
                {/* Content type badge */}
                <span
                  className={`inline-flex items-center rounded px-1.5 py-0.5 text-xs font-semibold ${badge.classes} flex-shrink-0`}
                >
                  {badge.label}
                </span>
                {/* Filename */}
                <span
                  className="text-sm text-slate-800 truncate font-medium"
                  title={attachment.filename}
                >
                  {attachment.filename}
                </span>
                {/*
                  * Dónde va el tamaño va el motivo, cuando lo hay.
                  *
                  * El motivo es lo accionable, y además el tamaño a veces
                  * miente. `downloadWhatsAppMedia` rechaza por dos caminos. Si
                  * la metadata de Meta trae `file_size`, el número que queda en
                  * `size_bytes` es el peso declarado: un video de 80 MB queda
                  * en 80 MB, y eso es una medición. Si no hay `file_size`, la
                  * descarga se corta a mitad del cuerpo y nadie cuenta los
                  * bytes: ahí el llamador escribe `MAX_ATTACHMENT_SIZE_BYTES +
                  * 1` —un centinela— y `formatBytes` lo pinta «10.0 MB» sobre
                  * un archivo que podía pesar 80. La fila no dice por cuál de
                  * los dos caminos vino, así que en los dos se muestra el
                  * motivo.
                  */}
                {rechazado ? (
                  <span className="min-w-0 text-xs text-amber-800">
                    {t(
                      claveDeMotivoDeRechazo(rechazado) ??
                        "attachment.rejected.unknown"
                    )}
                  </span>
                ) : (
                  <span className="text-xs text-slate-500 flex-shrink-0 hidden sm:inline">
                    {formatBytes(attachment.size_bytes)}
                  </span>
                )}
              </div>

              {/*
                * El enlace, sólo si hay adónde ir y el destino es http(s).
                *
                * Dos cosas distintas, las dos reales:
                *
                * · Hoy nadie escribe `external_url` —la columna existe y ningún
                *   código la llena—, así que esto se pintaba con `href=""` y el
                *   botón recargaba la página. Ofrecer una acción que no hace
                *   nada es peor que no ofrecerla.
                * · Y el día que algo la llene, el esquema tiene que estar
                *   comprobado. Un `javascript:` en un `href` es XSS, y React no
                *   lo bloquea: avisa por consola y lo pinta igual. El valor
                *   vendría de un adjunto de correo, o sea de afuera.
                */}
              {esEnlaceSeguro(attachment.external_url) && (
                <a
                  href={attachment.external_url}
                  target="_blank"
                  rel="noopener noreferrer"
                  className="flex-shrink-0 rounded-md border border-slate-300 px-3 py-1 text-xs font-medium text-slate-700 hover:bg-slate-50 transition-colors"
                  aria-label={`Abrir ${attachment.filename} en nueva pestaña`}
                >
                  {t("case.detail.openAttachment")}
                </a>
              )}
            </div>
          );
        })}
      </div>
    </div>
  );
}
