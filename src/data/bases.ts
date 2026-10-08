/**
 * Qué base le toca a cada inquilino.
 *
 * Con `BASE_POR_CLIENTE=1` cada aseguradora vive en su propia base,
 * `t_<32 hex del tenant_id>`, en el mismo proyecto y el mismo compute que la de
 * control (`neondb`). El nombre sale del id, sin consultar nada: elegir la base
 * no suma un viaje a la red.
 *
 * Esto no lee `DATABASE_URL` ni `DATABASE_URL_APP`. Sólo arma nombres y cadenas;
 * de dónde sale la cadena de partida lo decide `scope.ts`. Vive aparte y sin
 * imports para que los scripts de bases y sus tests lo usen sin arrastrar el
 * guardia de `server-only` ni el driver.
 */

/** El inquilino que no existe: login, recuperar y las sondas lo usan de relleno. */
export const CENTINELA = "00000000-0000-0000-0000-000000000000";

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/**
 * ¿Está prendida la base por cliente?
 *
 * Apagada por omisión: hay una sola cadena y todo anda como siempre. Es de ida:
 * con clientes vivos se prende y no se apaga, porque control no tiene sus datos
 * de negocio.
 */
export function basePorCliente(): boolean {
  return process.env.BASE_POR_CLIENTE === "1";
}

/**
 * El nombre de la base de un inquilino: `t_` y los 32 hex de su id, en minúscula.
 *
 * Tira con algo que no sea un uuid, y lo hace antes de cualquier SQL: el nombre
 * termina en un `CREATE DATABASE` y en una cadena de conexión, y no se arma con
 * texto que no se haya comprobado.
 */
export function nombreDeBase(tenantId: string): string {
  if (typeof tenantId !== "string" || !UUID.test(tenantId)) {
    throw new Error("[bases] el id del inquilino no es un uuid: no se arma el nombre de su base.");
  }
  return `t_${tenantId.replaceAll("-", "").toLowerCase()}`;
}

/**
 * La base del inquilino, o `null` si le toca la de control.
 *
 * Control es: la bandera apagada, ningún inquilino, o el centinela. Con
 * `BASE_POR_CLIENTE=1` y un id que no es uuid tira, en vez de mandar la consulta
 * a otra parte.
 */
export function baseDelInquilino(tenantId: string | null | undefined): string | null {
  if (!basePorCliente() || !tenantId || tenantId === CENTINELA) return null;
  return nombreDeBase(tenantId);
}

/** La misma cadena de conexión, apuntando a otra base: sólo cambia el pathname. */
export function cadenaConBase(cadena: string, base: string): string {
  const url = new URL(cadena);
  url.pathname = `/${base}`;
  return url.toString();
}

/**
 * ¿Postgres dice que la base no existe? (3D000, `invalid_catalog_name`)
 *
 * El driver HTTP de Neon pone el código en el error; drizzle a veces lo envuelve
 * y queda en `cause`.
 */
export function esBaseInexistente(e: unknown): boolean {
  const err = e as { code?: unknown; cause?: { code?: unknown } } | null | undefined;
  return (err?.code ?? err?.cause?.code) === "3D000";
}
