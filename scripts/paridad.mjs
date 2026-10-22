/**
 * `node scripts/paridad.mjs` (`pnpm paridad`) — comparar las banderas de dev, QA y prd.
 *
 * Le pide `/api/health` con su Bearer a cada ambiente, junta `banderas` y lista
 * las diferencias que no estén en la tabla de excepciones de `lib/paridad.mjs`.
 * Qué cuenta como diferencia y qué se imprime vive allá; acá sólo está la red.
 *
 * - Sin `?deep=1`: la versión de fondo sube un archivo a R2 y le habla al modelo.
 * - El pedido (reintentos, plazo) es `pedirSalud` de `lib/salud.mjs`, el mismo de
 *   `mirar-salud.mjs`, en modo `estricto`: no sigue redirecciones ni imprime el error.
 * - Cada secreto viaja a su origen y a ningún otro: dev y QA tienen el suyo fijo,
 *   prd el de `PRD_URL`, que no puede ser ninguno de los dos. Sin secreto o sin URL
 *   no se hace el pedido, y si el ambiente redirige el pedido corta.
 * - En Actions, `DEPLOY_AMBIENTE` y `DEPLOY_SHA` dicen qué ambiente acaba de desplegarse: Vercel
 *   mueve el alias después de avisar, así que ese ambiente se espera hasta que sirva ese
 *   commit (`leerAmbiente`) y, si no llega, queda ilegible en vez de comparar el build viejo.
 * - Nunca sale rojo: la comparación AVISA (`::warning` y el resumen del run).
 *   Si un ambiente no contesta, queda dicho como ilegible y se compara el resto.
 * - Nada del error, de los encabezados ni del cuerpo llega a la salida; en Actions
 *   (log público) tampoco ningún valor.
 */
import { appendFileSync } from "node:fs";

import { HOST_DEV, HOST_QA } from "./lib/hosts-vetados.mjs";
import { AMBIENTES, commitEsperado, compararParidad, leerAmbiente, leerRespuesta, lineasDeParidad, urlDePrd } from "./lib/paridad.mjs";
import { pedirSalud } from "./lib/salud.mjs";

const ENTRADAS = {
  dev: { origen: `https://${HOST_DEV}`, secreto: process.env.CRON_SECRET, sinOrigen: "" },
  qa: { origen: `https://${HOST_QA}`, secreto: process.env.QA_CRON_SECRET, sinOrigen: "" },
  prd: { origen: urlDePrd(process.env.PRD_URL), secreto: process.env.PRD_CRON_SECRET, sinOrigen: "PRD_URL vacía o inválida" },
};

async function main() {
  /** @type {Record<string, import("./lib/paridad.mjs").Lectura>} */
  const lecturas = {};
  await Promise.all(
    AMBIENTES.map(async (ambiente) => {
      const { origen, secreto, sinOrigen } = ENTRADAS[/** @type {keyof typeof ENTRADAS} */ (ambiente)];
      if (!secreto) {
        lecturas[ambiente] = { legible: false, motivo: "falta el secreto" };
      } else if (!origen) {
        lecturas[ambiente] = { legible: false, motivo: sinOrigen };
      } else {
        // Del ambiente recién desplegado no se lee nada hasta que sirva el commit del deploy.
        const esperado = ambiente === process.env.DEPLOY_AMBIENTE ? commitEsperado(process.env.DEPLOY_SHA) : null;
        lecturas[ambiente] = await leerAmbiente(async () => {
          const { codigo, cuerpo } = await pedirSalud(origen, secreto, { etiqueta: ambiente, estricto: true });
          return leerRespuesta(codigo, cuerpo);
        }, esperado);
      }
    }),
  );

  // Los logs de Actions son públicos: ahí van claves y qué ambientes coinciden,
  // sin valores. Corrido a mano se ven enteros.
  const enActions = process.env.GITHUB_ACTIONS === "true";
  const { avisos, resumen } = lineasDeParidad(compararParidad(lecturas), { sinValores: enActions });

  if (enActions) for (const a of avisos) console.log(a);
  console.log(resumen);
  if (process.env.GITHUB_STEP_SUMMARY) appendFileSync(process.env.GITHUB_STEP_SUMMARY, `${resumen}\n`);
}

// Sin `process.exit()`: cortar con sockets abiertos revienta Node en Windows con
// un assert de libuv. Y un fallo inesperado avisa, no tumba el run.
try {
  await main();
} catch {
  console.log("::warning title=Paridad::falló el comparador");
}
