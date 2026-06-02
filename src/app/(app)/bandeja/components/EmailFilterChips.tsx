/**
 * EmailFilterChips — additional filter chips for email-sourced claims.
 *
 * AC18: Adds channel, severity, and is_claim filters alongside existing type chips.
 * Each chip change updates the URL search params and resets to page 1.
 */

"use client";

import { useRouter, useSearchParams, usePathname } from "next/navigation";
import { useCallback } from "react";
import { t } from "@/lib/i18n";
import type { Severity } from "@/lib/schemas/cases";

// ── Channel filter ─────────────────────────────────────────────────────────────

type ChannelFilter = "todos" | "email" | "email_sim";

interface ChannelFilterChipsProps {
  activeChannel: ChannelFilter | undefined;
}

const CHANNEL_CHIPS: { key: ChannelFilter; label: string }[] = [
  { key: "todos", label: t("channel.todos") },
  { key: "email", label: t("channel.email") },
  { key: "email_sim", label: t("channel.email_sim") },
];

export function ChannelFilterChips({ activeChannel }: ChannelFilterChipsProps) {
  const router = useRouter();
  const pathname = usePathname();
  const searchParams = useSearchParams();

  const handleClick = useCallback(
    (channel: ChannelFilter) => {
      const params = new URLSearchParams(searchParams.toString());
      if (channel === "todos") {
        params.delete("channel");
      } else {
        params.set("channel", channel);
      }
      params.delete("page");
      router.push(`${pathname}?${params.toString()}`);
    },
    [router, pathname, searchParams]
  );

  return (
    <div
      role="group"
      aria-label={t("filter.channel")}
      className="flex items-center gap-1.5 flex-wrap"
    >
      <span className="text-xs text-slate-500 font-medium mr-1">
        {t("filter.channel")}:
      </span>
      {CHANNEL_CHIPS.map(({ key, label }) => {
        const isActive =
          key === "todos" ? !activeChannel : activeChannel === key;
        return (
          <button
            key={key}
            onClick={() => handleClick(key)}
            aria-pressed={isActive}
            className={[
              "rounded-full px-2.5 py-0.5 text-xs font-medium transition-colors focus:outline-none focus-visible:ring-2 focus-visible:ring-slate-400",
              isActive
                ? "bg-slate-900 text-white"
                : "bg-slate-100 text-slate-600 hover:bg-slate-200 hover:text-slate-900",
            ].join(" ")}
          >
            {label}
          </button>
        );
      })}
    </div>
  );
}

// ── Severity filter ────────────────────────────────────────────────────────────

type SeverityFilter = "todos" | Severity;

interface SeverityFilterChipsProps {
  activeSeverity: Severity | undefined;
}

const SEVERITY_CHIPS: { key: SeverityFilter; label: string; color: string }[] =
  [
    {
      key: "todos",
      label: t("filter.todos"),
      color:
        "bg-slate-100 text-slate-600 hover:bg-slate-200 hover:text-slate-900",
    },
    {
      key: "low",
      label: t("severity.low"),
      color: "bg-slate-100 text-slate-600 hover:bg-slate-200",
    },
    {
      key: "medium",
      label: t("severity.medium"),
      color: "bg-yellow-50 text-yellow-800 hover:bg-yellow-100",
    },
    {
      key: "high",
      label: t("severity.high"),
      color: "bg-orange-50 text-orange-800 hover:bg-orange-100",
    },
    {
      key: "critical",
      label: t("severity.critical"),
      color: "bg-red-50 text-red-800 hover:bg-red-100",
    },
  ];

const SEVERITY_ACTIVE: Record<string, string> = {
  todos: "bg-slate-900 text-white",
  low: "bg-slate-400 text-white",
  medium: "bg-yellow-500 text-white",
  high: "bg-orange-500 text-white",
  critical: "bg-red-600 text-white",
};

export function SeverityFilterChips({
  activeSeverity,
}: SeverityFilterChipsProps) {
  const router = useRouter();
  const pathname = usePathname();
  const searchParams = useSearchParams();

  const handleClick = useCallback(
    (severity: SeverityFilter) => {
      const params = new URLSearchParams(searchParams.toString());
      if (severity === "todos") {
        params.delete("severity");
      } else {
        params.set("severity", severity);
      }
      params.delete("page");
      router.push(`${pathname}?${params.toString()}`);
    },
    [router, pathname, searchParams]
  );

  return (
    <div
      role="group"
      aria-label={t("filter.severity")}
      className="flex items-center gap-1.5 flex-wrap"
    >
      <span className="text-xs text-slate-500 font-medium mr-1">
        {t("filter.severity")}:
      </span>
      {SEVERITY_CHIPS.map(({ key, label, color }) => {
        const isActive =
          key === "todos" ? !activeSeverity : activeSeverity === key;
        return (
          <button
            key={key}
            onClick={() => handleClick(key)}
            aria-pressed={isActive}
            className={[
              "rounded-full px-2.5 py-0.5 text-xs font-medium transition-colors focus:outline-none focus-visible:ring-2 focus-visible:ring-slate-400",
              isActive ? SEVERITY_ACTIVE[key] : color,
            ].join(" ")}
          >
            {label}
          </button>
        );
      })}
    </div>
  );
}

// ── IsClaimFilter ──────────────────────────────────────────────────────────────

type IsClaimFilter = "todos" | "true" | "false";

interface IsClaimFilterChipsProps {
  activeIsClaim: IsClaimFilter | undefined;
}

const IS_CLAIM_CHIPS: { key: IsClaimFilter; label: string }[] = [
  { key: "todos", label: t("filter.todos") },
  { key: "true", label: t("filter.reclamos") },
  { key: "false", label: t("filter.no_relevantes") },
];

export function IsClaimFilterChips({ activeIsClaim }: IsClaimFilterChipsProps) {
  const router = useRouter();
  const pathname = usePathname();
  const searchParams = useSearchParams();

  const handleClick = useCallback(
    (isClaim: IsClaimFilter) => {
      const params = new URLSearchParams(searchParams.toString());
      if (isClaim === "todos") {
        params.delete("is_claim");
      } else {
        params.set("is_claim", isClaim);
      }
      params.delete("page");
      router.push(`${pathname}?${params.toString()}`);
    },
    [router, pathname, searchParams]
  );

  return (
    <div
      role="group"
      aria-label={t("filter.isClaim")}
      className="flex items-center gap-1.5 flex-wrap"
    >
      <span className="text-xs text-slate-500 font-medium mr-1">
        {t("filter.isClaim")}:
      </span>
      {IS_CLAIM_CHIPS.map(({ key, label }) => {
        const isActive =
          key === "todos" ? !activeIsClaim : activeIsClaim === key;
        return (
          <button
            key={key}
            onClick={() => handleClick(key)}
            aria-pressed={isActive}
            className={[
              "rounded-full px-2.5 py-0.5 text-xs font-medium transition-colors focus:outline-none focus-visible:ring-2 focus-visible:ring-slate-400",
              isActive
                ? "bg-slate-900 text-white"
                : "bg-slate-100 text-slate-600 hover:bg-slate-200 hover:text-slate-900",
            ].join(" ")}
          >
            {label}
          </button>
        );
      })}
    </div>
  );
}
