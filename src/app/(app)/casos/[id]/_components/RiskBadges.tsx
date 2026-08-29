/**
 * Las dos insignias del análisis automático: riesgo de fraude y gravedad de las
 * lesiones.
 *
 * Vivían sueltas al final de `page.tsx`, entre las funciones que consultaban la
 * base. Son vocabulario del dominio —lo mismo que `StatusBadge` y
 * `SeverityBadge`, que ya viven en su propio archivo— y no tienen nada que ver
 * con armar la pantalla.
 *
 * Las dos leen un valor que viene de la base como texto libre y ninguna asume
 * que sea uno de los esperados: un valor nuevo se muestra tal cual, con el
 * estilo más suave. Es lo correcto para algo que puede cambiar del lado del
 * modelo sin avisarle a la pantalla.
 */

const ESTILO_FRAUDE: Record<string, string> = {
  high: "bg-red-100 text-red-800 dark:bg-red-900/60 dark:text-red-100",
  medium: "bg-amber-100 text-amber-800 dark:bg-amber-900/60 dark:text-amber-100",
  low: "bg-yellow-100 text-yellow-800 dark:bg-yellow-900/60 dark:text-yellow-100",
};

const TEXTO_FRAUDE: Record<string, string> = {
  high: "Riesgo alto",
  medium: "Riesgo medio",
  low: "Riesgo bajo",
};

export function FraudRiskBadge({ level }: { level: string }) {
  return (
    <span
      className={`inline-flex items-center rounded-full px-2.5 py-0.5 text-xs font-medium ${
        ESTILO_FRAUDE[level] ?? ESTILO_FRAUDE.low
      }`}
    >
      {TEXTO_FRAUDE[level] ?? level}
    </span>
  );
}

const ESTILO_LESIONES: Record<string, string> = {
  fatal: "bg-red-100 text-red-800 dark:bg-red-900/60 dark:text-red-100",
  severe: "bg-orange-100 text-orange-800 dark:bg-orange-900/60 dark:text-orange-100",
  minor: "bg-amber-100 text-amber-800 dark:bg-amber-900/60 dark:text-amber-100",
  none: "bg-slate-100 text-slate-600 dark:bg-slate-800 dark:text-slate-300",
};

const TEXTO_LESIONES: Record<string, string> = {
  fatal: "Fatal",
  severe: "Graves",
  minor: "Leves",
  none: "Sin lesiones",
};

export function InjurySeverityBadge({ severity }: { severity: string }) {
  return (
    <span
      className={`inline-flex items-center rounded-full px-2.5 py-0.5 text-xs font-medium ${
        ESTILO_LESIONES[severity] ?? ESTILO_LESIONES.none
      }`}
    >
      {TEXTO_LESIONES[severity] ?? severity}
    </span>
  );
}
