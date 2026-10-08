/**
 * empaquetar-bases.mjs — la cadena de migraciones y los permisos, como datos.
 *
 *   node scripts/empaquetar-bases.mjs              # escribe src/server/bases/plantilla.generated.ts
 *   node scripts/empaquetar-bases.mjs --comprobar  # sale 1 si el archivo difiere; sólo lee
 *
 * Por qué existe: el workflow que prepara la base de un cliente corre en Vercel,
 * donde `neon/migrations/` no viaja con la función y `node:fs` no es una opción.
 * La cadena entera, los permisos de la app y los del perfil cliente se empaquetan
 * acá en un módulo de TypeScript sin imports, y el CI comprueba que no se haya
 * quedado atrás: una migración nueva sin volver a empaquetar es una base de
 * cliente que nace sin ella.
 *
 * La cadena empaquetada se aplica sola únicamente a una base nueva y vacía. Las
 * que ya existen se migran a mano, como siempre.
 *
 * El archivo es determinista: sin fechas, finales de línea normalizados a LF (en
 * Windows `core.autocrlf` reescribe los .sql a CRLF) y las cadenas con
 * JSON.stringify, que es una cadena válida de TypeScript.
 */
import { existsSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { COLUMNAS_DE_CONFIG, sentenciasDelRol, sentenciasPerfilCliente } from "./lib/permisos-por-perfil.mjs";

const RAIZ = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const MIGRATIONS_DIR = path.join(RAIZ, "neon/migrations");
const DESTINO = path.join(RAIZ, "src/server/bases/plantilla.generated.ts");

const COMPROBAR = process.argv.includes("--comprobar");

const LF = String.fromCharCode(10);
const CRLF = String.fromCharCode(13, 10);
const aLf = (texto) => texto.split(CRLF).join(LF);

/** Igual que `migrate.mjs`: el prefijo de 4 dígitos manda, y un archivo que no lo tiene frena todo. */
function leerMigraciones() {
  const archivos = readdirSync(MIGRATIONS_DIR).filter((f) => f.endsWith(".sql")).sort();

  const malos = archivos.filter((f) => !/^\d{4}_/.test(f));
  if (malos.length > 0) {
    console.error(`✖ estos archivos no empiezan con una versión de 4 dígitos: ${malos.join(", ")}`);
    process.exit(1);
  }

  return archivos.map((nombre, i) => {
    const version = Number(nombre.slice(0, 4));
    if (version !== i + 1) {
      console.error(`✖ la cadena tiene que ir de 1 en 1 sin repetir ni saltear: ${nombre} está en el lugar ${i + 1}`);
      process.exit(1);
    }
    return { version, nombre, sql: aLf(readFileSync(path.join(MIGRATIONS_DIR, nombre), "utf8")) };
  });
}

const cadena = (x) => JSON.stringify(x);
const lista = (xs) => `[${LF}${xs.map((x) => `  ${cadena(x)},`).join(LF)}${LF}]`;

function armar(migraciones) {
  const entradas = migraciones.map(
    (m) =>
      `  {${LF}    version: ${m.version},${LF}    nombre: ${cadena(m.nombre)},${LF}    sql: ${cadena(m.sql)},${LF}  },`,
  );

  return [
    "// Generado por scripts/empaquetar-bases.mjs (pnpm bases:empaquetar). No se edita a mano:",
    "// el CI corre `pnpm bases:empaquetar --comprobar` y falla si queda desactualizado.",
    "// Sin imports a propósito: lo usa un workflow, donde no hay sistema de archivos.",
    "",
    "export type Migracion = { version: number; nombre: string; sql: string };",
    "",
    "// `nombre` es el archivo tal cual (0001_init.sql); `sql` ya viene con LF.",
    `export const MIGRACIONES: readonly Migracion[] = [${LF}${entradas.join(LF)}${LF}];`,
    "",
    "// Lo que `pnpm rol-app` le da al rol de la app, y lo que se le quita en la base de un cliente.",
    `export const PERMISOS_APP: readonly string[] = ${lista(sentenciasDelRol())};`,
    "",
    `export const PERMISOS_CLIENTE: readonly string[] = ${lista(sentenciasPerfilCliente())};`,
    "",
    `export const COLUMNAS_DE_CONFIG: readonly string[] = ${lista(COLUMNAS_DE_CONFIG)};`,
    "",
    `export const VERSION_ESPERADA: number = ${migraciones[migraciones.length - 1].version};`,
    "",
  ].join(LF);
}

const migraciones = leerMigraciones();
const contenido = armar(migraciones);

if (COMPROBAR) {
  const actual = existsSync(DESTINO) ? aLf(readFileSync(DESTINO, "utf8")) : null;
  if (actual !== contenido) {
    console.error("✖ src/server/bases/plantilla.generated.ts no coincide con neon/migrations ni con los permisos.");
    console.error("  Corré `pnpm bases:empaquetar` y commiteá el resultado.");
    process.exit(1);
  }
  console.log(`✓ plantilla.generated.ts al día (${migraciones.length} migraciones)`);
} else {
  mkdirSync(path.dirname(DESTINO), { recursive: true });
  writeFileSync(DESTINO, contenido);
  console.log(`✓ ${migraciones.length} migraciones empaquetadas en src/server/bases/plantilla.generated.ts`);
}
