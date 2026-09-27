import "server-only";

import Link from "next/link";

import { getT, type Locale } from "@/lib/i18n";
import { leerEstadoDelAgente } from "@/server/agente/estado";

const COLOR: Record<"activo" | "modo_prueba" | "sin_presupuesto", string> = {
  activo: "bg-emerald-500",
  modo_prueba: "bg-amber-500",
  sin_presupuesto: "bg-red-500",
};

/**
 * El estado del agente para este inquilino, al pie del sidebar (G37).
 *
 * Server Component asíncrono: si `leerEstadoDelAgente` devuelve null —error
 * de la base, tabla ausente— no dibuja nada. El layout no se cae por esto.
 */
export async function EstadoDelAgente({
  tenantId,
  locale,
}: {
  tenantId: string;
  locale: Locale;
}) {
  const estado = await leerEstadoDelAgente({ tenantId });
  if (!estado) return null;

  const t = getT(locale);
  return (
    <Link
      href="/agente"
      className="mx-2 mb-2 flex items-center gap-2 rounded-xl px-3 py-2 text-[13.5px] text-slate-600 hover:bg-slate-100"
    >
      <span className={`h-2 w-2 flex-shrink-0 rounded-full ${COLOR[estado.estado]}`} />
      <span className="truncate">
        {t(`agente.estado.${estado.estado}`)}
        {estado.procesando > 0
          ? ` · ${t("agente.estado.procesando").replace("{n}", String(estado.procesando))}`
          : null}
      </span>
    </Link>
  );
}
