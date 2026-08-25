/**
 * `pnpm ensayo-tenencia` — ensayar la tenencia por base en una rama descartable.
 *
 * Lo que se ensaya no es la migración: es el CAMBIO DE ROL, que es la parte que
 * puede romper producción. Si al rol nuevo le falta un permiso, las consultas
 * empiezan a fallar; y eso hay que descubrirlo en una rama y no en vivo.
 *
 * Hace, en orden, y limpia todo al final:
 *
 *   1. Crea una rama de Neon a partir de producción (datos incluidos).
 *   2. Aplica la migración 0018 (políticas faltantes + FORCE RLS).
 *   3. Crea el rol de aplicación, sin BYPASSRLS, con los permisos justos.
 *   4. Siembra un caso de un SEGUNDO inquilino, para que la prueba cruzada
 *      tenga con qué cruzar. Sin esto, "no vi nada ajeno" no prueba nada.
 *   5. Corre la prueba de tenencia contra el rol nuevo.
 *   6. Borra la rama.
 *
 * Nada de esto toca producción. La rama es una copia y se destruye al final,
 * incluso si algo falla en el medio.
 *
 * Requiere NEON_API_KEY (consola de Neon → Account settings → API keys).
 *
 * Uso:
 *   pnpm ensayo-tenencia              crea, ensaya y borra
 *   pnpm ensayo-tenencia --conservar  deja la rama viva para mirarla a mano
 */
import * as dotenv from "dotenv";
dotenv.config({ path: ".env.local" });

import { readFileSync } from "node:fs";
import { randomBytes } from "node:crypto";
import { execFileSync } from "node:child_process";
import { Pool, neonConfig } from "@neondatabase/serverless";
import { splitSqlStatements } from "./lib/split-sql.mjs";

neonConfig.webSocketConstructor = globalThis.WebSocket as never;

const API = "https://console.neon.tech/api/v2";
const clave = process.env.NEON_API_KEY?.trim();
const urlProd = process.env.DATABASE_URL?.trim();
const conservar = process.argv.includes("--conservar");

if (!clave) {
  console.error("Falta NEON_API_KEY.");
  console.error("  Consola de Neon → Account settings → API keys → Create new API key");
  process.exit(2);
}
if (!urlProd) {
  console.error("Falta DATABASE_URL: hace falta para saber de qué proyecto sacar la rama.");
  process.exit(2);
}

const paso = (t: string) => console.log(`\n▸ ${t}`);
const ok = (t: string) => console.log(`   ✓ ${t}`);
const info = (t: string) => console.log(`     ${t}`);

async function neonApi<T>(ruta: string, init?: RequestInit): Promise<T> {
  const r = await fetch(`${API}${ruta}`, {
    ...init,
    headers: {
      Authorization: `Bearer ${clave}`,
      "Content-Type": "application/json",
      ...(init?.headers ?? {}),
    },
  });
  if (!r.ok) {
    const cuerpo = await r.text();
    throw new Error(`Neon ${r.status} en ${ruta}: ${cuerpo.slice(0, 200)}`);
  }
  return (await r.json()) as T;
}

