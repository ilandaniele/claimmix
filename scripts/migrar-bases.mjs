/**
 * migrar-bases.mjs — llevar al día la base de control y las de cada cliente.
 *
 *   node scripts/migrar-bases.mjs --env prd                       # aplica lo que falta, en orden
 *   node scripts/migrar-bases.mjs --env prd --dry                 # sólo muestra qué haría
 *   node scripts/migrar-bases.mjs --env prd --base t_<32 hex>     # sólo esa base de cliente
 *   node scripts/migrar-bases.mjs --env prd --perfil control      # además, el perfil de permisos de control
 *   node scripts/migrar-bases.mjs --env ensayo                    # rama ensayo de claimmix-prd (lo usa `pnpm bases:probar`)
 *
 * Por qué existe: `migrate.mjs` migra UNA base y la cadena de cada cliente sólo se
 * aplica sola a una base nueva (`migrarBase`). Cuando sale una migración hay que
 * llevarla a control y a todas las `t_<hex>` que ya existen, y volver a dar los
 * permisos del perfil cliente, porque una tabla nueva nace con el GRANT por omisión.
 *
 * Orden de cada corrida:
 *   1. control: los archivos de neon/migrations sin fila en schema_migrations.
 *   2. cada base `lista` de tenant_bases: lo mismo en su propio registro, y
 *      `version_migracion` queda en la última versión aplicada. `--base` limita
 *      este paso (y el 3) a una base y salta el 1.
 *   3. el perfil cliente (permisos) en cada una de esas bases.
 *   4. con `--perfil control`, el perfil control (permisos) en la base de control.
 *      `--perfil cliente` es lo de siempre: el paso 3 ya lo hace.
 *
 * Aplica por omisión (con `--dry` no escribe nada, ni siquiera el registro). Una
 * base de cliente que falla se informa y no frena a las demás; el código de salida
 * es 1 si alguna falló. Una falla en control frena todo.
 *
 * Las cadenas vienen de `entorno-de-bases.mjs`: prd sólo de `.env.prd.local`, y
 * con el host de claimmix-prd; dev, QA y staging se rechazan.
 */
import { readFileSync, readdirSync } from "node:fs";
import { createHash } from "node:crypto";
import path from "node:path";
import { connect } from "./lib/db-driver.mjs";
import { cadenaConBase, cadenasDelEntorno, NOMBRE_DE_BASE } from "./lib/entorno-de-bases.mjs";
import {
  sentenciasDelRol,
  sentenciasPerfilCliente,
  sentenciasPerfilControl,
} from "./lib/permisos-por-perfil.mjs";

const MIGRATIONS_DIR = "./neon/migrations";
const LF = String.fromCharCode(10);
const CRLF = String.fromCharCode(13, 10);

const argumento = (nombre) => {
  const i = process.argv.indexOf(nombre);
  return i === -1 ? null : (process.argv[i + 1] ?? "");
};
const AMBIENTE = argumento("--env");
const PERFIL = argumento("--perfil");
const BASE = argumento("--base");
const DRY = process.argv.includes("--dry");

function parar(mensaje) {
  console.error(`✖ ${mensaje}`);
  process.exit(1);
}

if (PERFIL !== null && !["cliente", "control"].includes(PERFIL)) {
  parar(`--perfil espera cliente o control (recibí "${PERFIL}")`);
}
if (BASE !== null && !NOMBRE_DE_BASE.test(BASE)) {
  parar(`--base espera t_ y 32 hex en minúscula (recibí "${BASE}")`);
}

let dueno;
try {
  ({ dueno } = cadenasDelEntorno(AMBIENTE));
} catch (e) {
  parar(e.message);
}

/** Igual que `readMigrations` de migrate.mjs: el hash no depende del final de línea del checkout. */
function leerMigraciones() {
  const archivos = readdirSync(MIGRATIONS_DIR).filter((f) => f.endsWith(".sql")).sort();
  const malos = archivos.filter((f) => !/^\d{4}_/.test(f));
  if (malos.length > 0) parar(`estos archivos no empiezan con una versión de 4 dígitos: ${malos.join(", ")}`);

  return archivos.map((filename) => {
    const sql = readFileSync(path.join(MIGRATIONS_DIR, filename), "utf8");
    const normalizado = sql.split(CRLF).join(LF);
    return {
      version: filename.slice(0, 4),
      filename,
      sql,
      checksum: createHash("sha256").update(normalizado).digest("hex"),
      checksumViejo: [normalizado, normalizado.split(LF).join(CRLF)].map((x) =>
        createHash("sha256").update(x).digest("hex"),
      ),
    };
  });
}

const MIGRACIONES = leerMigraciones();

const REGISTRO = `
  create table if not exists schema_migrations (
    version     text primary key,
    filename    text        not null,
    checksum    text        not null,
    applied_at  timestamptz not null default now(),
    applied_by  text
  )
`;

