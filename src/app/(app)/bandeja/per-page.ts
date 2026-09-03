/**
 * Cuántos siniestros por página se pueden pedir.
 *
 * Vive en su propio archivo, sin `"use client"`, y no es prolijidad: es el
 * arreglo de «si selecciono 100 se rompe».
 *
 * La constante estaba exportada desde `DashboardClient.tsx`, que es un módulo
 * de cliente, y `page.tsx` —componente de servidor— la importaba de ahí para
 * validar `?per_page=`. En React Server Components un export que no es un
 * componente NO cruza esa frontera como valor: cruza como una referencia de
 * cliente, un proxy. Así que en el servidor `PER_PAGE_OPTIONS` no era un array
 * y `.includes` no existía. La página reventaba con un `TypeError` cada vez que
 * la URL traía `per_page`, que es exactamente lo que pasa al elegir 100.
 *
 * No lo agarraba nada: `tsc` ve el tipo real y está conforme, `next build`
 * compila porque el proxy se resuelve en tiempo de ejecución, y con el valor
 * por omisión la URL no lleva el parámetro, así que la rama nunca corría. Lo
 * encontró el e2e que navega a `/bandeja?per_page=100` con sesión real.
 *
 * `listCases` acepta hasta 100; este es el tope que ofrece la pantalla.
 */
export const PER_PAGE_OPTIONS = [10, 20, 50, 100] as const;
