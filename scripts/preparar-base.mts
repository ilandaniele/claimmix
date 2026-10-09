/**
 * `preparar-base.mts` — preparar a mano la base de un cliente.
 *
 *   tsx --tsconfig tsconfig.rehearsal.json scripts/preparar-base.mts --env prd --tenant <uuid>
 *
 * Corre en línea los mismos pasos que el workflow que dispara el alta: toma la
 * base (lease), la crea, la migra, le da los permisos del perfil cliente, copia el
 * espejo de control y la marca `lista`. Sirve para el inquilino casa, para
 * reintentar una base `fallida` sin esperar al barrido y para ensayar el camino
 * sin Vercel: `start` de `workflow/api` no existe fuera de la plataforma.
 *
 * No reimplementa los pasos: llama a `prepararBase` de src/workflows tal cual.
 * Sin el compilador del workflow, `"use workflow"` y `"use step"` son sólo cadenas
 * y la función corre como cualquier otra, de principio a fin. Por eso tampoco
 * tira: una falla deja la base `fallida` con su error, y acá se lee de la fila.
 *
 * Pone `BASE_POR_CLIENTE=1` sólo para este proceso. Las cadenas vienen de
 * `entorno-de-bases.mjs`: prd sólo de `.env.prd.local`, con el host de claimmix-prd.
 */
import { neonConfig } from "@neondatabase/serverless";
import { connect } from "./lib/db-driver.mjs";
import { cadenasDelEntorno, nombreDeBaseDe, UUID } from "./lib/entorno-de-bases.mjs";

neonConfig.webSocketConstructor = globalThis.WebSocket as never;

const args = process.argv.slice(2);
const valor = (nombre: string) => {
  const i = args.indexOf(nombre);
  return i === -1 ? null : (args[i + 1] ?? "");
};

function parar(mensaje: string): never {
  console.error(`✖ ${mensaje}`);
  process.exit(1);
}

const ambiente = valor("--env");
const tenantId = valor("--tenant");
if (ambiente !== "prd" && ambiente !== "ensayo") parar(`--env espera prd o ensayo (recibí "${ambiente}")`);
if (!tenantId || !UUID.test(tenantId)) parar(`--tenant espera un uuid en minúscula (recibí "${tenantId}")`);

let dueno: string;
try {
  ({ dueno } = cadenasDelEntorno(ambiente));
} catch (e) {
  parar((e as Error).message);
}

// Antes de importar nada de la app: `crear-base` y `espejo` leen estas dos al usarse.
process.env.DATABASE_URL = dueno;
process.env.BASE_POR_CLIENTE = "1";

const { prepararBase } = await import("@/workflows/preparar-base");

const c = await connect(dueno);
try {
  const { rows: inquilino } = await c.query("select name from public.tenants where id = $1::uuid", [tenantId]);
  if (inquilino.length === 0) parar(`el inquilino ${tenantId} no existe en ${new URL(dueno).hostname.split(".")[0]}`);

  console.log(`▸ ${ambiente}: preparando ${nombreDeBaseDe(tenantId)}`);
  await prepararBase(tenantId);

  const { rows } = await c.query(
    "select estado, version_migracion, intentos, ultimo_error from public.tenant_bases where tenant_id = $1::uuid",
    [tenantId],
  );
  const fila = rows[0];
  if (fila?.estado === "lista") {
    console.log(`✔ lista, en la migración ${fila.version_migracion} (intento ${fila.intentos})`);
  } else if (fila?.estado === "fallida") {
    console.error(`✖ fallida: ${fila.ultimo_error ?? "(sin detalle)"}`);
    process.exitCode = 1;
  } else {
    console.error(`✖ no se preparó: la fila está ${fila?.estado ?? "ausente"}. Otro proceso la tiene tomada, o ya está borrada.`);
    process.exitCode = 1;
  }
} finally {
  await c.end();
}
