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
  }

  return cachedDb;
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
