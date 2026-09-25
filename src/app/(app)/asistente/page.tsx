/**
 * Asistente page — Server Component.
 *
 * Sólo Plan Pro: sin ese plan se ve `BloqueoPlanPro`, igual que dice la barra
 * lateral con el candado. La guarda de verdad es `exigirPlanPro` en la ruta
 * de la API; acá sólo se evita mostrar una caja que va a rebotar con 403.
 */

import { redirect } from "next/navigation";
import { getSessionContext } from "@/lib/auth/session";
import { getUserRow } from "@/lib/auth/user-row";
import { esPlanPro } from "@/core/billing/plan-pro";
import { getT } from "@/lib/i18n";
import { getServerLocale } from "@/lib/i18n/locale";
import { BloqueoPlanPro } from "../_components/BloqueoPlanPro";
import { CajaDelAsistente } from "./_components/CajaDelAsistente";

export default async function AsistentePage() {
  const locale = await getServerLocale();
  const t = getT(locale);

  const session = await getSessionContext();
  if (!session?.user) redirect("/login");
  // Deduplicada con la del layout: ver lib/auth/user-row.ts.
  const userRow = await getUserRow(session.user.id);
  if (!userRow) redirect("/login");

  return (
    <div className="px-6 py-8 max-w-3xl">
      <div className="mb-8">
        <h1 className="text-xl font-semibold text-slate-900">{t("asistente.titulo")}</h1>
        <p className="mt-1 text-sm text-slate-500">{t("asistente.subtitulo")}</p>
      </div>

      {esPlanPro(userRow.plan) ? <CajaDelAsistente /> : <BloqueoPlanPro t={t} />}
    </div>
  );
}
