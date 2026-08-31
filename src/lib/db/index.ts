import { neon } from "@neondatabase/serverless";
import { drizzle } from "drizzle-orm/neon-http";
import * as schema from "./schema";

function createDb(connectionString: string) {
  return drizzle(neon(connectionString), { schema });
}

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
 * En desarrollo, decir a qué base se conectó. Una vez, y sin la contraseña.
 *
 * `next dev` lee `.env.local`, donde vive la cadena de PRODUCCIÓN, y eso está
 * bien: es un proyecto con un solo ambiente desplegado. Lo que no está bien es
 * que no se note. Un `pnpm dev` olvidado corriendo tres días contra la base de
 * los clientes se ve igual que uno contra el ensayo — la pantalla es la misma.
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

  console.info(`[db] desarrollo → ${host}`);
}

export const db = new Proxy({} as Db, {
  get(_target, prop, receiver) {
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
