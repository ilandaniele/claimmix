/**
 * La única puerta a los datos de un inquilino.
 *
 * Hasta acá, lo único que separaba los siniestros de una aseguradora de los de
 * otra eran 198 cláusulas `WHERE tenant_id = ...` escritas a mano en 107
 * archivos. Ciento noventa y ocho oportunidades de olvidarse una, y una sola
 * alcanza para que una aseguradora vea los casos de otra.
 *
 * Acá el filtro deja de escribirse. Cada consulta viaja en un lote junto a un
 * `set_config('claimmix.tenant_id', …, true)`, y las políticas de RLS de la base
 * hacen el resto. La diferencia no es de estilo:
 *
 *   antes   olvidarse el WHERE devuelve los casos de todos, en silencio
 *   ahora   olvidarse el contexto no es posible —no hay forma de llamar a esto
 *           sin un TenantContext— y si igual pasara, la base devuelve cero
 *
 * Requiere tres cosas, y las tres están medidas (docs/FASE-0A-RESULTADOS.md):
 *
 *   1. Un rol sin BYPASSRLS. `neondb_owner` lo tiene y pasa por encima de toda
 *      política; por eso existe `claimmix_app` y por eso esta capa se conecta
 *      con DATABASE_URL_APP y no con DATABASE_URL.
 *   2. FORCE ROW LEVEL SECURITY en las tablas. Sin FORCE, el dueño de la tabla
 *      está exento de sus propias políticas.
 *   3. Que el contexto sobreviva de una sentencia a la siguiente. El driver HTTP
 *      de Neon no mantiene sesión —cada consulta es un POST— así que el contexto
 *      y la consulta tienen que viajar juntos, en un lote que es una sola
 *      transacción. Medido: cuesta 7 ms.
 *
 * `SET LOCAL` no sirve acá: no acepta parámetros en ninguna versión de Postgres.
 * `set_config(clave, $1, true)` es una función, sí los toma, y muere con la
 * transacción exactamente igual.
 */
import "server-only";
import { neon } from "@neondatabase/serverless";
import { drizzle } from "drizzle-orm/neon-http";
import { sql } from "drizzle-orm";
import * as schema from "@/lib/db/schema";

/**
 * De qué inquilino se trata, y quién pregunta.
 *
 * Se construye a partir de la sesión y nunca de algo que venga en un pedido:
 * un `tenantId` que llega por el cuerpo o por la URL es un pedido de fuga con
 * pasos extra. Es de sólo lectura para que nadie lo reescriba a mitad de camino.
 */
export type TenantContext = {
  readonly tenantId: string;
  readonly userId: string;
};

type ClienteDatos = ReturnType<typeof crearCliente>;

function crearCliente(connectionString: string) {
  return drizzle(neon(connectionString), { schema });
}

let cacheCliente: ClienteDatos | null = null;
let cacheCadena: string | null = null;

/**
 * El cliente con el que habla esta capa.
 *
 * Usa DATABASE_URL_APP —el rol restringido— y cae a DATABASE_URL sólo mientras
 * dure la transición, avisando. Ese aviso importa: con el rol viejo esta capa
 * *funciona igual*, porque las consultas son correctas de todos modos; lo que
 * se pierde es la defensa. Un fallback silencioso convertiría "estamos
 * protegidos" en una creencia en vez de un hecho.
 */
function cliente(): ClienteDatos {
  const app = process.env.DATABASE_URL_APP?.trim();
  const cadena = app || process.env.DATABASE_URL?.trim();

  if (!cadena) {
    throw new Error("[data] falta DATABASE_URL_APP (o DATABASE_URL) para acceder a los datos");
  }
  if (!app) {
    console.warn(
      "[data] DATABASE_URL_APP no está: se usa el rol viejo y el aislamiento por base NO está activo"
    );
  }

  if (!cacheCliente || cacheCadena !== cadena) {
    cacheCadena = cadena;
    cacheCliente = crearCliente(cadena);
  }
  return cacheCliente;
}

/** La sentencia que pone el contexto. Va primera en cada lote. */
function ponerContexto(db: ClienteDatos, tenantId: string) {
  return db.execute(sql`SELECT set_config('claimmix.tenant_id', ${tenantId}, true)`);
}

/**
 * Correr una consulta dentro del contexto del inquilino.
 *
 * Se le pasa una función que arma la consulta con drizzle, igual que se
 * escribiría suelta pero **sin el filtro por inquilino**: ese lo pone la base.
 *
 *   const casos = await enTenant(ctx, (db) =>
 *     db.select().from(tables.cases).where(eq(tables.cases.status, "cerrado"))
 *   );
 *
 * Un viaje de red, como una consulta suelta.
 */
export async function enTenant<T>(
  ctx: TenantContext,
  armar: (db: ClienteDatos) => Promise<T>
): Promise<T> {
  const db = cliente();
  // `batch` acepta las consultas ya armadas, no una promesa a la que esperar:
  // por eso la función de arriba se invoca sin await. Drizzle tipa `batch` con
  // tuplas, y expresar eso acá pelearía con la firma simple que hace que esto
  // valga la pena, así que el cast queda contenido en este único lugar.
  const consulta = armar(db) as unknown;
  const [, resultado] = (await (
    db as unknown as { batch: (q: unknown[]) => Promise<unknown[]> }
  ).batch([ponerContexto(db, ctx.tenantId), consulta])) as [unknown, T];
  return resultado;
}

/**
 * Varias consultas en el mismo contexto y en un solo viaje.
 *
 * Sirve para la pantalla que necesita tres cosas a la vez: en vez de tres
 * viajes con su contexto cada uno, uno solo.
 *
 *   const [casos, faltantes] = await enTenantVarias(ctx, (db) => [
 *     db.select().from(tables.cases),
 *     db.select().from(tables.missingDocs),
 *   ]);
 *
 * Lo que NO hace, y es a propósito: no permite leer, decidir y después escribir
 * según lo leído. El driver HTTP manda todo junto y no hay forma de mirar un
 * resultado intermedio. Para eso hace falta una transacción de verdad, que va
 * por WebSocket y se agrega cuando aparezca el primer caso que la necesite —
 * no antes.
 */
export async function enTenantVarias<T extends readonly unknown[]>(
  ctx: TenantContext,
  armar: (db: ClienteDatos) => { [K in keyof T]: Promise<T[K]> } | readonly unknown[]
): Promise<T> {
  const db = cliente();
  const consultas = armar(db) as readonly unknown[];
  const res = (await (
    db as unknown as { batch: (q: unknown[]) => Promise<unknown[]> }
  ).batch([ponerContexto(db, ctx.tenantId), ...consultas])) as unknown[];
  return res.slice(1) as unknown as T;
}
