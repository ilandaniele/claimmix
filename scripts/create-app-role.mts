/**
 * `pnpm rol-app` — crear el rol con el que la aplicación va a conectarse.
 *
 * Un rol sin BYPASSRLS y sin ser dueño de las tablas. Es la pieza que hace que
 * las políticas de RLS se obedezcan: mientras la app se conecte como
 * `neondb_owner`, las 29 políticas y el FORCE de la migración 0018 son adorno.
 *
 * **Crear el rol no cambia nada.** Nadie lo usa hasta que alguien apunte
 * DATABASE_URL hacia él, y eso es un paso aparte y deliberado. Por eso este
 * script no toca ninguna variable de entorno: crea, concede, verifica e
 * informa. Es aditivo y reversible.
 *
 * **`DATABASE_URL` se queda como está, apuntando al dueño.** No es un paso
 *   pendiente: son dos roles a propósito. El dueño corre las migraciones, el
 *   limitador de tráfico y las sondas de infraestructura; `claimmix_app` corre
 *   todo lo demás, a través de la capa de datos. Lo que sí hay que actualizar al
 *   rotar es `DATABASE_URL_APP`, en `.env.local` y en Vercel.
 *
 * Al final mide cuántas filas ve el rol sin poner contexto. Cero es lo
 * correcto: significa que RLS lo está filtrando. Cualquier otro número es una
 * fuga y lo dice.
 *
 * Uso:
 *   pnpm rol-app                      contra DATABASE_URL
 *   pnpm rol-app --env STAGING_DATABASE_URL
 *   pnpm rol-app --rotar              genera contraseña nueva para un rol que ya existe
 */
import * as dotenv from "dotenv";
dotenv.config({ path: ".env.local" });

import { randomBytes } from "node:crypto";
import { Pool, neonConfig } from "@neondatabase/serverless";

neonConfig.webSocketConstructor = globalThis.WebSocket as never;

const ROL = "claimmix_app";
const envIdx = process.argv.indexOf("--env");
const VAR = envIdx !== -1 ? process.argv[envIdx + 1] : "DATABASE_URL";
const rotar = process.argv.includes("--rotar");
const url = process.env[VAR]?.trim();

if (!url) {
  console.error(`Falta ${VAR} en .env.local`);
  process.exit(2);
}

const paso = (t: string) => console.log(`\n▸ ${t}`);
const ok = (t: string) => console.log(`   ✓ ${t}`);
const aviso = (t: string) => console.log(`   ⚠ ${t}`);

const pool = new Pool({ connectionString: url });
const cx = await pool.connect();

