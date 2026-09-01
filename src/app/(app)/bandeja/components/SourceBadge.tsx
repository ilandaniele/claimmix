/**
 * SourceBadge — provider/channel badge for the "Fuente" column in CasesTable.
 *
 * Color palette (IC7 — distinct from StatusBadge and SeverityBadge):
 *   email      → bg-blue-50  / text-blue-700   (Gmail)
 *   email_sim  → bg-slate-100 / text-slate-600  (Sim — same bg token as Severity.low and
 *                Status.cerrado/no_relevante, but text-slate-600 differs; combined
 *                class string "bg-slate-100 text-slate-600" matches SeverityBadge's low
 *                palette exactly — use bg-slate-200 to break the collision per AC18)
 *
 * AC15: channel='email'     → data-source="gmail", text "Gmail", blue palette
 * AC16: channel='email_sim' → data-source="sim",   text "Sim",   slate palette
 * AC18: color combos must NOT duplicate StatusBadge or SeverityBadge class strings.
 *
 * StatusBadge  uses: bg-slate-100 text-slate-800  (cerrado)
 *                    bg-blue-100  text-blue-800   (procesando)
 * SeverityBadge uses: bg-slate-100 text-slate-700 (low)
 *
 * SourceBadge uses:  bg-blue-50  text-blue-700   (Gmail)  ← no collision
 *                    bg-slate-200 text-slate-600  (Sim)   ← no collision
 */

"use client";

import { useT } from "@/lib/i18n/LocaleContext";
import { Vacio } from "./Vacio";

interface SourceBadgeProps {
  /** The case channel value from CaseRow */
  channel: string | null | undefined;
}

/** Inline pill base shared by all variants */
const BASE =
  "inline-flex items-center rounded-full px-2 py-0.5 text-xs font-medium";

export function SourceBadge({ channel }: SourceBadgeProps) {
  const t = useT();
  if (channel === "email") {
    return (
      <span
        className={`${BASE} bg-blue-50 text-blue-700`}
        data-source="gmail"
        aria-label={t("provider.gmail")}
      >
        {t("provider.gmail")}
      </span>
    );
  }

  if (channel === "email_sim") {
    return (
      <span
        className={`${BASE} bg-slate-200 text-slate-600`}
        data-source="sim"
        aria-label={t("provider.sim")}
      >
        {t("provider.sim")}
      </span>
    );
  }

  // Future channels (whatsapp, etc.) and null/undefined → neutral dash
  return <Vacio />;
}
