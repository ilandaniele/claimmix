import type { RamoDelInquilino } from "@/core/case/ramos";
import { basePorCliente } from "@/data/bases";
import { enControl, enTenant, enTenantVarias } from "@/data/scope";
import { rebotarSiNoEntra } from "@/lib/auth/rebotar-si-no-entra";
import { requireAdmin } from "@/lib/auth/require-admin";
import { getT } from "@/lib/i18n";
import { consultaRamosDelInquilino } from "@/server/cases/ramos-del-inquilino";
import { codigoPg } from "@/server/core-sync/config";
import { getAccountLocale } from "@/server/i18n/idioma-de-la-cuenta";
import { consultaFormularioWeb, type FormularioDelInquilino } from "@/server/web/formulario-del-inquilino";
import { AgentConsoleClient } from "./AgentConsoleClient";
import { EntrenamientoBasePanel } from "./EntrenamientoBasePanel";
import { FormularioWebPanel } from "./FormularioWebPanel";
import { RamosPanel } from "./RamosPanel";
import { tituloDePantalla } from "@/app/(app)/_components/titulo-de-pantalla";

export const generateMetadata = tituloDePantalla("nav.agente");

export default async function AgentConsolePage() {
  let role = "admin";
  let tenantId = "";
  try {
    const { userRow } = await requireAdmin();
    role = userRow.role;
    tenantId = userRow.tenant_id;
  } catch (e) {
    rebotarSiNoEntra(e);
  }

  const idioma = await getAccountLocale();
  const t = getT(idioma);

  // Sin la 0044 las tablas no existen: los paneles avisan en vez de romper la consola.
  let ramos: RamoDelInquilino[] = [];
  let formulario: FormularioDelInquilino | null = null;
  let pendiente0044 = false;
  try {
    // Con base por cliente los ramos son de la base del inquilino y el formulario vive en control: dos viajes en paralelo. Apagada, uno solo.
    const ctx = { tenantId };
    const [ramosDelInquilino, formularioDelInquilino] = basePorCliente()
      ? await Promise.all([
          enTenant(ctx, (db) => consultaRamosDelInquilino(db)),
          enControl(ctx, (db) => consultaFormularioWeb(db)),
        ])
      : await enTenantVarias<[RamoDelInquilino[], FormularioDelInquilino[]]>(ctx, (db) => [
          consultaRamosDelInquilino(db),
          consultaFormularioWeb(db),
        ]);
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
        base={<EntrenamientoBasePanel t={t} idioma={idioma} />}
      />
    </div>
  );
}
