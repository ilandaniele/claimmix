import { test, expect } from "@playwright/test";
import { SESION_ANALISTA } from "./sesiones";

const CASO = process.env.PLAYWRIGHT_EMAIL_CASE_ID;
const ADJUNTO = process.env.PLAYWRIGHT_SVG_ATTACHMENT_ID;

/*
 * Lo que se mira es la respuesta que sale por el cable, no la del handler.
 *
 * `adjunto-servido.test.ts` ya prueba que el handler arma la CSP con
 * `sandbox`. Pero `next.config.ts` pone otra CSP a todo `/api`, y Next no pisa
 * una cabecera que la config ya fijó: si las dos se pisan mal, el `sandbox`
 * del handler se pierde y ningún test unitario se entera. Acá se pide un SVG
 * con `<script>` por HTTP, con la sesión de un analista, y se mira qué llega.
 */
test.describe("un SVG con script se sirve encerrado", () => {
  test.skip(!CASO || !ADJUNTO, "Skipped: PLAYWRIGHT_EMAIL_CASE_ID / PLAYWRIGHT_SVG_ATTACHMENT_ID not set");
  test.use({ storageState: SESION_ANALISTA });

  test("llega con la CSP del handler (sandbox incluido), nosniff y para descargar", async ({ page }) => {
    const res = await page.request.get(`/api/cases/${CASO}/attachments/${ADJUNTO}`);
    const cabeceras = res.headers();

    expect(res.status()).toBe(200);

    const csp = (cabeceras["content-security-policy"] ?? "").split(";").map((d) => d.trim());
    expect(csp).toContain("sandbox");
    expect(csp).toContain("default-src 'none'");
    expect(csp).toContain("img-src 'self'"); // sólo la del handler la trae: la de la config no

    expect(cabeceras["x-content-type-options"]).toBe("nosniff");
    // Un SVG no es una foto: el handler lo baja como binario genérico en vez de abrirlo.
    expect(cabeceras["content-type"]).toBe("application/octet-stream");
    expect(cabeceras["content-disposition"]).toMatch(/^attachment;/);
  });
});
