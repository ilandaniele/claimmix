/**
 * `pnpm bases:probar` — ¿anda la base por cliente de punta a punta?
 *
 * Da de alta dos inquilinos con la función de verdad, les prepara su base `t_<hex>`
 * con el mismo `prepararBase` del workflow y comprueba lo que la migración a una
 * base por cliente promete: que cada base queda en la última migración, que el
 * rol de la app no toca lo que es de control, que el espejo es una copia fiel, que
 * la capa de datos no deja ver al vecino, que una clave de un inquilino sin base da
 * 401, que la auditoría cae a control si la base no existe, que el tope de bases
 * cierra el alta, que crear y tomar la base se pueden repetir y que el barrido
 * recorre todas.
 *
 * Escribe y borra bases: sólo corre contra el proyecto de ensayo de bases
 * (claimmix-ensayo). Usa nada más `ENSAYO_BASES_DATABASE_URL` (el dueño) y
 * `ENSAYO_BASES_DATABASE_URL_APP` (`claimmix_app`); el veto rechaza dev, QA,
 * staging y producción. Pone `BASE_POR_CLIENTE=1` sólo para este proceso.
 *
 * Al final borra con `DROP DATABASE` las bases que creó y con el rol dueño los
 * inquilinos y los usuarios de prueba, también si algo falló. Si una corrida se
 * corta a la mitad, la siguiente barre lo que tenga más de una hora.
 *
 * Sale con 0 si todo está en orden y con 1 si algo falló o la corrida se negó.
 */
import { randomBytes, randomInt, randomUUID } from "node:crypto";
import { spawnSync } from "node:child_process";
import { isDeepStrictEqual } from "node:util";
import { Pool, neonConfig } from "@neondatabase/serverless";
import { eq, sql } from "drizzle-orm";
import { codigoDe, resumenDe } from "../tests/e2e/base-de-ensayo";
import { cadenaConBase, cadenasDelEntorno, nombreDeBaseDe } from "./lib/entorno-de-bases.mjs";
import { ROL_APP } from "./lib/permisos-por-perfil.mjs";

process.on("uncaughtException", (e) => {
  console.error(`\n✗ Error sin atrapar (${resumenDe(e)}).`);
  process.exit(1);
});

neonConfig.webSocketConstructor = globalThis.WebSocket as never;

function parar(mensaje: string): never {
  console.error(`✖ ${mensaje}`);
  process.exit(1);
}

let dueno: string;
let app: string;
try {
  const cadenas = cadenasDelEntorno("ensayo", { app: true });
  dueno = cadenas.dueno;
  app = cadenas.app ?? parar("falta ENSAYO_BASES_DATABASE_URL_APP");
} catch (e) {
  parar((e as Error).message);
}

const usuarioApp = new URL(app);
if (decodeURIComponent(usuarioApp.username) !== ROL_APP) {
  parar(`ENSAYO_BASES_DATABASE_URL_APP tiene que entrar como ${ROL_APP}`);
}

// Antes de importar nada de la app: la capa de datos y el workflow leen estas variables al usarse.
process.env.LOG_LEVEL = "error";
process.env.RATE_LIMIT_PROVIDER = "memory";
process.env.BASE_POR_CLIENTE = "1";
process.env.DATABASE_URL = dueno;
process.env.DATABASE_URL_APP = app;
process.env.ALTA_TOPE_MB = "0";

const { autenticarClave } = await import("@/app/api/v1/_auth");
const { enTenant } = await import("@/data/scope");
const { writeAuditLog } = await import("@/lib/audit/log");
const { tables } = await import("@/lib/db");
const { filasDe } = await import("@/lib/db/filas");
const { crearInquilino } = await import("@/server/alta/crear-inquilino");
const { paraCadaBase } = await import("@/server/bases/cada-base");
const { crearBaseSiFalta, marcarBase, migrarBase, registrarBase, tomarBase, topesDeBases } = await import(
  "@/server/bases/crear-base"
);
const { MIGRACIONES, VERSION_ESPERADA } = await import("@/server/bases/plantilla.generated");
const { prepararBase } = await import("@/workflows/preparar-base");

const CORRIDA = randomBytes(3).toString("hex");
const PREFIJO = "zz-bases-probar-";
const CORREO = "bases-probar-";
/** El inquilino de demostración que siembra la 0016 en toda base migrada. */
const DEMO = "20000000-0000-0000-0000-000000000002";

type Fila = Record<string, unknown>;
type Inquilino = { id: string; base: string };