// ── Qué proyecto es el nuestro ──────────────────────────────────────────────
//
// La cadena de conexión no lleva el id del proyecto, así que se busca por el
// host del endpoint. Si hubiera varios proyectos, esto elige el correcto en vez
// de "el primero", que sería la forma de tocar el proyecto equivocado.
paso("Buscando el proyecto en Neon");
const hostProd = new URL(urlProd.replace(/^postgres(ql)?:\/\//, "https://")).hostname;
const { projects } = await neonApi<{ projects: Array<{ id: string; name: string }> }>(
  "/projects"
);

let proyecto: { id: string; name: string } | undefined;
for (const p of projects) {
  const { endpoints } = await neonApi<{ endpoints: Array<{ host: string }> }>(
    `/projects/${p.id}/endpoints`
  );
  if (endpoints.some((e) => e.host === hostProd)) {
    proyecto = p;
    break;
  }
}
if (!proyecto) {
  console.error(`   ✗ ningún proyecto de esta cuenta tiene el endpoint ${hostProd}`);
  process.exit(2);
}
ok(`${proyecto.name} (${proyecto.id})`);

// ── La rama ─────────────────────────────────────────────────────────────────
const sufijo = randomBytes(3).toString("hex");
const nombreRama = `ensayo-tenencia-${sufijo}`;
let ramaId: string | null = null;

const borrarRama = async () => {
  if (!ramaId || conservar) return;
  try {
    await neonApi(`/projects/${proyecto!.id}/branches/${ramaId}`, { method: "DELETE" });
    console.log(`\n   rama ${nombreRama} borrada`);
  } catch (e) {
    console.error(`\n   ⚠ no se pudo borrar la rama ${nombreRama}: ${(e as Error).message}`);
    console.error(`     Borrala a mano en la consola de Neon.`);
  }
};

// Que un corte con Ctrl+C no deje ramas colgadas costando plata.
process.on("SIGINT", async () => {
  await borrarRama();
  process.exit(130);
});

let salida = 1;

try {
  paso(`Creando la rama ${nombreRama}`);
  const creada = await neonApi<{
    branch: { id: string };
    connection_uris: Array<{ connection_uri: string }>;
  }>(`/projects/${proyecto.id}/branches`, {
    method: "POST",
    body: JSON.stringify({
      branch: { name: nombreRama },
      endpoints: [{ type: "read_write" }],
    }),
  });
  ramaId = creada.branch.id;
  const urlRama = creada.connection_uris[0]?.connection_uri;
  if (!urlRama) throw new Error("Neon no devolvió cadena de conexión para la rama");
  ok(`rama viva, con una copia de los datos de producción`);

  const poolRama = new Pool({ connectionString: urlRama });
  const cx = await poolRama.connect();

  try {
    // ── La migración ────────────────────────────────────────────────────────
    paso("Aplicando 0018 (políticas faltantes + FORCE RLS)");
    const sqlMigracion = readFileSync("neon/migrations/0018_tenant_isolation_force_rls.sql", "utf8");
    for (const sentencia of splitSqlStatements(sqlMigracion)) {
      await cx.query(sentencia);
    }
    const cob = (
      await cx.query(`
        SELECT count(*) FILTER (WHERE c.relforcerowsecurity)::int AS forzadas,
               count(*)::int AS total
        FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
        WHERE n.nspname='public' AND c.relkind='r'
          AND EXISTS (SELECT 1 FROM information_schema.columns col
                      WHERE col.table_schema='public' AND col.table_name=c.relname
                        AND col.column_name='tenant_id')`)
    ).rows[0];
    ok(`${cob.forzadas} de ${cob.total} tablas con FORCE RLS`);

    // ── El rol ──────────────────────────────────────────────────────────────
    //
    // La contraseña se genera acá y no sale de esta corrida: la rama se borra
    // al final. Para producción se genera otra, y esa sí va a Vercel.
    paso("Creando el rol de aplicación (sin BYPASSRLS)");
    const passRol = randomBytes(24).toString("base64url");
    await cx.query(`DROP ROLE IF EXISTS claimmix_app`);
    await cx.query(
      `CREATE ROLE claimmix_app WITH LOGIN PASSWORD '${passRol}'
         NOSUPERUSER NOCREATEDB NOCREATEROLE NOBYPASSRLS`
    );
    await cx.query(`GRANT USAGE ON SCHEMA public TO claimmix_app`);
    await cx.query(
      `GRANT SELECT, INSERT, UPDATE, DELETE ON ALL TABLES IN SCHEMA public TO claimmix_app`
    );
    await cx.query(`GRANT USAGE, SELECT ON ALL SEQUENCES IN SCHEMA public TO claimmix_app`);
    await cx.query(`GRANT EXECUTE ON ALL FUNCTIONS IN SCHEMA public TO claimmix_app`);
    // Para que una tabla futura no nazca sin permisos y rompa en producción.
    await cx.query(
      `ALTER DEFAULT PRIVILEGES IN SCHEMA public
         GRANT SELECT, INSERT, UPDATE, DELETE ON TABLES TO claimmix_app`
    );
    await cx.query(
      `ALTER DEFAULT PRIVILEGES IN SCHEMA public
         GRANT USAGE, SELECT ON SEQUENCES TO claimmix_app`
    );
    ok("claimmix_app creado, con permisos sobre el esquema public");

    // ── El segundo inquilino, para que la prueba pruebe algo ────────────────
    paso("Sembrando un caso de un segundo inquilino");
    const inquilinos = (
      await cx.query(`SELECT id::text AS id, name FROM tenants ORDER BY created_at LIMIT 2`)
    ).rows;
    if (inquilinos.length < 2) {
      info("hay un solo inquilino: la prueba cruzada va a quedar no concluyente");
    } else {
      const b = inquilinos[1];
      const yaTiene = (
        await cx.query(`SELECT count(*)::int AS n FROM cases WHERE tenant_id = $1`, [b.id])
      ).rows[0].n as number;
      if (yaTiene > 0) {
        ok(`"${b.name}" ya tiene ${yaTiene} caso(s)`);
      } else {
        await cx.query(
          `INSERT INTO cases (tenant_id, status, channel, policyholder_name)
           VALUES ($1, 'nuevo', 'email', 'Asegurado del segundo inquilino')`,
          [b.id]
        );
        ok(`caso sembrado para "${b.name}" (sólo en la rama)`);
      }
    }

    // ── La prueba, contra el rol nuevo ──────────────────────────────────────
    const urlRol = new URL(urlRama.replace(/^postgres(ql)?:\/\//, "https://"));
    urlRol.username = "claimmix_app";
    urlRol.password = passRol;
    const urlRolFinal = urlRol.toString().replace(/^https:\/\//, "postgresql://");

    paso("Probando la tenencia con el rol nuevo");
    console.log("");
    try {
      execFileSync(
        "npx",
        ["tsx", "--tsconfig", "tsconfig.rehearsal.json", "scripts/prove-tenancy.mts", "--url", urlRolFinal],
        { stdio: "inherit", shell: process.platform === "win32" }
      );
      salida = 0;
    } catch {
      salida = 1;
    }
  } finally {
    cx.release();
    await poolRama.end();
  }
} catch (e) {
  console.error(`\n✗ ${(e as Error).message}`);
  salida = 2;
} finally {
  await borrarRama();
  if (conservar && ramaId) {
    console.log(`\n   rama ${nombreRama} CONSERVADA (--conservar). Borrala cuando termines.`);
  }
}

console.log("\n" + "─".repeat(70));
console.log(
  salida === 0
    ? "✓ El ensayo pasó. El rol nuevo aísla, y la app puede empezar a usarlo."
    : "✗ El ensayo NO pasó. No tocar producción hasta entender por qué."
);
process.exit(salida);
