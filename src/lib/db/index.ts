import { neon } from "@neondatabase/serverless";
import { drizzle } from "drizzle-orm/neon-http";
import * as schema from "./schema";

const connectionString = process.env.DATABASE_URL?.trim();
if (!connectionString) throw new Error("DATABASE_URL is not set");

export const db = drizzle(neon(connectionString), { schema });
export type Db = typeof db;
export * as tables from "./schema";