const bien = (t: string) => console.log(`   ✓ ${t}`);
const problemas: string[] = [];
const mal = (t: string) => {
  console.log(`   ✗ ${t}`);
  problemas.push(t);
};
const verificar = (ok: boolean, t: string) => (ok ? bien(t) : mal(t));

/** Una sección: lo que tire se anota como problema y la corrida sigue con la siguiente. */
async function paso(titulo: string, trabajo: () => Promise<void>): Promise<boolean> {
  console.log(`\n▸ ${titulo}`);
  const antes = problemas.length;
  try {
    await trabajo();
  } catch (e) {
    mal(`${titulo}: ${resumenDe(e)}`);
  }
  return problemas.length === antes;
}

/** Una consulta con su propia conexión: se abre, se usa y se cierra, así una base que se borra no deja nada colgado. */
async function consultar(cadena: string, texto: string, parametros?: unknown[]): Promise<Fila[]> {
  const pool = new Pool({ connectionString: cadena });
  pool.on("error", () => {});
  try {
    return (await pool.query(texto, parametros)).rows as Fila[];
  } finally {
    await pool.end();
  }
}

const comoDueno = (texto: string, parametros?: unknown[]) => consultar(dueno, texto, parametros);

/** La consulta tiene que salir con «permission denied»: el 42501 de una política de fila no cuenta, es otra barrera. */
async function negado(cadena: string, texto: string, descripcion: string) {
  try {
    await consultar(cadena, texto);
    mal(`${descripcion}: la app pudo`);
  } catch (e) {
    const sinPermiso = codigoDe(e) === "42501" && !/row-level security/i.test((e as Error).message ?? "");
    if (sinPermiso) bien(`${descripcion}: la app no puede`);
    else mal(`${descripcion}: falló por otra causa (${resumenDe(e)})`);
  }
}

function correr(titulo: string, orden: string, argumentos: string[], opciones: { shell?: boolean; env?: NodeJS.ProcessEnv } = {}) {
  const r = spawnSync(orden, argumentos, { encoding: "utf8", env: opciones.env ?? process.env, shell: opciones.shell });
  const salida = `${r.stdout ?? ""}${r.stderr ?? ""}`.trim().split("\n");
  if (r.status === 0) {
    bien(`${titulo}: ${salida.at(-1) ?? "listo"}`);
  } else {
    mal(`${titulo}: salió con ${r.status ?? r.signal}\n      ${salida.slice(-12).join("\n      ")}`);
  }
}

/**
 * Borra bases e inquilinos de prueba. `corrida` limita a los de esta corrida; sin
 * ella, a los de más de una hora (lo que dejó una corrida cortada). Nunca toca un
 * inquilino que no lleve el prefijo.
 */
async function barrer(corrida: string | null) {
  const [control] = await comoDueno(`select to_regclass('public.tenants') is not null as hay`);
  if (!control?.hay) return;

  const ids = (
    await comoDueno(
      `select id::text as id from public.tenants
       where starts_with(name, $1) and ${corrida ? "right(name, 6) = $2" : "created_at < now() - interval '1 hour'"}`,
      corrida ? [PREFIJO, corrida] : [PREFIJO],
    )
  ).map((f) => String(f.id));

  for (const id of ids) {
    await comoDueno(`DROP DATABASE IF EXISTS "${nombreDeBaseDe(id)}" WITH (FORCE)`);
  }
  if (ids.length > 0) {
    await comoDueno(`delete from public.audit_log where tenant_id = any($1::uuid[])`, [ids]);
    await comoDueno(`delete from public.tenants where id = any($1::uuid[])`, [ids]);
  }
  if (corrida) {
    await comoDueno(`delete from public.audit_log where starts_with(event_type, 'probar.bases') and payload->>'corrida' = $1`, [corrida]);
    await comoDueno(`delete from public."user" where starts_with(email, $1)`, [`${CORREO}${corrida}-`]);
  } else {
    await comoDueno(`delete from public."user" where starts_with(email, $1) and created_at < now() - interval '1 hour'`, [CORREO]);
  }
}

async function darDeAlta(letra: string): Promise<Inquilino | null> {
  const userId = randomUUID();
  await comoDueno(`insert into public."user" (id, name, email, email_verified) values ($1, 'Prueba de bases', $2, true)`, [
    userId,
    `${CORREO}${CORRIDA}-${letra}@example.com`,
  ]);
  const alta = await crearInquilino({
    userId,
    empresa: `${PREFIJO}${letra}-${CORRIDA}`,
    numero: `+54911${randomInt(10_000_000, 99_999_999)}`,
    ip: null,
  });
  if (alta.resultado !== "ok") {
    mal(`el alta de ${letra} dio ${alta.resultado}`);
    return null;
  }
  return { id: alta.tenantId, base: nombreDeBaseDe(alta.tenantId) };
}

