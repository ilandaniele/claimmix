/**
 * MessagesThread — Client Component for the inbound email thread panel.
 *
 * AC11: Renders one card per inbound message with from_addr, subject,
 *       body_text preview, and relative received_at.
 * AC12: Returns null (renders nothing) when messages array is empty.
 * AC13: body_text preview truncated to 300 chars in collapsed state.
 * AC14: Shows attachment count badge (paperclip icon + count) when > 0.
 *
 * PII protection: from_addr, subject, body_text are PII.
 * They are rendered in the UI but NEVER logged to console.
 *
 * Fetches GET /api/cases/[caseId]/messages on mount.
 * Uses collapsible cards (click to expand full body_text up to 500 chars from API).
 */

"use client";

import { useState, useEffect } from "react";
import { useT } from "@/lib/i18n/LocaleContext";

// ── Types ─────────────────────────────────────────────────────────────────────

interface Message {
  id: string;
  direction: string;
  provider: string;
  subject: string | null;
  from_addr: string | null;
  body_text: string | null;
  received_at: string;
  attachment_count: number;
}

type LoadState = "loading" | "ready" | "error";

// ── Constants ─────────────────────────────────────────────────────────────────

const PREVIEW_MAX_CHARS = 300;
const SUBJECT_MAX_CHARS = 60;
const LOCALE = "es-AR";

// ── Relative time formatter ────────────────────────────────────────────────────

const rtf = new Intl.RelativeTimeFormat(LOCALE, { numeric: "auto" });

function formatRelative(isoTimestamp: string): string {
  const date = new Date(isoTimestamp);
  const diffMs = date.getTime() - Date.now();
  const diffSec = Math.round(diffMs / 1000);
  const diffMin = Math.round(diffSec / 60);
  const diffHours = Math.round(diffMin / 60);
  const diffDays = Math.round(diffHours / 24);

  if (Math.abs(diffSec) < 60) return rtf.format(diffSec, "second");
  if (Math.abs(diffMin) < 60) return rtf.format(diffMin, "minute");
  if (Math.abs(diffHours) < 24) return rtf.format(diffHours, "hour");
  return rtf.format(diffDays, "day");
}

// ── Avatar helper ─────────────────────────────────────────────────────────────

function getAvatarLetter(fromAddr: string | null): string {
  if (!fromAddr) return "?";
  // Extract the first letter of the local part (before @), uppercased.
  const local = fromAddr.split("@")[0];
  return local.charAt(0).toUpperCase() || "?";
}

// ── Paperclip icon ────────────────────────────────────────────────────────────

function PaperclipIcon() {
  return (
    <svg
      xmlns="http://www.w3.org/2000/svg"
      viewBox="0 0 20 20"
      fill="currentColor"
      className="w-3.5 h-3.5"
      aria-hidden="true"
    >
      <path
        fillRule="evenodd"
        d="M15.621 4.379a3 3 0 0 0-4.242 0l-7 7a3 3 0 0 0 4.241 4.243h.001l.497-.5a.75.75 0 0 1 1.064 1.057l-.498.501-.002.002a4.5 4.5 0 0 1-6.364-6.364l7-7a4.5 4.5 0 0 1 6.368 6.36l-3.455 3.553A2.625 2.625 0 1 1 9.52 9.52l3.45-3.451a.75.75 0 1 1 1.061 1.06l-3.45 3.451a1.125 1.125 0 0 0 1.587 1.595l3.454-3.553a3 3 0 0 0 0-4.242Z"
        clipRule="evenodd"
      />
    </svg>
  );
}

// ── Loading skeleton ──────────────────────────────────────────────────────────

function MessageSkeleton() {
  return (
    <div
      className="rounded-lg border border-slate-200 bg-white px-4 py-4 animate-pulse"
      aria-busy="true"
      aria-label="Cargando mensajes"
    >
      <div className="flex items-start gap-3">
        <div className="h-8 w-8 rounded-full bg-slate-200 flex-shrink-0" />
        <div className="flex-1 space-y-2">
          <div className="h-3 w-32 rounded bg-slate-200" />
          <div className="h-3 w-48 rounded bg-slate-100" />
          <div className="h-3 w-full rounded bg-slate-100" />
          <div className="h-3 w-4/5 rounded bg-slate-100" />
        </div>
      </div>
    </div>
  );
}

// ── Message card ──────────────────────────────────────────────────────────────

interface MessageCardProps {
  message: Message;
}

