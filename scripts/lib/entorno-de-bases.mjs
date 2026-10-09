/**
 * Las cadenas de conexión de un ambiente para los scripts de bases por cliente.
 *
 * Los scripts de bases crean, migran y borran bases: no pueden agarrar la
 * `DATABASE_URL` que haya en el entorno, que en una máquina de desarrollo es la
 * de dev. Cada ambiente tiene sus propias variables y su propio veto:
 *
 * - prd: `DATABASE_URL` y `DATABASE_URL_APP` de `.env.prd.local`, nunca del
 *   entorno del proceso.
 * - ensayo: `PRD_ENSAYO_DATABASE_URL` y `PRD_ENSAYO_DATABASE_URL_APP`, del
 *   entorno (CI) o de `.env.local`.
 *
 * Tira un Error con el motivo, sin la cadena: lleva la contraseña.
 */
import { leerDeEnvLocal } from "./env-local.mjs";
import { motivoDeVetoDeBases } from "./hosts-vetados.mjs";

const AMBIENTES = {
  prd: { archivo: "./.env.prd.local", dueno: "DATABASE_URL", app: "DATABASE_URL_APP", delEntorno: false },
  ensayo: {
    archivo: "./.env.local",
    dueno: "PRD_ENSAYO_DATABASE_URL",
    app: "PRD_ENSAYO_DATABASE_URL_APP",
    delEntorno: true,
  },
};

export const NOMBRE_DE_BASE = /^t_[0-9a-f]{32}$/;
export const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

/** El nombre de la base de un inquilino, igual que `nombreDeBase` de src/data/bases.ts. */
export function nombreDeBaseDe(tenantId) {
  if (!UUID.test(tenantId)) throw new Error(`"${tenantId}" no es un uuid en minúsculas`);
  return `t_${tenantId.replaceAll("-", "")}`;
}

/** La misma cadena apuntando a otra base: sólo cambia el pathname. */
export function cadenaConBase(cadena, base) {
  if (!NOMBRE_DE_BASE.test(base)) throw new Error(`"${base}" no es un nombre de base t_ y 32 hex`);
  const url = new URL(cadena);
  url.pathname = `/${base}`;
  return url.toString();
}

// `-pooler` es el mismo endpoint por otra puerta.
const endpointDe = (cadena) => new URL(cadena).hostname.split(".")[0].replace(/-pooler$/, "");

function valorDe(ambiente, nombre) {
  const { archivo, delEntorno } = AMBIENTES[ambiente];
  const delProceso = delEntorno ? process.env[nombre]?.trim() : undefined;
  if (delProceso) return delProceso;
  try {
    return leerDeEnvLocal(nombre, archivo) || undefined;
  } catch {
    // Sin archivo no hay valor; el que llama dice cuál faltó.
    return undefined;
  }
}

/**
 * @param {"prd" | "ensayo"} ambiente
 * @param {{ app?: boolean }} [opciones] `app: true` exige también la cadena de `claimmix_app`.
 * @returns {{ dueno: string, app: string | undefined }}
 */
export function cadenasDelEntorno(ambiente, { app = false } = {}) {
  const def = AMBIENTES[ambiente];
  if (!def) throw new Error(`--env espera prd o ensayo (recibí "${ambiente}")`);

  const dueno = valorDe(ambiente, def.dueno);
  if (!dueno) throw new Error(`falta ${def.dueno} (${def.delEntorno ? "en el entorno o " : ""}en ${def.archivo.slice(2)})`);
  const cadenaApp = valorDe(ambiente, def.app);
  if (app && !cadenaApp) throw new Error(`falta ${def.app} (${def.delEntorno ? "en el entorno o " : ""}en ${def.archivo.slice(2)})`);

  for (const [nombre, cadena] of [[def.dueno, dueno], ...(cadenaApp ? [[def.app, cadenaApp]] : [])]) {
    const motivo = motivoDeVetoDeBases(ambiente, cadena);
    if (motivo) throw new Error(`${nombre} no sirve para ${ambiente}: ${motivo}`);
  }
  if (cadenaApp && endpointDe(cadenaApp) !== endpointDe(dueno)) {
    throw new Error(`${def.dueno} y ${def.app} apuntan a endpoints distintos`);
  }
  return { dueno, app: cadenaApp };
}
