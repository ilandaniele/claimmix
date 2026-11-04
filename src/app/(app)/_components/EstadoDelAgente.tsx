import "server-only";

import Link from "next/link";

import { getT, type Locale } from "@/lib/i18n";
import { leerEstadoDelAgente, type EstadoDelAgente as Estado } from "@/server/agente/estado";

const COLOR: Record<Estado["estado"], string> = {
  activo: "bg-emerald-500",
  modo_prueba: "bg-amber-500",
  sin_presupuesto: "bg-red-500",
  ia_frenada: "bg-slate-400",
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
  const texto =
    t(`agente.estado.${estado.estado}`) +
    (estado.procesando > 0
      ? ` · ${t("agente.estado.procesando").replace("{n}", String(estado.procesando))}`
      : "");
  // `barra-item` y `barra-texto`: con la barra contraída queda sólo el punto de color
  // y el texto pasa a la vista del lector de pantalla y al tooltip (`globals.css`).
  return (
    <Link
      href="/agente"
      title={texto}
      className="barra-item mx-2 mb-2 flex items-center gap-2 rounded-xl px-3 py-2 text-[13.5px] text-slate-600 hover:bg-slate-100"
    >
      <span className={`h-2 w-2 flex-shrink-0 rounded-full ${COLOR[estado.estado]}`} />
      <span className="barra-texto truncate">{texto}</span>
    </Link>
  );
}
