import { Lock } from "lucide-react";

import type { TranslationKey } from "@/lib/i18n";
import { Card, Pill } from "./ui";

/**
 * Lo que ve en lugar de la función quien no tiene el Plan Pro.
 *
 * `t` viene de la página, que ya resolvió el idioma: resolverlo de nuevo acá
 * duplicaba la preferencia de la cuenta contra la cookie.
 */
export function BloqueoPlanPro({ t }: { t: (k: TranslationKey) => string }) {
  return (
    <Card className="flex flex-col items-center gap-3 px-6 py-10 text-center">
      <Lock size={22} className="text-violet-600" aria-hidden="true" />
      <Pill tone="acento">{t("planPro.nombre")}</Pill>
      <p className="text-[14px] text-slate-600">{t("planPro.bloqueado")}</p>
    </Card>
  );
}
