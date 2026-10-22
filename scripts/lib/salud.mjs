/**
 * `/api/health`: el pedido (`pedirSalud`) y qué significa lo que contestó
 * (`interpretarSalud`).
 *
 * Viven aparte de los guiones que las usan (`mirar-salud.mjs`, `paridad.mjs`): el
 * pedido, para que los dos hagan los mismos reintentos y plazos; la interpretación,
 * porque es la decisión que se equivoca sola y no se puede comprobar pegándole a
 * producción desde una prueba.
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
 * `GET <origen>/api/health` con el Bearer, para `mirar-salud.mjs` y `paridad.mjs`.
 *
 * Tres intentos: la red de un runner se corta sola. Un 401 no se repite. Un 200 o
 * un 503 sólo valen con un JSON objeto: el 503 de la plataforma (FUNCTION_THROTTLED,
 * un deploy pausado) trae HTML, y un 200 cuyo cuerpo cortó el plazo no se puede
 * leer; los dos son cortes pasajeros y se reintentan.
 *
 * @param {string} origen
 * @param {string} secreto
 * @param {{ etiqueta?: string, estricto?: boolean, esperaMs?: number }} [opciones]
 *   `etiqueta` encabeza cada línea del log. `estricto` es para quien lleva varios secretos
 *   en un log público: no sigue redirecciones y no imprime nada del error. `esperaMs` es la
 *   pausa entre intentos.
 * @returns {Promise<{ codigo: number, cuerpo: unknown }>} el último código visto (0 si no
 *   hubo respuesta) y el cuerpo, o null si nunca llegó uno legible
 */
export async function pedirSalud(origen, secreto, { etiqueta = "", estricto = false, esperaMs = 10_000 } = {}) {
  const marca = etiqueta ? `${etiqueta}: ` : "";
  let codigo = 0;
  for (let intento = 1; intento <= 3; intento++) {
    try {
      const res = await fetch(`${origen}/api/health`, {
        headers: { Authorization: `Bearer ${secreto}` },
        redirect: estricto ? "error" : "follow",
        // La ruta declara maxDuration 60 y en frío se toma varios segundos: un
        // plazo más corto convertiría un arranque en frío en un rojo.
        signal: AbortSignal.timeout(70_000),
      });
      codigo = res.status;
      const cuerpo = await res.json().catch(() => null);
      const informe = typeof cuerpo === "object" && cuerpo !== null && !Array.isArray(cuerpo);
      if (codigo === 401 || ((codigo === 200 || codigo === 503) && informe)) return { codigo, cuerpo };
      console.log(`${marca}intento ${intento}: HTTP ${codigo}`);
    } catch (err) {
      console.log(`${marca}intento ${intento}: ${!estricto && err instanceof Error ? err.message : "sin respuesta"}`);
    }
    if (intento < 3) await new Promise((r) => setTimeout(r, esperaMs));
  }
  return { codigo, cuerpo: null };
}

/**
 * @param {number} codigo   el código HTTP; 0 si no contestó
 * @param {unknown} cuerpo  el JSON que devolvió, o null si no se pudo parsear
 * @param {{ sinDetalle?: boolean }} [opciones]  `sinDetalle`: nombre y estado de cada
 *   chequeo, sin el detalle (el número de WhatsApp, la casilla de Gmail…), para un log público
 * @returns {Lectura}
 */
export function interpretarSalud(codigo, cuerpo, opciones = {}) {
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
  const nombrar = (x) => (opciones.sinDetalle ? `${x.name} — ${x.status}` : `${x.name} — ${x.detail}`);
  /** @param {Chequeo} x */
  const linea = (x) => {
    const marca = MARCA[/** @type {keyof typeof MARCA} */ (x.status)] ?? "?";
    return opciones.sinDetalle ? `${marca} ${x.name}` : `${marca} ${x.name}: ${x.detail}`;
  };

  const errores = chequeos.filter((x) => x.status === "down").map(nombrar);

  // El informe dice `down` y no dice cuál: eso no se tapa con un verde.
  if (estado === "down" && errores.length === 0) {
    errores.push("el informe dice `down` y no nombra ningún chequeo caído.");
  }

  return {
    estado,
    lineas: chequeos.map(linea),
    avisos: chequeos.filter((x) => x.status === "degraded").map(nombrar),
    errores,
  };
}