try {
  const host = new URL(url.replace(/^postgres(ql)?:\/\//, "https://")).hostname;
  console.log("═".repeat(70));
  console.log(`ROL DE APLICACIÓN — sobre ${VAR} (${host.split(".")[0]})`);
  console.log("═".repeat(70));

  // ── El rol ────────────────────────────────────────────────────────────────
  paso(`Rol ${ROL}`);
  const existe =
    ((await cx.query(`SELECT 1 FROM pg_roles WHERE rolname = $1`, [ROL])).rowCount ?? 0) > 0;

  let pass: string | null = null;
  if (!existe) {
    pass = randomBytes(24).toString("base64url");
    // NOSUPERUSER no se nombra a propósito: tocar ese atributo exige ser
    // superusuario, y es el valor por omisión al crear igual.
    await cx.query(
      `CREATE ROLE ${ROL} WITH LOGIN PASSWORD '${pass}' NOCREATEDB NOCREATEROLE NOBYPASSRLS`
    );
    ok("creado");
  } else if (rotar) {
    pass = randomBytes(24).toString("base64url");
    await cx.query(`ALTER ROLE ${ROL} WITH LOGIN PASSWORD '${pass}' NOBYPASSRLS`);
    ok("ya existía — contraseña rotada");
  } else {
    ok("ya existía — se dejan los permisos al día (--rotar para cambiar la contraseña)");
  }

  // ── Los permisos ──────────────────────────────────────────────────────────
  //
  // Idempotentes: se pueden volver a conceder las veces que haga falta. Los
  // "default privileges" son los que evitan que una tabla creada mañana nazca
  // sin permisos y rompa producción sin que nadie relacione una cosa con la otra.
  paso("Permisos sobre el esquema public");
  for (const sql of [
    `GRANT USAGE ON SCHEMA public TO ${ROL}`,
    `GRANT SELECT, INSERT, UPDATE, DELETE ON ALL TABLES IN SCHEMA public TO ${ROL}`,
    `GRANT USAGE, SELECT ON ALL SEQUENCES IN SCHEMA public TO ${ROL}`,
    `GRANT EXECUTE ON ALL FUNCTIONS IN SCHEMA public TO ${ROL}`,
    `ALTER DEFAULT PRIVILEGES IN SCHEMA public GRANT SELECT, INSERT, UPDATE, DELETE ON TABLES TO ${ROL}`,
    `ALTER DEFAULT PRIVILEGES IN SCHEMA public GRANT USAGE, SELECT ON SEQUENCES TO ${ROL}`,
    `ALTER DEFAULT PRIVILEGES IN SCHEMA public GRANT EXECUTE ON FUNCTIONS TO ${ROL}`,
  ]) {
    await cx.query(sql);
  }
  ok("lectura, escritura, secuencias y funciones — más los permisos por omisión");

  // ── Comprobación de atributos ─────────────────────────────────────────────
  paso("Comprobación");
  const r = (
    await cx.query(
      `SELECT rolbypassrls, rolsuper, rolcanlogin FROM pg_roles WHERE rolname = $1`,
      [ROL]
    )
  ).rows[0];
  if (r.rolbypassrls || r.rolsuper) {
    aviso("el rol saltea RLS: no sirve para lo que queremos");
    process.exit(1);
  }
  ok(`sin BYPASSRLS, sin SUPERUSER, puede iniciar sesión: ${r.rolcanlogin}`);

  // ── Lo que rompería si se cambiara DATABASE_URL hoy ───────────────────────
  //
  // Esta es la parte que importa. Con el rol nuevo, una consulta como las que
  // hace la app —sin poner el contexto— no devuelve nada. No es un riesgo
  // teórico: es el número que sale acá abajo.
  paso("Qué pasaría si la app se conectara con este rol HOY");
  if (pass) {
    const urlRol = new URL(url.replace(/^postgres(ql)?:\/\//, "https://"));
    urlRol.username = ROL;
    urlRol.password = pass;
    const urlFinal = urlRol.toString().replace(/^https:\/\//, "postgresql://");

    const p2 = new Pool({ connectionString: urlFinal });
    try {
      const conRol = await p2.query(`SELECT count(*)::int AS n FROM cases`);
      const conDuenio = await cx.query(`SELECT count(*)::int AS n FROM cases`);
      console.log(`     como ${ROL}:      ${conRol.rows[0].n} caso(s)`);
      console.log(`     como el dueño:      ${conDuenio.rows[0].n} caso(s)`);
      if (conRol.rows[0].n === 0 && conDuenio.rows[0].n > 0) {
        // Cero sin contexto es lo CORRECTO, no una alarma.
        //
        // Este aviso decía "la app quedaría ciega" y era cierto cuando se
        // escribió: no había un solo `set_config` en `src/`. Ahora existe la
        // capa de datos y toda consulta pone el contexto antes de leer, así que
        // ver cero acá significa que RLS está haciendo su trabajo. Dejarlo como
        // advertencia mandaba a la gente a "arreglar" lo único que estaba bien.
        ok(
          `0 sin contexto y ${conDuenio.rows[0].n} con el dueño: ` +
            "RLS separa como corresponde"
        );
        console.log("       La capa pone el contexto en cada consulta; comprobalo");
        console.log("       de punta a punta con `pnpm capa-datos`.");
      } else if (conRol.rows[0].n > 0) {
        aviso("el rol ve casos sin poner contexto: revisar RLS antes de seguir");
      }
    } finally {
      await p2.end();
    }

    /*
     * La contraseña se ESCRIBE en el archivo, no se imprime.
     *
     * Imprimirla es exactamente cómo llegó al transcripto de una sesión de
     * trabajo, y de ahí a tener que rotarla de nuevo. Una credencial que
     * aparece en una pantalla termina en un registro, en una captura o en el
     * historial de una terminal, y no hay forma de saber en cuál de los tres.
     *
     * Va directo a `.env.local`, bajo el nombre que le corresponde según contra
     * qué base se corrió. Quien la necesite para otra cosa la lee de ahí; quien
     * mire esta salida se entera de que se rotó y no de cuál es.
     */
    const CLAVE = VAR === "DATABASE_URL" ? "DATABASE_URL_APP" : `${VAR}_APP`;
    const { readFileSync, writeFileSync, existsSync } = await import("node:fs");

    const archivo = ".env.local";
    let contenido = existsSync(archivo) ? readFileSync(archivo, "utf8") : "";
    const salto = contenido.includes("\r\n") ? "\r\n" : "\n";
    const patron = new RegExp(`^${CLAVE}=.*$`, "m");
    contenido = patron.test(contenido)
      ? contenido.replace(patron, `${CLAVE}=${urlFinal}`)
      : `${contenido.replace(/\s*$/, "")}${salto}${salto}${CLAVE}=${urlFinal}${salto}`;
    writeFileSync(archivo, contenido, "utf8");

    console.log("\n" + "─".repeat(70));
    console.log(`✓ ${CLAVE} actualizada en ${archivo}.`);
    console.log("");
    console.log("  No se imprime a propósito: una credencial en pantalla termina en un");
    console.log("  registro, una captura o el historial de la terminal, y no hay forma");
    console.log("  de saber en cuál de los tres.");
    console.log("");
    console.log("  ⚠ SI ESTA BASE LA USA UN DEPLOY VIVO, YA ESTÁ CAÍDO.");
    console.log("");
    console.log("    La aplicación desplegada tiene la contraseña anterior, y acaba de");
    console.log("    dejar de servir. No hay forma de evitar esa ventana: Postgres no");
    console.log("    admite dos contraseñas a la vez para el mismo rol.");
    console.log("");
    console.log("    El orden que la hace corta:");
    console.log("      1. rotar (esto)");
    console.log("      2. subir la variable a Vercel");
    console.log("      3. REDESPLEGAR — el deploy que corre no relee las variables");
    console.log("      4. mirar /api/health");
    console.log("");
    console.log("  Para llevarla a Vercel o a GitHub sin que pase por pantalla:");
    console.log(`    grep -oP '(?<=^${CLAVE}=).*' .env.local | tr -d '\\r\\n' | npx vercel env add ${CLAVE} production`);
    console.log(`    grep -oP '(?<=^${CLAVE}=).*' .env.local | tr -d '\\r\\n' | gh secret set ${CLAVE}`);
  } else {
    console.log("     (el rol ya existía y no se rotó: no tengo su contraseña para probar)");
    console.log("     Corré con --rotar si necesitás una cadena de conexión nueva.");
  }
} catch (e) {
  console.error(`\n✗ ${(e as Error).message.slice(0, 200)}`);
  process.exitCode = 2;
} finally {
  cx.release();
  await pool.end();
}
