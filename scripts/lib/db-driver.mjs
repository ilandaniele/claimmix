/**
 * Cómo hablarle a la base desde un script, por el camino que esté abierto.
 *
 * `pg` va por TCP al 5432, que es el camino bueno: transacciones interactivas
 * de verdad, un begin/commit alrededor de un archivo entero. Pero hay redes
 * donde ese puerto no sale —operadores que lo bloquean, oficinas con egress
 * filtrado— y desde ahí los scripts operativos no servían para nada mientras la
 * aplicación andaba perfecto: Neon también atiende SQL sobre HTTPS, y es por
 * ahí que se conecta la app.
 *
 * Si el 5432 no responde, entonces, se cae al camino HTTPS en vez de rendirse.
 * Sólo ante errores de red: cualquier otro error se propaga, que para eso está.
 *
 * Lo que cambia por HTTP es que las sentencias van juntas en una lista en vez
 * de una transacción interactiva, y armar esa lista obliga a partir el
 * archivo. Eso lo hace split-sql.mjs, que sabe dónde vive cada punto y coma:
 * partir por `;` a secas rompe al medio el primer `DO $ ... $` que aparezca
 * —la migración 0010 tiene uno— y media migración aplicada es peor que
 * ninguna.
 */
import pg from "pg";
import { neon } from "@neondatabase/serverless";
import { splitSqlStatements } from "./split-sql.mjs";

export const LEDGER_INSERT =
  "insert into schema_migrations (version, filename, checksum, applied_by) values ($1,$2,$3,$4)";

export async function connect(connectionString) {
  const client = new pg.Client({ connectionString, ssl: { rejectUnauthorized: false } });
  try {
    await client.connect();
    return tcpDriver(client);
  } catch (e) {
    const blocked = ["ETIMEDOUT", "ECONNREFUSED", "EHOSTUNREACH", "ENETUNREACH"];
    const codes = [e?.code, ...(e?.errors ?? []).map((x) => x?.code)];
    if (!codes.some((code) => blocked.includes(code))) throw e;
    console.log("· El puerto 5432 no responde; voy por el SQL sobre HTTPS de Neon.");
    return httpDriver(connectionString);
  }
}

function tcpDriver(client) {
  return {
    kind: "tcp",
    query: (text, params) => client.query(text, params),
    async applyMigration(m, appliedBy) {
      try {
        await client.query("begin");
        await client.query(m.sql);
        await client.query(LEDGER_INSERT, [m.version, m.filename, m.checksum, appliedBy]);
        await client.query("commit");
      } catch (e) {
        await client.query("rollback");
        throw e;
      }
    },
    end: () => client.end(),
  };
}

function httpDriver(connectionString) {
  const sql = neon(connectionString);
  return {
    kind: "http",
    query: async (text, params) => ({ rows: await sql.query(text, params ?? []) }),
    async applyMigration(m, appliedBy) {
      // El archivo entero, cortado sabiendo dónde vive cada punto y coma.
      const statements = splitSqlStatements(m.sql);

      if (statements.length === 0) {
        throw new Error(m.filename + " no tiene ninguna sentencia ejecutable");
      }
      await sql.transaction([
        ...statements.map((statement) => sql.query(statement)),
        sql.query(LEDGER_INSERT, [m.version, m.filename, m.checksum, appliedBy]),
      ]);
    },
    end: async () => {},
  };
}
