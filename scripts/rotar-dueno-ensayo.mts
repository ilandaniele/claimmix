/**
 * Rota la contraseña del rol dueño del ENSAYO.
 *
 * Quedó en el transcripto de una sesión de trabajo. Es la del ensayo, no la de
 * producción —eso se comprueba abajo y el script se planta si no— pero una
 * credencial expuesta se rota igual: la base del ensayo tiene el mismo esquema,
 * y desde ahí se aprende dónde está todo.
 *
 * **El orden importa y no es el obvio.** Primero se prueba la conexión nueva, y
 * recién después se guarda. Al revés, un error deja el archivo apuntando a una
 * contraseña que no funciona y el acceso perdido, sin nada a mano para volver.
 *
 * La contraseña no se imprime nunca. Va del generador al archivo.
 */
import * as dotenv from "dotenv";
dotenv.config({ path: ".env.local" });

import { randomBytes } from "node:crypto";
import { readFileSync, writeFileSync } from "node:fs";
import { Pool, neonConfig } from "@neondatabase/serverless";
neonConfig.webSocketConstructor = globalThis.WebSocket as never;

const actual = process.env.STAGING_DATABASE_URL?.trim().replace(/^"|"$/g, "");
const produccion = process.env.DATABASE_URL?.trim().replace(/^"|"$/g, "");

if (!actual) {
  console.error("Falta STAGING_DATABASE_URL.");
  process.exit(2);
}

/*
 * Que no sea producción, y no sólo por comparar las cadenas.
 *
 * Se compara el ENDPOINT. Dos cadenas distintas pueden apuntar al mismo lugar
 * —una por el pooler y otra directa— y ahí la comparación de texto dice que son
 * diferentes cuando la base es la misma.
 */
const host = (u: string) => /@([^/]+)/.exec(u)?.[1]?.replace("-pooler", "") ?? "";
if (produccion && host(actual) === host(produccion)) {
  console.error("✗ STAGING_DATABASE_URL apunta al mismo endpoint que producción.");
  console.error(`  ensayo:     ${host(actual)}`);
  console.error(`  producción: ${host(produccion)}`);
  console.error("  Rotar el dueño de producción desde acá sería dejar la app sin base.");
  process.exit(2);
}

console.log("═".repeat(66));
console.log("ROTAR — el rol dueño del ensayo");
console.log("═".repeat(66));
console.log(`\nEndpoint: ${host(actual)}`);
console.log(`(producción es ${produccion ? host(produccion) : "desconocido"}, y no se toca)`);

const usuario = /\/\/([^:]+):/.exec(actual)?.[1];
if (!usuario) {
  console.error("No pude leer el usuario de la cadena.");
  process.exit(2);
}

const nueva = randomBytes(24).toString("base64url");
const cadenaNueva = actual.replace(/(\/\/[^:]+:)[^@]*@/, `$1${nueva}@`);

const viejo = new Pool({ connectionString: actual });
const cx = await viejo.connect();
try {
  console.log(`\n▸ Rotando "${usuario}"`);
  await cx.query(`ALTER ROLE ${usuario} WITH PASSWORD '${nueva}'`);
  console.log("   ✓ cambiada en la base");
} finally {
  cx.release();
  await viejo.end();
}

// Se prueba ANTES de guardar. Si esto falla, el archivo sigue teniendo la
// anterior — que ya no sirve, pero al menos el error dice qué pasó en vez de
// dejar un archivo con algo que nunca funcionó.
console.log(`\n▸ Probando la conexión nueva`);
const nuevoPool = new Pool({ connectionString: cadenaNueva });
try {
  const cx2 = await nuevoPool.connect();
  const r = await cx2.query("select current_user::text as u, count(*)::int as n from tenants");
  console.log(`   ✓ entra como ${r.rows[0].u}, ve ${r.rows[0].n} inquilino(s)`);
  cx2.release();
} catch (e) {
  console.error(`   ✗ la conexión nueva NO funciona: ${(e as Error).message}`);
  console.error("     El archivo NO se tocó. La contraseña vieja tampoco sirve ya:");
  console.error("     hay que rotarla desde la consola de Neon.");
  process.exit(1);
} finally {
  await nuevoPool.end();
}

const archivo = ".env.local";
const contenido = readFileSync(archivo, "utf8");
const patron = /^STAGING_DATABASE_URL=.*$/m;
if (!patron.test(contenido)) {
  console.error("No encontré STAGING_DATABASE_URL en .env.local");
  process.exit(1);
}
writeFileSync(
  archivo,
  contenido.replace(patron, `STAGING_DATABASE_URL=${cadenaNueva}`),
  "utf8"
);

console.log(`\n${"─".repeat(66)}`);
console.log("✓ STAGING_DATABASE_URL actualizada en .env.local.");
console.log("");
console.log("  No se imprime. Para llevarla a GitHub sin que pase por pantalla:");
console.log("    grep -oP '(?<=^STAGING_DATABASE_URL=).*' .env.local | tr -d '\\r\\n' | gh secret set STAGING_DATABASE_URL");

