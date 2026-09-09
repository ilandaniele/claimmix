/**
 * El arranque del servidor.
 *
 * Next 16 llama a `register()` una vez por proceso, y en serverless eso es una
 * vez por arranque en frío.
 *
 * Acá adentro sólo va lo que de verdad haga falta cargar antes de atender el
 * primer pedido. Todo lo que se importe se paga en el peor momento posible:
 * el pedido que espera.
 */

export async function register() {
  /*
   * Sentry SÓLO si hay a dónde mandar los errores.
   *
   * Antes se importaba siempre. `sentry.server.config.ts` arranca con
   * `import * as Sentry from "@sentry/nextjs"` —veintidós paquetes, 43 MB en
   * disco, 260 ms de import medidos acá— y adentro tiene un `if
   * (process.env.SENTRY_DSN)` que no se cumple: la variable no está puesta ni
   * en producción, ni en la CI, ni en `.env.local`.
   *
   * O sea que cada arranque en frío pagaba un cuarto de segundo por inicializar
   * nada. En Vercel Hobby, donde la función se congela seguido, eso lo paga
   * alguien que acaba de chocar y está esperando la respuesta.
   *
   * La condición sube acá: sin DSN el módulo no se carga, y el día que haya uno
   * se carga igual que antes.
   */
  if (process.env.NEXT_RUNTIME === "nodejs" && process.env.SENTRY_DSN) {
    await import("./sentry.server.config");
  }
}
