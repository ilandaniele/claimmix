// "2026-09" is a period label, not an instant: build and format in UTC.
// Formatting in America/Argentina/Buenos_Aires shifts it to the previous month.
export function mesDeCalendario(mes: string, locale: string): string {
  const [anio, m] = mes.split("-");
  const fecha = new Date(Date.UTC(Number(anio), Number(m) - 1, 1));
  return fecha.toLocaleDateString(locale, {
    month: "long",
    year: "numeric",
    timeZone: "UTC",
  });
}
