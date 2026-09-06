/**
 * Lo que la bandeja muestra y más de un spec necesita leer: el total del pie y
 * las filas de la tabla. Van en su propio archivo por el mismo motivo que
 * sesiones.ts: un spec no puede importar otro spec.
 */
import type { Locator, Page } from "@playwright/test";

/** El total que el pie declara: «Mostrando 1-100 de 261 siniestros» → 261. */
export async function totalDelPie(page: Page): Promise<number> {
  const texto = await page.getByText(/\b\d+-\d+\s+\S+\s+\d+\b/).first().innerText();
  const m = texto.match(/\d+-\d+\s+\S+\s+(\d+)/);
  if (!m) throw new Error(`no pude leer el total del pie: ${JSON.stringify(texto)}`);
  return Number(m[1]);
}

/** Las filas de la tabla. El único lugar que sabe cómo se llega a ellas. */
export function filas(page: Page): Locator {
  return page.locator('[data-scroll="lista"] tbody tr');
}
