/**
 * AttachmentsPanel — Client Component for AC23.
 *
 * Lists claim_attachments for a case.
 * Shows: filename, content_type badge, file size, download link (opens in new tab).
 *
 * AC23 PII protection: attachment URLs (external_url) are NEVER logged to console
 * or sent to any analytics. They are rendered as href-only anchor tags.
 */

"use client";

import { useT } from "@/lib/i18n/LocaleContext";

interface Attachment {
  id: string;
  filename: string;
  content_type: string;
  size_bytes: number;
  external_url: string;
  uploaded_at: string | null;
}

interface AttachmentsPanelProps {
  attachments: Attachment[];
}

/** Format bytes as human-readable size string (e.g. "1.2 MB") */
function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
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
      <p className="text-sm text-slate-400">
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
          return (
            <div
              key={attachment.id}
              className="flex items-center justify-between rounded-lg border border-slate-200 bg-white px-4 py-3 gap-3"
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
                {/* File size */}
                <span className="text-xs text-slate-400 flex-shrink-0 hidden sm:inline">
                  {formatBytes(attachment.size_bytes)}
                </span>
              </div>

              {/* Download link — opens in new tab, no URL logging (AC23) */}
              <a
                href={attachment.external_url}
                target="_blank"
                rel="noopener noreferrer"
                className="flex-shrink-0 rounded-md border border-slate-300 px-3 py-1 text-xs font-medium text-slate-700 hover:bg-slate-50 transition-colors"
                aria-label={`Abrir ${attachment.filename} en nueva pestaña`}
              >
                {t("case.detail.openAttachment")}
              </a>
            </div>
          );
        })}
      </div>
    </div>
  );
}
