import { test, expect } from "@playwright/test";
import { SESION_ANALISTA } from "./sesiones";

const CASO = process.env.PLAYWRIGHT_EMAIL_CASE_ID;
const ADJUNTO = process.env.PLAYWRIGHT_PDF_ATTACHMENT_ID;
const TAMANO = 8 * 1024 * 1024;

test.describe("un PDF de 8 MB se sirve por streaming", () => {
  test.skip(!CASO || !ADJUNTO, "Skipped: PLAYWRIGHT_EMAIL_CASE_ID / PLAYWRIGHT_PDF_ATTACHMENT_ID not set");
  test.use({ storageState: SESION_ANALISTA });

  test("llega entero, en más de un trozo, y el primero antes que el último", async ({ page }) => {
    await page.goto("/bandeja"); // any same-origin page so `fetch` carries the session cookie
    const medido = await page.evaluate(async (url) => {
      const t0 = performance.now();
      const res = await fetch(url);
      const cabeceras = performance.now() - t0;
      const lector = res.body!.getReader();
      let bytes = 0, trozos = 0, primerTrozo = -1;
      for (;;) {
        const { done, value } = await lector.read();
        if (done) break;
        if (primerTrozo < 0) primerTrozo = performance.now() - t0;
        bytes += value.byteLength;
        trozos++;
      }
      return {
        status: res.status,
        tipo: res.headers.get("content-type"),
        largo: res.headers.get("content-length"),
        disposicion: res.headers.get("content-disposition"),
        cache: res.headers.get("cache-control"),
        bytes, trozos, cabeceras, primerTrozo, total: performance.now() - t0,
      };
    }, `/api/cases/${CASO}/attachments/${ADJUNTO}`);

    expect(medido.status).toBe(200);
    expect(medido.tipo).toBe("application/pdf");
    expect(medido.largo).toBe(String(TAMANO));
    expect(medido.disposicion).toMatch(/^inline/);
    expect(medido.cache).toContain("no-store");
    expect(medido.bytes).toBe(TAMANO);
    expect(medido.trozos).toBeGreaterThan(1);
    expect(medido.primerTrozo).toBeLessThan(medido.total);
    console.log(`[adjunto-de-8mb] cabeceras ${medido.cabeceras.toFixed(0)} ms · primer trozo ${medido.primerTrozo.toFixed(0)} ms · total ${medido.total.toFixed(0)} ms · ${medido.trozos} trozos`);
  });
});
