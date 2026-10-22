import { neon } from "@neondatabase/serverless";
import { createTableRelationsHelpers, extractTablesRelationalConfig } from "drizzle-orm";
import { drizzle } from "drizzle-orm/neon-http";
import * as schema from "./schema";
import { cadenaConBase } from "@/data/bases";
import { logger } from "@/lib/observability/logger";

function createDb(connectionString: string) {
  return drizzle(neon(connectionString), { schema });
}

const relacional = extractTablesRelationalConfig(schema, createTableRelationsHelpers);
/*
 * `_` se contesta sin conectar.
 *
 * El adapter de Drizzle de Better Auth lee `db._.schema` y `db._.fullSchema` al
 * construirse, o sea al cargar el módulo de auth — también durante `next build`,
 * donde no hay DATABASE_URL. Son metadatos del esquema, no una conexión, así que
 * se devuelven tal cual los arma Drizzle (misma forma que `PgDatabase._`, sin la
 * sesión). Todo lo demás sigue conectando recién cuando alguien consulta.
 */
const meta = { schema: relacional.tables, fullSchema: schema, tableNamesMap: relacional.tableNamesMap };

export type Db = ReturnType<typeof createDb>;

let cachedConnectionString: string | null = null;
let cachedDb: Db | null = null;

export function getDb(): Db {
  const connectionString = process.env.DATABASE_URL?.trim();
  if (!connectionString) throw new Error("DATABASE_URL is not set");

  if (!cachedDb || cachedConnectionString !== connectionString) {
    cachedConnectionString = connectionString;
    cachedDb = createDb(connectionString);
    avisarAQueBaseEnDesarrollo(connectionString);
  }

  return cachedDb;
}

/**
 * Decir a qué base se conectó. Una vez, sin la contraseña, y nunca en producción.
 *
 * `next dev` lee `.env.local`, que es de dev: dev, QA y prd tienen cada uno su
 * base, y la cadena de prd va sólo en `.env.prd.local`. Este aviso es para notar
 * si alguien apuntó a otra base. Un `pnpm dev` olvidado corriendo tres días contra
 * la base de los clientes se ve igual que uno contra el ensayo — la pantalla es la misma.
 *
 * Ya pasó de la otra punta: los e2e escribían en la base real porque heredaban
 * `DATABASE_URL` de `.env.local`, y se descubrió por un login que fallaba, no
 * porque algo lo dijera. Se arregló pasándole la cadena a mano a Playwright;
 * esto cierra la mitad que quedaba, que es saber a qué le está hablando el
 * servidor que uno tiene abierto.
 *
 * Sólo el host: la contraseña va en la misma cadena y no tiene por qué aparecer
 * en una terminal, un log de CI, ni una captura de pantalla.
 */
function avisarAQueBaseEnDesarrollo(connectionString: string): void {
  if (process.env.NODE_ENV === "production") return;
  // En los tests sería una línea por archivo y no le sirve a nadie.
  if (process.env.NODE_ENV === "test" || process.env.VITEST) return;

  let host = "(no se pudo leer el host)";
  try {
    host = new URL(connectionString.replace(/^postgres(ql)?:/, "https:")).host;
  } catch {
    // Una cadena que el driver tampoco va a poder usar: que falle él, con su
    // mensaje, y no acá con uno peor.
  }

  /*
   * Dice «conectando a», no «desarrollo».
   *
   * Esta línea sale en todo lo que no sea una compilación de producción, y eso
   * incluye el ensayo de conversaciones que corre en CI contra una base real.
   * Llamarle «desarrollo» ahí era falso justo donde más importa saber a qué base
   * se le está escribiendo.
   */
  logger.info({ host }, "db.conectando");
}

export const db = new Proxy({} as Db, {
  get(_target, prop, receiver) {
    if (prop === "_") return meta;
    const instance = getDb();
    const value = Reflect.get(instance as object, prop, receiver);
    return typeof value === "function" ? value.bind(instance) : value;
  },
  has(_target, prop) {
    return prop in getDb();
  },
  ownKeys() {
    return Reflect.ownKeys(getDb() as object);
  },
  getOwnPropertyDescriptor(_target, prop) {
    const descriptor = Reflect.getOwnPropertyDescriptor(getDb() as object, prop);
    return descriptor ? { ...descriptor, configurable: true } : undefined;
  },
}) as Db;
export * as tables from "./schema";

export type DbDueno = typeof db;

const NOMBRE_DE_BASE = /^t_[0-9a-f]{32}$/;
const MAX_BASES = 50;

// Por cadena de conexión y no por nombre: si DATABASE_URL cambia, no sirve la vieja.
const basesPorCadena = new Map<string, DbDueno>();

/**
 * El rol dueño contra la base de un inquilino (`t_<32 hex>`), para quien no tiene
 * un pedido de usuario: el workflow que la prepara, los barridos y los scripts.
 * Lo del usuario va por `cliente(tenantId)`, con el rol restringido.
 *
 * Valida el nombre antes de armar la cadena, y guarda hasta 50 clientes: pasado
 * el tope se tira el más viejo. Un nombre que no existe en el clúster falla al
 * consultar (3D000), no acá.
 */
export function dbDeBase(base: string): DbDueno {
  if (typeof base !== "string" || !NOMBRE_DE_BASE.test(base)) {
    throw new Error("[db] el nombre de la base no es t_ y 32 hex: no se arma la cadena.");
  }
  const connectionString = process.env.DATABASE_URL?.trim();
  if (!connectionString) throw new Error("DATABASE_URL is not set");

  const cadena = cadenaConBase(connectionString, base);
  let cliente = basesPorCadena.get(cadena);
  if (!cliente) {
    if (basesPorCadena.size >= MAX_BASES) {
      const masVieja = basesPorCadena.keys().next().value;
      if (masVieja !== undefined) basesPorCadena.delete(masVieja);
    }
    cliente = createDb(cadena);
    basesPorCadena.set(cadena, cliente);
  }
  return cliente;
}
