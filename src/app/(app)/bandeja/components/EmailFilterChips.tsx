/**
 * EmailFilterChips — additional filter chips for email-sourced claims.
 *
 * AC18: Adds channel, severity, and is_claim filters alongside existing type chips.
 * Each chip change updates the URL search params and resets to page 1.
 */

"use client";

import { useRouter, useSearchParams, usePathname } from "next/navigation";
import { useFilterParam } from "./useFilterParam";
import { CHIP_BASE, claseChip, ROTULO_GRUPO } from "./chip";
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
      className="flex flex-wrap items-center gap-1"
    >
      <span className={ROTULO_GRUPO}>
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
            className={claseChip(isActive)}
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

  /*
   * Los cinco chips ya no traen cada uno su color de reposo.
   *
   * Lo traian —gris, gris, amarillo, naranja, rojo— y el resultado era que la
   * rampa entera estaba encendida todo el tiempo, con lo cual no se distinguia
   * cual estaba elegido: los cinco se veian igual de "puestos". Ahora en reposo
   * son texto, y el color aparece solo en el que esta filtrando.
   */
  const SEVERITY_CHIPS: { key: SeverityFilter; label: string }[] = [
    { key: "todos", label: t("filter.todos") },
    { key: "low", label: t("severity.low") },
    { key: "medium", label: t("severity.medium") },
    { key: "high", label: t("severity.high") },
    { key: "critical", label: t("severity.critical") },
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
      className="flex flex-wrap items-center gap-1"
    >
      <span className={ROTULO_GRUPO}>
        {t("filter.severity")}:
      </span>
      {SEVERITY_CHIPS.map(({ key, label }) => {
        const isActive =
          key === "todos" ? !activeSeverity : activeSeverity === key;
        return (
          <button
            key={key}
            onClick={() => handleClick(key)}
            aria-pressed={isActive}
            className={
              /*
               * La severidad es el unico grupo que NO usa el violeta al estar
               * activo: el chip se pinta del color de su nivel, porque eso es
               * justamente lo que se esta filtrando. Inactivo se comporta como
               * todos los demas.
               */
              isActive
                ? `${CHIP_BASE} ${SEVERITY_ACTIVE[key]}`
                : claseChip(false)
            }
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
      className="flex flex-wrap items-center gap-1"
    >
      <span className={ROTULO_GRUPO}>
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
            className={claseChip(isActive)}
          >
            {label}
          </button>
        );
      })}
    </div>
  );
}
