import { Lock } from "lucide-react";

import type { TranslationKey } from "@/lib/i18n";
import { Card, Pill } from "./ui";

/**
 * Lo que ve en lugar de la función quien no tiene el Plan Pro.
 *
 * `t` viene de la página, que ya resolvió el idioma: resolverlo de nuevo acá
 * duplicaba la preferencia de la cuenta contra la cookie.
 *
 * `funcion` nombra qué es lo que está bloqueado — «Asistente con IA»,
 * «Responder por WhatsApp desde la app» — para que el mismo candado sirva en
 * más de un lugar sin que la persona tenga que adivinar qué le falta.
 */
export function BloqueoPlanPro({
  t,
  funcion,
}: {
  t: (k: TranslationKey) => string;
  funcion?: string;
}) {
  return (
    <Card className="flex flex-col items-center gap-3 px-6 py-10 text-center">
      <Lock size={22} className="text-violet-600" aria-hidden="true" />
      <Pill tone="acento">{t("planPro.nombre")}</Pill>
      {funcion && <p className="text-[14px] font-medium text-slate-800">{funcion}</p>}
      <p className="text-[14px] text-slate-600">{t("planPro.bloqueado")}</p>
    </Card>
  );
}
