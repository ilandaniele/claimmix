import { redirect } from "next/navigation";

import type { RamoDelInquilino } from "@/core/case/ramos";
import { enTenantVarias } from "@/data/scope";
import { requireAdmin } from "@/lib/auth/require-admin";
import { AppError } from "@/lib/errors";
import { getT } from "@/lib/i18n";
import { consultaRamosDelInquilino } from "@/server/cases/ramos-del-inquilino";
import { codigoPg } from "@/server/core-sync/config";
import { getAccountLocale } from "@/server/i18n/idioma-de-la-cuenta";
import { consultaFormularioWeb, type FormularioDelInquilino } from "@/server/web/formulario-del-inquilino";
import { AgentConsoleClient } from "./AgentConsoleClient";
import { FormularioWebPanel } from "./FormularioWebPanel";
import { RamosPanel } from "./RamosPanel";

export default async function AgentConsolePage() {
  let role = "admin";
  let tenantId = "";
  try {
    const { userRow } = await requireAdmin();
    role = userRow.role;
    tenantId = userRow.tenant_id;
  } catch (e) {
    if (e instanceof AppError && e.code === "MISSING_SESSION") redirect("/login");
    redirect("/bandeja");
  }

  const idioma = await getAccountLocale();
  const t = getT(idioma);

  // Sin la 0044 las tablas no existen: los paneles avisan en vez de romper la consola.
  let ramos: RamoDelInquilino[] = [];
  let formulario: FormularioDelInquilino | null = null;
  let pendiente0044 = false;
  try {
    const [ramosDelInquilino, formularioDelInquilino] = await enTenantVarias<
      [RamoDelInquilino[], FormularioDelInquilino[]]
    >({ tenantId }, (db) => [consultaRamosDelInquilino(db), consultaFormularioWeb(db)]);
    ramos = ramosDelInquilino;
    formulario = formularioDelInquilino[0] ?? null;
  } catch (e) {
    if (codigoPg(e) !== "42P01") throw e;
    pendiente0044 = true;
  }

  return (
    <div className="max-w-6xl px-6 py-8">
      <div className="mb-5">
        <h1 className="text-xl font-semibold text-slate-900 dark:text-slate-100">
          {t("consola.titulo")}
        </h1>
      </div>
      <AgentConsoleClient
        role={role}
        ramos={<RamosPanel t={t} idioma={idioma} ramos={ramos} pendiente={pendiente0044} />}
        formulario={<FormularioWebPanel t={t} formulario={formulario} pendiente={pendiente0044} />}
      />
    </div>
  );
}
