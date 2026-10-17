/** Segundos en «45 s», «2,5 min» o «1,5 h» según el idioma; un guion sin dato. */
export function duracionLegible(segundos: number | null, locale: string): string {
  if (segundos === null || !Number.isFinite(segundos) || segundos < 0) return "—";
  if (Math.round(segundos) < 60) return `${Math.round(segundos)} s`;
  const decimal = new Intl.NumberFormat(locale, { maximumFractionDigits: 1 });
  // Compara ya redondeado a un decimal de minuto: 3597 s es «1 h», no «60 min».
  if (Math.round(segundos / 6) < 600) return `${decimal.format(segundos / 60)} min`;
  return `${decimal.format(segundos / 3600)} h`;
}