/** Todo lo que el espejo copia de un inquilino, tal como lo ve quien consulta esa base. */
const ESPEJADO = `
  select
    (select to_jsonb(t) from public.tenants t where t.id = $1::uuid) as tenant,
    coalesce((select jsonb_agg(to_jsonb(u) order by u.id) from public.users u where u.tenant_id = $1::uuid), '[]'::jsonb) as users,
    coalesce((
      select jsonb_agg(to_jsonb(a) order by a.id) from public."user" a
      where a.id in (select m.id from public.users m where m.tenant_id = $1::uuid)
    ), '[]'::jsonb) as auth,
    coalesce((
      select jsonb_agg(to_jsonb(n) - 'token_cifrado' order by n.id) from public.whatsapp_numeros n where n.tenant_id = $1::uuid
    ), '[]'::jsonb) as numeros,
    coalesce((select jsonb_agg(t.id::text order by t.id::text) from public.tenants t), '[]'::jsonb) as inquilinos
`;

console.log("═".repeat(70));
console.log("BASES POR CLIENTE — de punta a punta, contra el proyecto de ensayo");
console.log("═".repeat(70));

const altas: { a?: Inquilino; b?: Inquilino } = {};

try {
  const listo = await paso("El rol de la app y la cadena de migraciones en control", async () => {
    const hay = await comoDueno(`select 1 from pg_roles where rolname = $1`, [ROL_APP]);
    if (hay.length === 0) {
      const clave = decodeURIComponent(usuarioApp.password).replaceAll("'", "''");
      await comoDueno(`CREATE ROLE ${ROL_APP} WITH LOGIN PASSWORD '${clave}' NOCREATEDB NOCREATEROLE NOBYPASSRLS`);
      bien(`creé el rol ${ROL_APP}`);
    } else {
      bien(`el rol ${ROL_APP} ya estaba`);
    }
    correr("migrar-bases (control)", process.execPath, ["scripts/migrar-bases.mjs", "--env", "ensayo", "--perfil", "control"]);
    await barrer(null);
  });
  if (!listo) throw new Error("sin control listo no hay nada que probar");

  process.env.ALTA_TOPE_GLOBAL_DIA = "500";
  process.env.ALTA_TOPE_BASES = "0";

  await paso("Altas de A y de B con la función de verdad", async () => {
    altas.a = (await darDeAlta("a")) ?? undefined;
    altas.b = (await darDeAlta("b")) ?? undefined;
    verificar(altas.a !== undefined && altas.b !== undefined, "los dos inquilinos existen en control");
  });
  const { a: ia, b: ib } = altas;
  if (!ia || !ib) throw new Error("sin los dos inquilinos no hay nada que probar");

  await paso("Preparar las dos bases (el workflow, en línea)", async () => {
    await prepararBase(ia.id);
    await prepararBase(ib.id);
    for (const x of [ia, ib]) {
      const [fila] = await comoDueno(`select estado, version_migracion, ultimo_error from public.tenant_bases where tenant_id = $1::uuid`, [x.id]);
      verificar(fila?.estado === "lista", `${x.base}: lista en tenant_bases${fila?.ultimo_error ? ` (${String(fila.ultimo_error)})` : ""}`);
      verificar(Number(fila?.version_migracion) === VERSION_ESPERADA, `${x.base}: version_migracion ${fila?.version_migracion} de ${VERSION_ESPERADA}`);
      const [registro] = await consultar(
        cadenaConBase(dueno, x.base),
        `select max(version::int)::int as ultima, count(*)::int as cuantas from schema_migrations`,
      );
      verificar(
        Number(registro?.ultima) === VERSION_ESPERADA && Number(registro?.cuantas) === MIGRACIONES.length,
        `${x.base}: schema_migrations en ${registro?.ultima} con ${registro?.cuantas} de ${MIGRACIONES.length} asientos`,
      );
    }
  });

  await paso("Perfil cliente: la app no toca lo de control en la base de A", async () => {
    const comoApp = cadenaConBase(app, ia.base);
    await negado(comoApp, `select 1 from public.account limit 1`, "leer account");
    await negado(comoApp, `select 1 from public.tenant_bases limit 1`, "leer tenant_bases");
    await negado(comoApp, `insert into public.users (id) values (gen_random_uuid())`, "escribir users");
    await negado(comoApp, `delete from public.users`, "borrar users");
  });

  await paso("Perfiles de permisos con `pnpm permisos`", async () => {
    const env = { ...process.env, DATABASE_URL_APP: app };
    const tsx = ["exec", "tsx", "--tsconfig", "tsconfig.rehearsal.json", "scripts/prove-grants.mts"];
    const shell = process.platform === "win32";
    correr("perfil cliente en A", "pnpm", [...tsx, "--perfil", "cliente", "--base", ia.base], { env, shell });
    correr("perfil control en control", "pnpm", [...tsx, "--perfil", "control"], { env, shell });
  });

  await paso("El espejo es una copia fiel de control", async () => {
    for (const x of [ia, ib]) {
      const [deControl] = await comoDueno(ESPEJADO, [x.id]);
      const [deBase] = await consultar(cadenaConBase(dueno, x.base), ESPEJADO, [x.id]);
      for (const parte of ["tenant", "users", "auth", "numeros"]) {
        verificar(isDeepStrictEqual(deBase?.[parte], deControl?.[parte]), `${x.base}: ${parte} igual que en control`);
      }
      const ajenos = (deBase?.inquilinos as string[]).filter((id) => id !== x.id && id !== DEMO);
      verificar(ajenos.length === 0, `${x.base}: no hay inquilinos ajenos (fuera del de demostración de la 0016)`);
    }
  });

  await paso("enTenant(A) no ve lo de B", async () => {
    const meter = (base: string, tenantId: string) =>
      consultar(cadenaConBase(dueno, base), `insert into public.audit_log (tenant_id, event_type, payload) values ($1::uuid, 'probar.bases', $2::jsonb)`, [
        tenantId,
        JSON.stringify({ corrida: CORRIDA }),
      ]);
    // La fila de B se mete a mano en la base de A: la política de fila es lo único que la esconde.
    await meter(ia.base, ia.id);
    await meter(ia.base, ib.id);
    await meter(ib.base, ib.id);
    const [deB] = await consultar(cadenaConBase(dueno, ia.base), `select count(*)::int as n from public.audit_log where tenant_id = $1::uuid`, [ib.id]);
    verificar(Number(deB?.n) === 1, "la fila de B está en la base de A (la prueba tiene con qué fallar)");

    const deA = await enTenant({ tenantId: ia.id }, (db) =>
      db.select({ tenant: tables.auditLog.tenant_id }).from(tables.auditLog).where(eq(tables.auditLog.event_type, "probar.bases")),
    );
    verificar(deA.length === 1 && deA[0]?.tenant === ia.id, "enTenant(A) ve su fila de auditoría y no la de B");

    const inquilinosDeA = await enTenant({ tenantId: ia.id }, (db) => db.select({ id: tables.tenants.id }).from(tables.tenants));
    verificar(isDeepStrictEqual(inquilinosDeA.map((f) => f.id), [ia.id]), "enTenant(A) ve sólo el inquilino A");
    const inquilinosDeB = await enTenant({ tenantId: ib.id }, (db) => db.select({ id: tables.tenants.id }).from(tables.tenants));
    verificar(isDeepStrictEqual(inquilinosDeB.map((f) => f.id), [ib.id]), "enTenant(B) ve sólo el inquilino B");
  });

  await paso("Una clave de un inquilino sin base da 401", async () => {
    const pedido = (tenantId: string) =>
      new Request("https://example.com/api/v1/prueba", {
        headers: { authorization: `Bearer cmk_${tenantId}_${randomBytes(32).toString("base64url")}` },
      });
    const sinBase = await autenticarClave(pedido(randomUUID()));
    verificar(sinBase instanceof Response && sinBase.status === 401, "inquilino sin base: 401");
    const conBase = await autenticarClave(pedido(ia.id));
    verificar(conBase instanceof Response && conBase.status === 401, "inquilino con base y clave que no es la suya: 401");
  });

  await paso("La auditoría cae a control si la base no existe", async () => {
    const sinBase = randomUUID();
    await writeAuditLog({ tenant_id: sinBase, event_type: "probar.bases", payload: { corrida: CORRIDA } });
    const [enControl] = await comoDueno(`select count(*)::int as n from public.audit_log where tenant_id = $1::uuid`, [sinBase]);
    verificar(Number(enControl?.n) === 1, "inquilino sin base: la fila quedó en control");

    await writeAuditLog({ tenant_id: ia.id, event_type: "probar.bases.base", payload: { corrida: CORRIDA } });
    const cuenta = `select count(*)::int as n from public.audit_log where event_type = 'probar.bases.base' and payload->>'corrida' = $1`;
    const [enBase] = await consultar(cadenaConBase(dueno, ia.base), cuenta, [CORRIDA]);
    const [enCtl] = await comoDueno(cuenta, [CORRIDA]);
    verificar(Number(enBase?.n) === 1 && Number(enCtl?.n) === 0, "inquilino con base: la fila quedó en su base y no en control");
  });

  await paso("El tope de bases cierra el alta", async () => {
    verificar((await topesDeBases()).bases >= 2, "el catálogo cuenta al menos las dos bases de la prueba");
    const userId = randomUUID();
    await comoDueno(`insert into public."user" (id, name, email, email_verified) values ($1, 'Prueba de bases', $2, true)`, [
      userId,
      `${CORREO}${CORRIDA}-c@example.com`,
    ]);
    const datos = { userId, empresa: `${PREFIJO}c-${CORRIDA}`, numero: `+54911${randomInt(10_000_000, 99_999_999)}`, ip: null };

    const conTope = async (tope: string) => {
      process.env.ALTA_TOPE_BASES = tope;
      try {
        return await crearInquilino(datos);
      } finally {
        process.env.ALTA_TOPE_BASES = "0";
      }
    };
    const cerrada = await conTope("2");
    verificar(cerrada.resultado === "alta_cerrada", `con ALTA_TOPE_BASES=2 la tercera alta da ${cerrada.resultado}`);
    const [creado] = await comoDueno(`select count(*)::int as n from public.tenants where id = $1::uuid`, [cerrada.tenantId]);
    verificar(Number(creado?.n) === 0, "la alta cerrada no dejó ningún inquilino");

    const abierta = await conTope("0");
    verificar(abierta.resultado === "ok", `sin el tope, el mismo usuario da de alta (${abierta.resultado})`);

    // El tercer inquilino queda sin base: sirve para probar el lease sin crear otra.
    const c = abierta.tenantId;
    await registrarBase(c);
    verificar((await tomarBase(c, 15)) !== null, "tomar la base de C: la toma");
    verificar((await tomarBase(c, 15)) === null, "tomar la base de C con el lease vigente: no la da");
    await comoDueno(`update public.tenant_bases set tomada_at = now() - interval '20 minutes' where tenant_id = $1::uuid`, [c]);
    verificar((await tomarBase(c, 15)) !== null, "tomar la base de C con el lease vencido: la da");
    await marcarBase(c, "fallida", { error: "prueba" });
    verificar((await tomarBase(c, 15)) !== null, "tomar la base de C después de soltarla: la da");
  });

  await paso("Crear, migrar y tomar se pueden repetir", async () => {
    verificar((await crearBaseSiFalta(ia.base)) === "existia", "crearBaseSiFalta sobre una base que existe: «existia»");
    verificar((await migrarBase(ia.base)) === VERSION_ESPERADA, "migrarBase sobre una base al día: no aplica nada y devuelve la última");
    verificar((await tomarBase(ia.id, 15)) === null, "tomarBase sobre una base lista: no la da");
    await prepararBase(ia.id);
    const [fila] = await comoDueno(`select estado, version_migracion from public.tenant_bases where tenant_id = $1::uuid`, [ia.id]);
    verificar(fila?.estado === "lista" && Number(fila?.version_migracion) === VERSION_ESPERADA, "prepararBase otra vez: la base sigue lista");
  });

  await paso("El barrido recorre las dos bases", async () => {
    const r = await paraCadaBase(
      async (db) => {
        const [fila] = filasDe<{ base: string }>(await db.execute(sql`select current_database() as base`));
        return fila?.base;
      },
      { hasta: Date.now() + 120_000 },
    );
    verificar(r.resultados.includes(ia.base) && r.resultados.includes(ib.base), "pasó por la base de A y por la de B");
    verificar(r.fallas === 0 && r.pendientes === 0, `sin fallas ni pendientes (${r.fallas} fallas, ${r.pendientes} pendientes)`);
  });
} catch (e) {
  console.log(`\n   ↳ se corta: ${(e as Error).message}`);
} finally {
  await paso("Limpieza: borrar las bases y los inquilinos de esta corrida", async () => {
    await barrer(CORRIDA);
    const [quedan] = await comoDueno(`select count(*)::int as n from public.tenants where starts_with(name, $1) and right(name, 6) = $2`, [PREFIJO, CORRIDA]);
    verificar(Number(quedan?.n) === 0, "no queda ningún inquilino de la corrida");
  });
}

console.log("\n" + "═".repeat(70));
if (problemas.length > 0) {
  console.log(`✖ ${problemas.length} problema(s):`);
  for (const p of problemas) console.log(`   - ${p.split("\n")[0]}`);
  process.exit(1);
}
console.log("✔ La base por cliente anda de punta a punta.");
process.exit(0);
