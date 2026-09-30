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

import type { LecturaGuardada } from "@/core/case/presupuesto-taller";
import { useT } from "@/lib/i18n/LocaleContext";
import type { ClaveDelCliente } from "@/lib/i18n";
import { etiquetaDeCampo } from "@/lib/labels/etiqueta-de-campo";

import { PresupuestoDelTaller } from "./PresupuestoDelTaller";

interface Attachment {
  id: string;
  filename: string;
  content_type: string;
  size_bytes: number;
  external_url: string;
  uploaded_at: string | null;
  /** Por qué no quedó guardado, o `null` si quedó. */
  rejected_reason: string | null;
  /** Si tiene bytes guardados y se puede pedir a `/api/cases/:id/attachments/:attachmentId`. */
  disponible: boolean;
  /** Qué documento pedido cerró este adjunto, o `null` si no cerró ninguno. */
  matched_doc_key: string | null;
  /** Una línea de la IA sobre qué es, o `null` si todavía no lo leyó. */
  resumen: string | null;
  /** `false` si la IA lo dio por ajeno al reclamo. */
  util: boolean | null;
  /** Mismo contenido que un adjunto anterior del caso. */
  duplicado: boolean;
  /** Si se ofrece leerlo como presupuesto del taller. */
  esPresupuesto: boolean;
  lectura_presupuesto: LecturaGuardada | null;
}

interface AttachmentsPanelProps {
  attachments: Attachment[];
  caseId: string;
  puedeAbrir: boolean;
  /** El mismo corte que cambiar el estado del caso; sin él, la lectura se ve y no se pide. */
  puedeLeerPresupuesto?: boolean;
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
  "download_failed",
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
export function claveDeMotivoDeRechazo(motivo: string): ClaveDelCliente | null {
  return MOTIVOS_CONOCIDOS.has(motivo)
    ? (`attachment.rejected.${motivo}` as ClaveDelCliente)
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
  if (lower.startsWith("audio/"))
    return { label: "Audio", classes: "bg-emerald-50 text-emerald-700" };
  return { label: "FILE", classes: "bg-slate-100 text-slate-600" };
}

export function AttachmentsPanel({
  attachments,
  caseId,
  puedeAbrir,
  puedeLeerPresupuesto = false,
}: AttachmentsPanelProps) {
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
          // `puedeAbrir` es el rol; `disponible` es si hay bytes detrás. Sin
          // las dos, el link o la miniatura pedirían un archivo que no está
          // o que este rol no puede ver.
          const seAbre = attachment.disponible && puedeAbrir;
          const href = `/api/cases/${caseId}/attachments/${attachment.id}`;
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
                {seAbre && attachment.content_type.toLowerCase().startsWith("image/") && (
                  // eslint-disable-next-line @next/next/no-img-element -- el src pasa por auth, `next/image` no aplica a un endpoint propio.
                  <img
                    src={href}
                    loading="lazy"
                    alt={attachment.filename}
                    className="h-16 w-16 rounded object-cover flex-shrink-0"
                  />
                )}
                {/* Content type badge */}
                <span
                  className={`inline-flex items-center rounded px-1.5 py-0.5 text-xs font-semibold ${badge.classes} flex-shrink-0`}
                >
                  {badge.label}
                </span>
                <span className="min-w-0">
                  {/* Filename */}
                  <span
                    className="block text-sm text-slate-800 truncate font-medium"
                    title={attachment.filename}
                  >
                    {attachment.filename}
                  </span>
                  {(attachment.duplicado || attachment.util === false) && (
                    <span className="flex gap-1 mt-0.5">
                      {attachment.duplicado && (
                        <span className="rounded px-1.5 py-0.5 text-[11px] font-medium bg-slate-100 text-slate-600">
                          {t("attachment.duplicado")}
                        </span>
                      )}
                      {attachment.util === false && (
                        <span className="rounded px-1.5 py-0.5 text-[11px] font-medium bg-amber-100 text-amber-700">
                          {t("attachment.noSirve")}
                        </span>
                      )}
                    </span>
                  )}
                  {attachment.resumen && (
                    <span className="block text-xs text-slate-600" title={attachment.resumen}>
                      {attachment.resumen}
                    </span>
                  )}
                  {/* Qué documento pedido cerró este adjunto, si cerró alguno. */}
                  {attachment.matched_doc_key && (
                    <span className="block text-xs text-slate-500 truncate">
                      {t("case.detail.reconocidoComo").replace(
                        "{doc}",
                        etiquetaDeCampo(attachment.matched_doc_key, t)
                      )}
                    </span>
                  )}
                  {(attachment.esPresupuesto || attachment.lectura_presupuesto) && (
                    <PresupuestoDelTaller
                      caseId={caseId}
                      attachmentId={attachment.id}
                      inicial={attachment.lectura_presupuesto}
                      puedeLeer={attachment.esPresupuesto && puedeLeerPresupuesto}
                    />
                  )}
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

              {/* El guardado propio, servido por la ruta: sólo si hay bytes y el rol puede verlos. */}
              {seAbre && (
                <a
                  href={href}
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