function MessageCard({ message }: MessageCardProps) {
  const t = useT();
  const [expanded, setExpanded] = useState(false);

  const avatarLetter = getAvatarLetter(message.from_addr);

  // Truncate subject to SUBJECT_MAX_CHARS for display in collapsed header.
  const subjectDisplay =
    message.subject
      ? message.subject.length > SUBJECT_MAX_CHARS
        ? `${message.subject.slice(0, SUBJECT_MAX_CHARS)}…`
        : message.subject
      : t("messages.thread.no_subject");

  // Body preview: collapsed = first 300 chars; expanded = full body_text (≤500 from API).
  const bodyText = message.body_text ?? "";
  const isLong = bodyText.length > PREVIEW_MAX_CHARS;
  const previewText = isLong && !expanded
    ? `${bodyText.slice(0, PREVIEW_MAX_CHARS)}…`
    : bodyText;

  return (
    <article
      data-testid="message-card"
      className="rounded-lg border border-slate-200 bg-white"
    >
      {/* Card header — always visible */}
      <div className="px-4 py-3">
        <div className="flex items-start gap-3">
          {/* Avatar circle */}
          <div
            className="flex-shrink-0 h-8 w-8 rounded-full bg-blue-100 text-blue-700 flex items-center justify-center text-sm font-semibold select-none"
            aria-hidden="true"
          >
            {avatarLetter}
          </div>

          <div className="flex-1 min-w-0">
            {/* From address + relative time row */}
            <div className="flex items-center justify-between gap-2 flex-wrap">
              <span className="text-sm font-medium text-slate-800 truncate">
                {message.from_addr ?? "—"}
              </span>
              <time
                dateTime={message.received_at}
                className="text-xs text-slate-400 flex-shrink-0"
                title={new Date(message.received_at).toLocaleString(LOCALE)}
              >
                {formatRelative(message.received_at)}
              </time>
            </div>

            {/* Subject */}
            <div className="mt-0.5 text-sm font-semibold text-slate-900 truncate">
              {subjectDisplay}
            </div>

            {/* Attachment badge — AC14 */}
            {message.attachment_count > 0 && (
              <div className="mt-1 inline-flex items-center gap-1 text-xs text-slate-500">
                <PaperclipIcon />
                <span
                  className="inline-flex items-center rounded-full bg-slate-100 px-1.5 py-0.5 text-xs font-medium text-slate-600"
                  aria-label={`${message.attachment_count} ${t("messages.thread.attachments")}`}
                >
                  {message.attachment_count}
                </span>
              </div>
            )}
          </div>
        </div>

        {/* Body preview — AC13 */}
        {bodyText && (
          <div className="mt-2 ml-11">
            <p className="text-xs text-slate-600 leading-relaxed whitespace-pre-wrap">
              {previewText}
            </p>
            {isLong && (
              <button
                type="button"
                onClick={() => setExpanded((prev) => !prev)}
                className="mt-1 text-xs text-blue-600 hover:text-blue-800 font-medium transition-colors"
                aria-expanded={expanded}
              >
                {expanded ? t("messages.thread.collapse") : t("messages.thread.expand")}
              </button>
            )}
          </div>
        )}
      </div>
    </article>
  );
}

// ── Main component ────────────────────────────────────────────────────────────

interface MessagesThreadProps {
  caseId: string;
}

export function MessagesThread({ caseId }: MessagesThreadProps) {
  const t = useT();
  const [loadState, setLoadState] = useState<LoadState>("loading");
  const [messages, setMessages] = useState<Message[]>([]);

  useEffect(() => {
    let cancelled = false;

    async function fetchMessages() {
      try {
        const res = await fetch(`/api/cases/${caseId}/messages`);

        if (!res.ok) {
          if (!cancelled) setLoadState("error");
          return;
        }

        const data: { messages: Message[] } = await res.json();
        if (!cancelled) {
          setMessages(data.messages);
          setLoadState("ready");
        }
      } catch {
        // Network failure — show error state.
        if (!cancelled) setLoadState("error");
      }
    }

    fetchMessages();

    return () => {
      cancelled = true;
    };
  }, [caseId]);

  // Loading: show skeleton cards.
  if (loadState === "loading") {
    return (
      <div className="space-y-3">
        <MessageSkeleton />
        <MessageSkeleton />
      </div>
    );
  }

  // Error: show generic error message (no PII).
  if (loadState === "error") {
    return (
      <div className="rounded-md bg-red-50 px-3 py-2 text-xs text-red-700">
        {t("error.generic")}
      </div>
    );
  }

  // AC12: return null when messages array is empty — no element with data-testid="messages-thread".
  if (messages.length === 0) {
    return null;
  }

  return (
    <div data-testid="messages-thread">
      <div className="space-y-3">
        {messages.map((message) => (
          <MessageCard key={message.id} message={message} />
        ))}
      </div>
    </div>
  );
}
