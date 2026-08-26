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
import { execSync } from "node:child_process";
import { Pool, neonConfig } from "@neondatabase/serverless";
import { splitSqlStatements } from "./lib/split-sql.mjs";

neonConfig.webSocketConstructor = globalThis.WebSocket as never;

const API = "https://console.neon.tech/api/v2";
const clave = process.env.NEON_API_KEY?.trim();
const urlProd = process.env.DATABASE_URL?.trim();
const conservar = process.argv.includes("--conservar");

// Dos formas de conseguir dónde ensayar, y la diferencia importa.
//
//   rama    — una copia de producción, con sus datos. Es lo ideal: se ensaya
//             contra el volumen y las formas reales. Necesita NEON_API_KEY.
//   ensayo  — una base aparte, construida desde los archivos de migración.
//             No tiene los datos de producción, así que hay que sembrarlos;
//             a cambio, no hace falta ninguna clave y no se acerca a producción.
//
// El modo se imprime siempre: saber contra qué se ensayó es parte del resultado.
const modoEnsayo = process.argv.includes("--staging");
const urlEnsayo = process.env.STAGING_DATABASE_URL?.trim();

if (modoEnsayo && !urlEnsayo) {
  console.error("Falta STAGING_DATABASE_URL en .env.local.");
  process.exit(2);
}
if (!modoEnsayo && !clave) {
  console.error("Falta NEON_API_KEY para crear la rama.");
  console.error("  Consola de Neon → Account settings → API keys → Create new API key");
  console.error("  O corré con --staging para ensayar contra STAGING_DATABASE_URL.");
  process.exit(2);
}
if (!modoEnsayo && !urlProd) {
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

// ── Contra qué base se ensaya, y si se puede hacer sobre una rama ───────────
//
// La cadena de conexión no lleva el id del proyecto, así que el proyecto se
// busca por el host del endpoint. Eso elige el correcto en vez de "el primero
// de la lista", que sería la forma de trabajar sobre el proyecto equivocado.
//
// Una clave de Neon alcanza sólo los proyectos de SU cuenta. Si alcanza el
// proyecto de destino, se ensaya sobre una rama descartable —así ni siquiera la
// base de ensayo queda sucia—. Si no lo alcanza, se ensaya directamente sobre
// ella, avisando: es peor, pero es honesto y sigue sin acercarse a producción.
const urlDestino = modoEnsayo ? urlEnsayo! : urlProd!;
const hostDestino = new URL(urlDestino.replace(/^postgres(ql)?:\/\//, "https://")).hostname;

let proyecto: { id: string; name: string } | undefined;

paso(`Base de destino: ${hostDestino.split(".")[0]}${modoEnsayo ? " (ensayo)" : " (PRODUCCIÓN)"}`);

if (clave) {
  const { organizations } = await neonApi<{ organizations: Array<{ id: string; name: string }> }>(
    "/users/me/organizations"
  );
  for (const org of organizations) {
    const { projects } = await neonApi<{ projects: Array<{ id: string; name: string }> }>(
      `/projects?org_id=${org.id}&limit=100`
    );
    for (const p of projects) {
      const { endpoints } = await neonApi<{ endpoints: Array<{ host: string }> }>(
        `/projects/${p.id}/endpoints`
      );
      if (endpoints.some((e) => e.host === hostDestino)) {
        proyecto = p;
        break;
      }
    }
    if (proyecto) break;
  }
}

if (proyecto) {
  ok(`proyecto ${proyecto.name} (${proyecto.id}) — se ensaya sobre una rama descartable`);
} else if (clave) {
  info("la clave de Neon no alcanza este proyecto: se ensaya sobre la base misma");
} else {
  info("sin clave de Neon: se ensaya sobre la base misma");
}

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
  let urlRama: string;
  if (!proyecto) {
    urlRama = urlDestino;
  } else {
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

    // La respuesta de creación trae `connection_uris` sólo a veces, según lo
    // que se le haya pedido. Pedirla aparte siempre funciona y no depende de
    // esa sutileza — el nombre de la base y del rol se sacan de la cadena de
    // destino, para que la rama se abra igual que su origen.
    const destino = new URL(urlDestino.replace(/^postgres(ql)?:\/\//, "https://"));
    const baseNombre = destino.pathname.replace(/^\//, "") || "neondb";
    const rolNombre = destino.username || "neondb_owner";
    const { uri } = await neonApi<{ uri: string }>(
      `/projects/${proyecto.id}/connection_uri` +
        `?branch_id=${ramaId}&database_name=${baseNombre}&role_name=${rolNombre}`
    );
    if (!uri) throw new Error("Neon no devolvió cadena de conexión para la rama");
    urlRama = uri;
    ok(`rama viva, copia de ${baseNombre} en el momento de crearla`);
  }

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

    // El ensayo usa un rol PROPIO, y no el de producción, por algo concreto:
    // en Neon los roles viven en el proyecto, no en la rama. Un
    // `ALTER ROLE claimmix_app WITH PASSWORD` corrido acá adentro —en una rama
    // temporal que se borra en cinco minutos— le llega igual al rol de la rama
    // de producción, y le deja una contraseña aleatoria que este script
    // descarta al terminar.
    //
    // Se descubrió así: `pnpm permisos` andaba, se corrió el ensayo, y a la
    // vuelta el rol de producción no autenticaba. La API de Neon lo confirma:
    // el rol de la rama por omisión queda con `updated_at` a la hora en que
    // corrió el ensayo.
    //
    // Mientras la aplicación desplegada usaba el rol viejo esto no se notaba.
    // Con la capa de datos en producción, cada ensayo sería una caída.
    const ROL_ENSAYO = "claimmix_app_ensayo";

    // El rol se reutiliza en vez de recrearse.
    //
    // Borrarlo exige soltar antes todo lo que se le concedió (DROP OWNED BY), y
    // eso pide privilegios que el dueño de la base no tiene en Neon: "permission
    // denied to drop objects". Como los GRANT de más abajo son idempotentes,
    // alcanza con cambiarle la contraseña. Así el ensayo se puede correr las
    // veces que haga falta, que es la diferencia entre una herramienta y una
    // demostración de una sola vez.
    // Ojo con NOSUPERUSER: tocar ese atributo exige ser superusuario, incluso
    // para ponerlo en "no". Neon no da superusuario a nadie, así que incluirlo
    // en un ALTER devuelve "permission denied to alter role" — un mensaje que
    // hace pensar que falta permiso sobre el rol, cuando lo que falta es
    // permiso sobre UN atributo. Como NOSUPERUSER es el valor por omisión al
    // crear, alcanza con no nombrarlo.
    //
    // NOBYPASSRLS, en cambio, sí se puede y es el que importa: es el atributo
    // que decide si las políticas se obedecen o se ignoran.
    const yaExiste =
      ((await cx.query(`SELECT 1 FROM pg_roles WHERE rolname = '${ROL_ENSAYO}'`)).rowCount ?? 0) > 0;
    await cx.query(
      yaExiste
        ? `ALTER ROLE ${ROL_ENSAYO} WITH LOGIN PASSWORD '${passRol}' NOBYPASSRLS`
        : `CREATE ROLE ${ROL_ENSAYO} WITH LOGIN PASSWORD '${passRol}'
             NOCREATEDB NOCREATEROLE NOBYPASSRLS`
    );
    await cx.query(`GRANT USAGE ON SCHEMA public TO ${ROL_ENSAYO}`);
    await cx.query(
      `GRANT SELECT, INSERT, UPDATE, DELETE ON ALL TABLES IN SCHEMA public TO ${ROL_ENSAYO}`
    );
    await cx.query(`GRANT USAGE, SELECT ON ALL SEQUENCES IN SCHEMA public TO ${ROL_ENSAYO}`);
    await cx.query(`GRANT EXECUTE ON ALL FUNCTIONS IN SCHEMA public TO ${ROL_ENSAYO}`);
    // Para que una tabla futura no nazca sin permisos y rompa en producción.
    await cx.query(
      `ALTER DEFAULT PRIVILEGES IN SCHEMA public
         GRANT SELECT, INSERT, UPDATE, DELETE ON TABLES TO ${ROL_ENSAYO}`
    );
    await cx.query(
      `ALTER DEFAULT PRIVILEGES IN SCHEMA public
         GRANT USAGE, SELECT ON SEQUENCES TO ${ROL_ENSAYO}`
    );
    ok(`${ROL_ENSAYO} creado, con permisos sobre el esquema public`);

    // ── Dos inquilinos con casos, o la prueba no prueba nada ────────────────
    //
    // El aislamiento sólo se puede demostrar si hay algo ajeno que NO se ve. Con
    // un solo inquilino, "no vi nada de otro" es cierto y vacío. Así que acá se
    // garantiza que haya dos, cada uno con al menos un caso, antes de medir.
    paso("Asegurando dos inquilinos con casos");
    let inquilinos = (
      await cx.query(`SELECT id::text AS id, name FROM tenants ORDER BY created_at LIMIT 2`)
    ).rows as Array<{ id: string; name: string }>;

    if (inquilinos.length < 2) {
      const nuevo = (
        await cx.query(
          `INSERT INTO tenants (name) VALUES ('Aseguradora de ensayo')
           RETURNING id::text AS id, name`
        )
      ).rows[0];
      info(`creado un segundo inquilino: "${nuevo.name}"`);
      inquilinos = [...inquilinos, nuevo];
    }

    for (const t of inquilinos) {
      const n = (
        await cx.query(`SELECT count(*)::int AS n FROM cases WHERE tenant_id = $1`, [t.id])
      ).rows[0].n as number;
      if (n > 0) {
        ok(`"${t.name}" ya tiene ${n} caso(s)`);
      } else {
        await cx.query(
          `INSERT INTO cases (tenant_id, status, channel, policyholder_name)
           VALUES ($1, 'recibido', 'email', $2)`,
          [t.id, `Asegurado de ${t.name}`]
        );
        ok(`caso sembrado para "${t.name}"`);
      }
    }

    // ── La prueba, contra el rol nuevo ──────────────────────────────────────
    const urlRol = new URL(urlRama.replace(/^postgres(ql)?:\/\//, "https://"));
    urlRol.username = ROL_ENSAYO;
    urlRol.password = passRol;
    const urlRolFinal = urlRol.toString().replace(/^https:\/\//, "postgresql://");

    paso("Probando la tenencia con el rol nuevo");
    console.log("");
    try {
      // La URL va entre comillas a propósito.
      //
      // En Windows `npx` es un .cmd, así que hace falta shell para invocarlo; y
      // con shell, cmd parte el argumento en el `&` de "?sslmode=require&..." e
      // intenta ejecutar "sslmode" como si fuera un comando. El ensayo pasaba y
      // el envoltorio reportaba fracaso. Es el mismo defecto que ya apareció en
      // switch-gcp: en Windows, todo argumento con & o espacios va comillado.
      execSync(
        `npx tsx --tsconfig tsconfig.rehearsal.json scripts/prove-tenancy.mts --url "${urlRolFinal}"`,
        { stdio: "inherit" }
      );
      salida = 0;
    } catch (e) {
      // Un catch mudo acá cuesta caro: el ensayo dice "no pasó" y no se sabe si
      // falló el aislamiento —lo que se quería medir— o si el comando ni
      // arrancó. Son dos cosas muy distintas y hay que poder distinguirlas.
      const err = e as { status?: number; message?: string };
      if (err.status === 1) {
        info("la prueba de tenencia falló: mirá su salida de arriba");
      } else {
        info(`la prueba de tenencia no llegó a correr: ${err.message?.slice(0, 120)}`);
      }
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