/** Con TCP las sentencias van juntas, en una transacción; por HTTP van de a una y se pueden repetir. */
async function correrTodas(c, sentencias) {
  if (c.kind === "tcp") return c.query(sentencias.join(";\n"));
  for (const s of sentencias) await c.query(s);
}

const ULTIMA = Number(MIGRACIONES.at(-1).version);

/**
 * Aplica a la base conectada las migraciones sin fila en su registro, y dice cuántas.
 * Tira si el registro y los archivos discrepan, o si el registro está vacío en una base que ya tiene tablas.
 */
async function migrar(c, etiqueta) {
  const { rows: existe } = await c.query(`select to_regclass('schema_migrations') as t`);
  const sinRegistro = existe[0].t == null;
  if (sinRegistro && !DRY) await c.query(REGISTRO);
  const { rows } = sinRegistro ? { rows: [] } : await c.query(`select version, checksum from schema_migrations`);
  const aplicadas = new Map(rows.map((r) => [r.version, r.checksum]));

  const distintas = MIGRACIONES.filter(
    (m) =>
      aplicadas.has(m.version) &&
      aplicadas.get(m.version) !== m.checksum &&
      !m.checksumViejo.includes(aplicadas.get(m.version)),
  );
  if (distintas.length > 0) {
    throw new Error(`${etiqueta}: migraciones editadas después de aplicarse: ${distintas.map((m) => m.filename).join(", ")}`);
  }

  const pendientes = MIGRACIONES.filter((m) => !aplicadas.has(m.version));
  if (aplicadas.size === 0 && pendientes.length > 0) {
    const { rows: tablas } = await c.query(
      `select count(*)::int n from information_schema.tables where table_schema = 'public' and table_name = 'cases'`,
    );
    if (tablas[0].n > 0) {
      throw new Error(
        `${etiqueta}: el registro está vacío pero la base ya tiene tablas. Adoptá lo ya aplicado con ` +
          "`node scripts/migrate.mjs --url <cadena> --baseline <última> --apply` antes de seguir.",
      );
    }
  }

  for (const m of pendientes) {
    console.log(`   ${DRY ? "·" : "→"} ${m.filename}`);
    if (!DRY) await c.applyMigration(m, "migrar-bases.mjs");
  }
  return pendientes.length;
}

const control = await connect(dueno);
let fallas = 0;

try {
  console.log(`▸ ${AMBIENTE}${DRY ? " (--dry: no se escribe nada)" : ""}`);

  if (BASE === null) {
    console.log("\n▸ control");
    try {
      if ((await migrar(control, "control")) === 0) console.log("   (al día)");
    } catch (e) {
      console.error(`\n✖ ${e.message}`);
      process.exit(1);
    }
  }

  // Con `--dry` la 0050 puede estar todavía pendiente: sin tabla no hay bases de cliente.
  const { rows: hayTabla } = await control.query(`select to_regclass('public.tenant_bases') as t`);
  const { rows: listas } =
    hayTabla[0].t == null
      ? { rows: [] }
      : await control.query(
          `select tenant_id::text as tenant_id from public.tenant_bases where estado = 'lista' order by tenant_id`,
        );
  const bases = listas
    .map((f) => ({ id: f.tenant_id, nombre: `t_${f.tenant_id.replaceAll("-", "")}` }))
    .filter((b) => BASE === null || b.nombre === BASE);
  if (BASE !== null && bases.length === 0) parar(`${BASE} no figura como lista en tenant_bases`);

  console.log(`\n▸ ${bases.length} base(s) de cliente`);
  for (const b of bases) {
    console.log(`\n   ${b.nombre}`);
    let c;
    try {
      c = await connect(cadenaConBase(dueno, b.nombre));
      const aplicadas = await migrar(c, b.nombre);
      if (!DRY) {
        await correrTodas(c, [...sentenciasDelRol(), ...sentenciasPerfilCliente()]);
        await control.query("update public.tenant_bases set version_migracion = $1 where tenant_id = $2::uuid", [ULTIMA, b.id]);
      }
      console.log(`   ✔ ${aplicadas === 0 ? "al día" : `${aplicadas} migración(es)`}${DRY ? "" : ", perfil cliente dado"}`);
    } catch (e) {
      fallas++;
      console.error(`   ✖ ${b.nombre}: ${e.message.split("\n")[0]}`);
    } finally {
      await c?.end();
    }
  }

  if (PERFIL === "control") {
    console.log("\n▸ perfil control");
    if (DRY) {
      console.log("   · se daría el perfil control a la base de control");
    } else {
      await correrTodas(control, [...sentenciasDelRol(), sentenciasPerfilControl()]);
      console.log("   ✔ dado");
    }
  }
} finally {
  await control.end();
}

if (fallas > 0) parar(`${fallas} base(s) de cliente fallaron: arreglá la causa y volvé a correr.`);
console.log(`\n✔ ${DRY ? "nada escrito." : "listo."}`);
