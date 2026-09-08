/**
 * Qué significa lo que contestó `/api/health`.
 *
 * Vive aparte del guión que la llama porque es la decisión que se equivoca
 * sola, y no se puede comprobar pegándole a producción desde una prueba.
 *
 * La ruta contesta 503 SÓLO cuando algo está `down`; todo lo `degraded` sale
 * 200. Un centinela que mirara nada más el código HTTP habría dado verde la
 * semana en que reconectar la casilla se llevó puesto el aviso de push de
 * Gmail y el correo pasó a entrar por el cron en vez de en segundos: el
 * sistema se veía sano y estaba lento, y habría seguido así una semana.
 *
 * El campo que decide es `status` del cuerpo. El detalle está en `checks[]`.
 */

/** @typedef {{ name: string, status: string, detail: string }} Chequeo */
/** @typedef {{ estado: string, lineas: string[], avisos: string[], errores: string[] }} Lectura */

// Las mismas marcas que imprime `pnpm smoke`, para que quien mire las dos
// corridas lea lo mismo.
const MARCA = { ok: "✓", degraded: "!", down: "✗" };

/**
 * @param {number} codigo   el código HTTP; 0 si no contestó
 * @param {unknown} cuerpo  el JSON que devolvió, o null si no se pudo parsear
 * @returns {Lectura}
 */
export function interpretarSalud(codigo, cuerpo) {
  /** @param {string} mensaje @returns {Lectura} */
  const seco = (mensaje) => ({
    estado: "sin-lectura",
    lineas: [],
    avisos: [],
    errores: [mensaje],
  });

  if (codigo === 0) {
    return seco(
      "/api/health no contestó en tres intentos: no se sabe cómo está producción."
    );
  }
  if (codigo === 401) {
    return seco(
      "/api/health rechazó la llave: el CRON_SECRET del repositorio no es el de producción."
    );
  }

  // 200 y 503 son las dos únicas formas de contestar que tiene la ruta.
  // Cualquier otra —un 502 de Vercel, un 404 de un alias a medio mover— es «no
  // sé cómo está», que no es lo mismo que «está bien».
  if (codigo !== 200 && codigo !== 503) {
    return seco(`/api/health contestó ${codigo}: no se pudo leer la salud del deploy.`);
  }

  const c = /** @type {{ status?: unknown, checks?: unknown }} */ (cuerpo ?? {});
  const estado = typeof c.status === "string" ? c.status : "";
  const chequeos = /** @type {Chequeo[] | null} */ (
    Array.isArray(c.checks) ? c.checks : null
  );

  if (!estado || !chequeos) {
    // Un cuerpo ilegible es la página de error de Vercel, no el informe.
    return seco("/api/health contestó algo que no es el informe de salud.");
  }

  /** @param {Chequeo} x */
  const nombrar = (x) => `${x.name} — ${x.detail}`;

  const errores = chequeos.filter((x) => x.status === "down").map(nombrar);

  // El informe dice `down` y no dice cuál: eso no se tapa con un verde.
  if (estado === "down" && errores.length === 0) {
    errores.push("el informe dice `down` y no nombra ningún chequeo caído.");
  }

  return {
    estado,
    lineas: chequeos.map(
      (x) => `${MARCA[/** @type {keyof typeof MARCA} */ (x.status)] ?? "?"} ${x.name}: ${x.detail}`
    ),
    avisos: chequeos.filter((x) => x.status === "degraded").map(nombrar),
    errores,
  };
}
