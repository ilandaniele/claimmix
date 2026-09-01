/**
 * EmailFilterChips — additional filter chips for email-sourced claims.
 *
 * AC18: Adds channel, severity, and is_claim filters alongside existing type chips.
 * Each chip change updates the URL search params and resets to page 1.
 */

"use client";

import { useRouter, useSearchParams, usePathname } from "next/navigation";
import { useFilterParam } from "./useFilterParam";
import { useCallback } from "react";
import { useT } from "@/lib/i18n/LocaleContext";
import type { Severity } from "@/lib/schemas/cases";

// ── Channel filter ─────────────────────────────────────────────────────────────

type ChannelFilter = "todos" | "email" | "email_sim";

interface ChannelFilterChipsProps {
  activeChannel: ChannelFilter | undefined;
}

export function ChannelFilterChips({ activeChannel }: ChannelFilterChipsProps) {
  const t = useT();
  const setFilter = useFilterParam();

  const CHANNEL_CHIPS: { key: ChannelFilter; label: string }[] = [
    { key: "todos", label: t("channel.todos") },
    { key: "email", label: t("channel.email") },
    { key: "email_sim", label: t("channel.email_sim") },
  ];

  const handleClick = useCallback(
      (channel: ChannelFilter) => {
        setFilter("channel", channel === "todos" ? null : channel);
      },
      [setFilter]
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
                ? "bg-violet-600 text-white"
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

const SEVERITY_ACTIVE: Record<string, string> = {
  todos: "bg-violet-600 text-white",
  low: "bg-slate-400 text-white",
  medium: "bg-yellow-500 text-white",
  high: "bg-orange-500 text-white",
  critical: "bg-red-600 text-white",
};

export function SeverityFilterChips({
  activeSeverity,
}: SeverityFilterChipsProps) {
  const t = useT();
  const setFilter = useFilterParam();

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

  const handleClick = useCallback(
      (severity: SeverityFilter) => {
        setFilter("severity", severity === "todos" ? null : severity);
      },
      [setFilter]
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

export function IsClaimFilterChips({ activeIsClaim }: IsClaimFilterChipsProps) {
  const t = useT();
  const setFilter = useFilterParam();

  const IS_CLAIM_CHIPS: { key: IsClaimFilter; label: string }[] = [
    { key: "todos", label: t("filter.todos") },
    { key: "true", label: t("filter.reclamos") },
    { key: "false", label: t("filter.no_relevantes") },
  ];

  const handleClick = useCallback(
      (isClaim: IsClaimFilter) => {
        setFilter("is_claim", isClaim === "todos" ? null : isClaim);
      },
      [setFilter]
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
                ? "bg-violet-600 text-white"
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
