"use client";

import type { Severity } from "@/lib/schemas/cases";
import { useT } from "@/lib/i18n/LocaleContext";

interface SeverityBadgeProps {
  severity: Severity | string | null | undefined;
}

/*
 * La misma rampa de antes, un escalón más suave.
 *
 * Los fondos `-100` competían con el texto de la fila: en una tabla donde casi
 * todas las filas tienen severidad, cuatro colores saturados repetidos ochenta
 * veces tapan lo que sí es excepcional. Con `-50` la rampa se sigue leyendo
 * —gris, amarillo, naranja, rojo— y deja de gritar.
 *
 * Los pares elegidos son los que `globals.css` ya pisa en modo oscuro. Sumar una
 * familia sin override (teal, sky, rose) deja la píldora casi blanca sobre fondo
 * oscuro, y eso no se ve leyendo el diff.
 */
const SEVERITY_CLASSES: Record<Severity, string> = {
  low: "bg-slate-100 text-slate-600",
  medium: "bg-yellow-50 text-yellow-800",
  high: "bg-orange-50 text-orange-800",
  /*
   * La única que conserva el fondo `-100`, por dos razones.
   *
   * Una es que `critical` es rara y es la que tiene que interrumpir: bajarla al
   * mismo tono que las otras tres la vuelve una más de la fila.
   *
   * La otra la encontró el test de colisión de `source-badge.test.tsx`: con
   * `bg-red-50 text-red-700` esta píldora quedaba EXACTAMENTE igual que la
   * insignia de ESTADO de un caso escalado, y las dos columnas están una al lado
   * de la otra. Dos cosas distintas pintadas igual, a diez píxeles de distancia.
   */
  critical: "bg-red-100 text-red-800",
};

export function SeverityBadge({ severity }: SeverityBadgeProps) {
  const t = useT();
  if (!severity) return null;

  const SEVERITY_LABELS: Record<Severity, string> = {
    low: t("severity.low"),
    medium: t("severity.medium"),
    high: t("severity.high"),
    critical: t("severity.critical"),
  };

  const classes =
    SEVERITY_CLASSES[severity as Severity] ?? "bg-slate-100 text-slate-600";
  const label = SEVERITY_LABELS[severity as Severity] ?? severity;

  return (
    <span
      className={`inline-flex items-center whitespace-nowrap rounded-full px-2.5 py-0.5 text-[12px] font-medium ${classes}`}
      data-severity={severity}
    >
      {label}
    </span>
  );
}
