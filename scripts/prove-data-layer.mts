/**
 * `pnpm capa-datos` — probar que la capa de datos aísla, usándola de verdad.
 *
 * `pnpm tenancy` demuestra que la BASE separa. Esto demuestra que la CAPA la usa
 * bien, que es otra cosa: una capa correcta sobre una base bien configurada
 * puede seguir filtrando datos si olvida poner el contexto, o si lo pone mal.
 *
 * Se prueba con las funciones que va a usar la aplicación —`enTenant` y
 * `enTenantVarias`— y no con SQL escrito para la ocasión. Una prueba que no pasa
 * por el mismo camino que el código no prueba el código.
 *
 * Necesita DATABASE_URL_APP, DATABASE_URL (el dueño, en la misma base, para listar
 * los inquilinos) y dos inquilinos con datos. Sólo lee, salvo las
 * secciones 5, 6 y 7, que escriben: un caso marcador (la 5), un uso de IA
 * marcador con un usuario descartable (la 6) y un inquilino descartable con su
 * SSO, su cola de purga y sus casos (la 7). Por eso corren sólo en CI (contra el
 * ensayo) o con `--escribe`, y nunca contra la base de producción: nunca a
 * ciegas con el `.env.local`.
 *
 * La sección 4 corre siempre: intenta un INSERT en el inquilino de al lado que la
 * política tiene que rechazar. Sólo si la base lo deja pasar queda una fila, y se
 * borra enseguida con el rol dueño.
 */
import * as dotenv from "dotenv";
dotenv.config({ path: ".env.local" });

import { randomInt, randomUUID } from "node:crypto";
import { Pool, neonConfig } from "@neondatabase/serverless";
import { enTenant, enTenantVarias, type TenantContext } from "@/data/scope";
import { tables } from "@/lib/db";
import { eq, sql } from "drizzle-orm";
import { consultaDeActividad } from "@/server/metrics/kpis";
import { diaArgentino } from "@/core/fecha/dia-argentino";
import type { PuntoSerie } from "@/core/metricas/serie";
import { proveedorDeSso } from "@/core/sso";
import {
  ESTADOS_CERRADOS,
  ESTADOS_COMPLETADO_SIN_PERSONA,
  ESTADOS_ESCALADO,
} from "@/core/case/fsm";
import { contarCasos, buscarCaso } from "@/server/asistente/herramientas";
import { deleteCases } from "@/server/cases/delete";
import { aplicarRetencion } from "@/server/cases/retencion";
import { revisarDesvios } from "@/server/desvios/revision-nocturna";
import { cambiarEstadoSso, guardarIdp, type CambioDeEstadoSso } from "@/server/sso/config";
import {
  marcar as marcarPurga,
  vencidos as vencidosDeLaPurga,
  type Pendiente,
} from "@/server/storage/purgar-adjuntos";
import {
  HOST_DE_PRODUCCION,
  codigoDe,
  hostDe,
  resumenDe,
  taparEnElLog,
} from "../tests/e2e/base-de-ensayo";

// Lo que se escapa sin atrapar (una consulta fuera de `explicar`, un TypeError del
// driver) sale con el mensaje crudo, que puede traer parámetros o la cadena con la
// contraseña: al log va sólo el resumen.
process.on("uncaughtException", (e) => {
  console.error(`\n✗ Error sin atrapar (${resumenDe(e)}).`);
  process.exit(2);
});

neonConfig.webSocketConstructor = globalThis.WebSocket as never;

const url = process.env.DATABASE_URL_APP?.trim();
if (!url) {
  console.error("Falta DATABASE_URL_APP.");
  process.exit(2);
}

/**
 * Traducir el error del driver a algo accionable.
 *
 * "password authentication failed" sale como una excepción cruda con un stack
 * de veinte líneas del driver, y no dice ninguna de las dos cosas que hacen
 * falta: qué se rompió y cómo se arregla.
 */
function explicar(e: unknown): never {
  const msg = e instanceof Error ? e.message : String(e);
  if (/password authentication failed/i.test(msg)) {
    console.error("\n✗ La contraseña de DATABASE_URL (el rol dueño, con el que se listan los inquilinos) no autentica.");
    console.error("");
    console.error("  El rol existe; lo que no sirve es la contraseña guardada.");
    console.error("  Suele pasar después de rotarla en un lado y no en el otro.");
    console.error("  La de DATABASE_URL_APP, si falla, sale más abajo como error sin atrapar:");
    console.error("  se rota con `pnpm rol-app --rotar`.");
    process.exit(2);
  }
  console.error(`\n✗ No se pudo leer la base (${resumenDe(e)}).`);
  process.exit(2);
}

const bien = (t: string) => console.log(`   ✓ ${t}`);
const mal = (t: string) => console.log(`   ✗ ${t}`);
const problemas: string[] = [];

// El gate de las secciones que escriben mira cómo se corrió el script, no a dónde
// apunta, y los nombres de los secretos no dicen qué base hay detrás. Por eso se
// mira también el host: contra la base de producción, con una cadena que no es
// URL o con el dueño y la app en bases distintas (la 5 sembraría en una y borraría
// en la otra, un verde falso), no se escribe y el chequeo falla.
const escribe = process.env.CI === "true" || process.argv.includes("--escribe");
const hosts = [process.env.DATABASE_URL, url].map(hostDe);
const endpointDe = (h: string) => h.split(".")[0].replace(/-pooler$/, "");
// Con una cadena inválida el driver tira un TypeError que imprime la cadena entera,
// contraseña incluida.
if (!hosts[1]) {
  console.error("✗ DATABASE_URL_APP no es una URL válida.");
  process.exit(2);
}
const vetoDeEscritura = !escribe
  ? null
  : !hosts[0]
    ? "DATABASE_URL no es una URL válida"
    : hosts.some((h) => h.includes(HOST_DE_PRODUCCION))
      ? "la base es la de PRODUCCIÓN"
      : endpointDe(hosts[0]) !== endpointDe(hosts[1])
        ? "DATABASE_URL y DATABASE_URL_APP apuntan a bases distintas"
        : null;
if (vetoDeEscritura) problemas.push(`las secciones que escriben no corrieron: ${vetoDeEscritura}`);

console.log("═".repeat(70));
console.log("CAPA DE DATOS — ¿usa bien el aislamiento que la base ofrece?");
console.log("═".repeat(70));

// Los inquilinos se leen con el rol dueño, aparte y sin contexto: la capa
// —correctamente— no permite listar inquilinos (no son de nadie), y desde la 0048
// `tenants` tiene RLS forzado, así que el rol de la app, sin contexto, no ve ni
// una fila. Sólo lee, pero sólo si es la misma base: otro endpoint listaría
// inquilinos que la app no tiene.
if (!hosts[0] || endpointDe(hosts[0]) !== endpointDe(hosts[1])) {
  console.error("✗ Para listar los inquilinos hace falta DATABASE_URL (el rol dueño) en la misma base que DATABASE_URL_APP.");
  process.exit(2);
}
const pool = new Pool({ connectionString: process.env.DATABASE_URL?.trim() });
let inquilinos: Array<{ id: string; name: string }> = [];
try {
  inquilinos = (
    await pool
      .query(`SELECT id::text AS id, name FROM tenants ORDER BY created_at`)
      .catch(explicar)
  ).rows.map((t: { id: string; name: string }) => ({ ...t, name: t.name?.replace(/[\r\n]+/g, " ") }));
} finally {
  await pool.end();
}
// En CI los nombres de los inquilinos se tapan en el log del job, por si el
// ensayo se siembra algún día desde datos reales.
taparEnElLog(inquilinos.map((t) => t.name));

if (inquilinos.length < 2) {
  console.log("\n⚠ Hacen falta dos inquilinos para cruzar. Hay", inquilinos.length);
  process.exit(3);
}

const ctxDe = (t: { id: string }): TenantContext => ({ tenantId: t.id });

// ── 1. Cada uno ve lo suyo ─────────────────────────────────────────────────
console.log("\n▸ Cada inquilino, a través de la capa");
const vistos = new Map<string, number>();
for (const t of inquilinos) {
  const filas = await enTenant(ctxDe(t), (db) =>
    db.select({ id: tables.cases.id, dueno: tables.cases.tenant_id }).from(tables.cases)
  );
  vistos.set(t.id, filas.length);

  const ajenas = filas.filter((f) => f.dueno !== t.id);
  if (ajenas.length > 0) {
    mal(`"${t.name}" ve ${ajenas.length} caso(s) que NO son suyos`);
    problemas.push(`${t.name} ve datos ajenos`);
  } else {
    bien(`"${t.name}": ${filas.length} caso(s), todos suyos`);
  }
}

// ── 2. Lo de uno es invisible para el otro ─────────────────────────────────
console.log("\n▸ La prueba cruzada");

// Se eligen los dos que TIENEN datos, no los dos primeros de la lista.
//
// Antes tomaba `inquilinos[0]` y `[1]`, y si al segundo le tocaba estar vacío la
// prueba salía "no concluyente" aunque hubiera un tercero con casos de sobra
// para cruzar. Una prueba que se declara no concluyente por elegir mal a quién
// mirar es peor que no tenerla: se lee como un problema del aislamiento.
const conDatos = inquilinos
  .filter((t) => (vistos.get(t.id) ?? 0) > 0)
  .sort((x, y) => (vistos.get(y.id) ?? 0) - (vistos.get(x.id) ?? 0));

// Para el resto del guión alcanza con cualquiera que tenga datos.
const a = conDatos[0] ?? inquilinos[0];

if (conDatos.length < 2) {
  mal(
    `no concluyente: ${conDatos.length} inquilino(s) con casos. Hace falta que ` +
      "dos tengan algo para que uno pueda no ver lo del otro."
  );
  problemas.push("la prueba cruzada no tiene con qué cruzar");
} else {
  const b = conDatos[1];
  const deB = vistos.get(b.id) ?? 0;
  const desdeA = await enTenant(ctxDe(a), (db) =>
    db.select({ id: tables.cases.id }).from(tables.cases).where(eq(tables.cases.tenant_id, b.id))
  );
  if (desdeA.length > 0) {
    mal(`desde "${a.name}" se ven ${desdeA.length} caso(s) de "${b.name}" pidiéndolos por id`);
    problemas.push("se pueden pedir los casos de otro por id");
  } else {
    bien(`desde "${a.name}", los ${deB} caso(s) de "${b.name}" no existen — ni pidiéndolos`);
  }
}

// ── 3. Varias consultas, un viaje, mismo contexto ──────────────────────────
console.log("\n▸ Varias consultas en un solo viaje");
const [casos, docs] = await enTenantVarias<[unknown[], unknown[]]>(ctxDe(a), (db) => [
  db.select({ id: tables.cases.id }).from(tables.cases),
  db.select({ id: tables.missingDocs.id }).from(tables.missingDocs),
]);
bien(`${casos.length} caso(s) y ${docs.length} documento(s) faltante(s), en una sola ida`);

// ── 3b. La serie de actividad de /metricas, con el SQL de verdad ───────────
//
// El test de `getTenantKpis` mockea el lote, así que `to_char`, `date_trunc` y
// `at time zone` con parámetros ligados sólo se ejecutan acá. Toda la historia
// por día se cruza con los mismos casos contados en JS: el día sale de
// `diaArgentino` y los filtros están escritos de nuevo, así que un corrimiento
// de zona (los casos de 21 a 24) o un filtro mal puesto no cuadran.
console.log("\n▸ La serie de actividad de /metricas");
type Cuenta = Omit<PuntoSerie, "clave">;
type Crudo = { ms: number; is_claim: boolean | null; channel: string; status: string };
const esDe = (grupo: ReadonlySet<string>, estado: string) => grupo.has(estado);
const [porDia, crudos] = await enTenantVarias<[PuntoSerie[], Crudo[]]>(
  ctxDe(a),
  (db) => [
    consultaDeActividad(db, "dia", "1970-01-01T00:00:00Z"),
    db
      .select({
        ms: sql<number>`(extract(epoch from ${tables.cases.created_at}) * 1000)::float8`,
        is_claim: tables.cases.is_claim,
        channel: tables.cases.channel,
        status: tables.cases.status,
      })
      .from(tables.cases),
  ]
);
const enJs = new Map<string, Cuenta>();
let deNoche = 0;
for (const c of crudos) {
  if (c.channel.endsWith("_sim")) continue;
  const cuando = new Date(c.ms);
  const dia = diaArgentino(cuando);
  if (dia !== cuando.toISOString().slice(0, 10)) deNoche++;
  const n = enJs.get(dia) ?? {
    reclamos: 0,
    whatsapps: 0,
    mails: 0,
    reclamos_whatsapp: 0,
    reclamos_mail: 0,
    escalados: 0,
    listos: 0,
    cerrados: 0,
  };
  if (esDe(ESTADOS_ESCALADO, c.status)) n.escalados++;
  if (esDe(ESTADOS_COMPLETADO_SIN_PERSONA, c.status)) n.listos++;
  if (esDe(ESTADOS_CERRADOS, c.status)) n.cerrados++;
  if (c.is_claim === true) n.reclamos++;
  if (c.channel === "whatsapp") n.whatsapps++;
  if (c.channel === "email") n.mails++;
  if (c.is_claim === true && c.channel === "whatsapp") n.reclamos_whatsapp++;
  if (c.is_claim === true && c.channel === "email") n.reclamos_mail++;
  enJs.set(dia, n);
}
const enSql = new Map(porDia.map((f) => [f.clave, f]));
const descuadres = [...new Set([...enJs.keys(), ...enSql.keys()])].filter((dia) => {
  const [s, j] = [enSql.get(dia), enJs.get(dia)];
  return (
    !s ||
    !j ||
    s.reclamos !== j.reclamos ||
    s.whatsapps !== j.whatsapps ||
    s.mails !== j.mails ||
    s.reclamos_whatsapp !== j.reclamos_whatsapp ||
    s.reclamos_mail !== j.reclamos_mail ||
    s.escalados !== j.escalados ||
    s.listos !== j.listos ||
    s.cerrados !== j.cerrados
  );
});
if (descuadres.length) {
  mal(`la serie no cuadra con los casos en ${descuadres.length} día(s): ${descuadres.slice(0, 5).join(", ")}`);
  problemas.push("la serie de actividad no cuenta lo que hay en la base");
} else if (enJs.size === 0 || deNoche === 0) {
  // No es una falla de la capa: faltan datos que la pongan a prueba. Pero
  // tampoco es un ✓, que se leería como la frontera probada.
  console.log(
    `   ⚠ no concluyente: ${enJs.size} día(s) con WhatsApp o mail y ${deNoche} caso(s) ` +
      "entre las 21 y las 24, que es donde se nota la zona"
  );
} else {
  bien(
    `${enJs.size} día(s) iguales a los casos contados en JS, ${deNoche} de ellos ` +
      "entre las 21 y las 24"
  );
}

// ── 3c. El asistente: contar y buscar, sin cruzar de inquilino ─────────────
//
// `contarCasos`/`buscarCaso` (`src/server/asistente/herramientas.ts`) son las
// dos únicas consultas que el modelo puede disparar. Se prueban acá, contra la
// base de verdad, en vez de con `enTenant` mockeado como en el unit test.
console.log("\n▸ El asistente: contarCasos y buscarCaso");
const conteo = await contarCasos(ctxDe(a), {
  herramienta: "contar_casos",
  periodo: "ultimos_30_dias",
  canal: null,
  situacion: null,
  solo_reclamos: false,
});
bien(`"${a.name}": contarCasos ve ${conteo.total} caso(s) de los últimos 30 días`);

if (conDatos.length < 2) {
  console.log("     (hace falta un segundo inquilino para cruzar buscarCaso: se saltea)");
} else {
  const otro = conDatos[1];
  const [casoDeOtro] = await enTenant(ctxDe(otro), (db) =>
    db
      .select({ nombre: tables.cases.policyholder_name, poliza: tables.cases.policy_number })
      .from(tables.cases)
      .where(sql`${tables.cases.policyholder_name} is not null`)
      .limit(1)
  );

  if (!casoDeOtro?.nombre) {
    console.log(`     ("${otro.name}" no tiene un caso con nombre para probar: se saltea)`);
  } else {
    const porNombre = await buscarCaso(
      ctxDe(a),
      { herramienta: "buscar_caso", nombre: casoDeOtro.nombre, numero: null, codigo: null },
      "admin"
    );
    if (porNombre.coincidencias.length > 0) {
      mal(`desde "${a.name}" aparece el caso de "${otro.name}" buscándolo por nombre`);
      problemas.push("buscarCaso cruza de inquilino por nombre");
    } else {
      bien(`desde "${a.name}", el caso de "${otro.name}" no aparece buscándolo por nombre`);
    }

    const digitos = (casoDeOtro.poliza ?? "").replace(/\D/g, "");
    if (!digitos) {
      console.log(`     (la póliza de "${otro.name}" no tiene dígitos: se saltea esa parte)`);
    } else {
      const porNumero = await buscarCaso(
        ctxDe(a),
        { herramienta: "buscar_caso", nombre: null, numero: digitos, codigo: null },
        "admin"
      );
      if (porNumero.coincidencias.length > 0) {
        mal(`desde "${a.name}" aparece el caso de "${otro.name}" buscándolo por número de póliza`);
        problemas.push("buscarCaso cruza de inquilino por número");
      } else {
        bien(`desde "${a.name}", el caso de "${otro.name}" no aparece buscándolo por número de póliza`);
      }
    }
  }
}

// ── 4. Escribir en el inquilino de al lado ─────────────────────────────────
//
// Ésta es la defensa que antes no existía en ninguna forma. Con el filtro
// escrito a mano, una consulta que se olvidaba el `tenant_id` en un INSERT
// grababa la fila igual, en el inquilino equivocado, sin un solo error. La
// política `WITH CHECK` lo rechaza en la base.
//
// Se intenta contra un inquilino que existe y NO es el que pone el contexto. Si
// la base la deja pasar, la fila queda escrita: por eso se busca y se borra
// abajo, con el rol dueño, y se avisa fuerte. Un aviso silencioso acá es una
// fuga de escritura viviendo en producción.
console.log("\n▸ Escribir en el inquilino de al lado");
if (conDatos.length < 2) {
  console.log("     (hace falta un segundo inquilino: se saltea)");
} else {
  const otro = conDatos[1];
  const marca = `PRUEBA-CAPA-DATOS-${a.id.slice(0, 8)}`;
  let paso = false;
  try {
    await enTenant(ctxDe(a), (db) =>
      db.insert(tables.cases).values({
        tenant_id: otro.id,
        policy_number: marca,
        status: "recibido",
        channel: "email_sim",
      })
    );
    paso = true;
  } catch {
    // Lo esperado: la política la rechaza.
    bien(`la base rechaza escribir en "${otro.name}" desde el contexto de "${a.name}"`);
  }

  if (paso) {
    mal(`se pudo INSERTAR en "${otro.name}" desde el contexto de "${a.name}"`);
    problemas.push("se puede escribir en el inquilino de al lado");

    // Limpieza, con el rol dueño: la fila quedó escrita de verdad.
    const limpieza = new Pool({ connectionString: process.env.DATABASE_URL?.trim() });
    try {
      const r = await limpieza.query(`DELETE FROM cases WHERE policy_number = $1`, [marca]);
      console.log(`     (borrada${r.rowCount === 1 ? "" : ` — ${r.rowCount} filas`})`);
    } finally {
      await limpieza.end();
    }
  }
}

const aislamientoRoto = problemas.length > 0; // la 7 apoya un UPDATE sin WHERE en RLS

// ── 5. Borrar el caso del inquilino de al lado ─────────────────────────────
//
// `deleteCases` es el único camino que borra casos y encola sus adjuntos de R2
// para la purga diferida (B19). Si un admin de B pudiera borrar, o encolar, lo de
// A, la pared de la capa estaría rota justo donde el daño no tiene vuelta.
//
// Se siembra un caso marcador en A con el rol dueño —sin adjuntos: nunca se usa
// un caso real— y se intenta borrar desde el contexto de B. Tiene que devolver
// `[]`, el marcador tiene que seguir ahí y la cola no puede tener una fila de ese
// caso. La limpieza corre siempre. Escribe, así que sólo corre en CI (ensayo) o
// con `--escribe`: con el `.env.local` de un desarrollador el dueño es producción.
console.log("\n▸ Borrar el caso del inquilino de al lado");
if (conDatos.length < 2) {
  console.log("     (hace falta un segundo inquilino: se saltea)");
} else if (!escribe) {
  console.log("     (escribe un caso marcador: sólo corre en CI o con --escribe contra el ensayo)");
} else if (vetoDeEscritura) {
  mal(`no se escribe: ${vetoDeEscritura}`);
} else {
  const otro = conDatos[1];
  const marca = `PRUEBA-BORRADO-${a.id.slice(0, 8)}`;
  const dueno = new Pool({ connectionString: process.env.DATABASE_URL?.trim() });
  try {
    const { rows } = await dueno.query(
      `INSERT INTO cases (tenant_id, policy_number, status, channel)
       VALUES ($1, $2, 'recibido', 'email_sim') RETURNING id::text AS id`,
      [a.id, marca]
    );
    const marcador: string = rows[0].id;

    const borrados = await deleteCases(ctxDe(otro), [marcador], {
      id: "00000000-0000-0000-0000-000000000000",
      role: "admin",
    });
    const sigue = await dueno.query(`SELECT 1 FROM cases WHERE id = $1`, [marcador]);
    const encolados = await dueno.query(`SELECT 1 FROM adjuntos_por_purgar WHERE case_id = $1`, [marcador]);

    if (borrados.length > 0 || sigue.rowCount !== 1) {
      mal(`un admin de "${otro.name}" pudo borrar el caso de "${a.name}"`);
      problemas.push("deleteCases borra casos de otro inquilino");
    } else {
      bien(`desde "${otro.name}", borrar el caso de "${a.name}" devuelve [] y el caso sigue ahí`);
    }
    if (encolados.rowCount !== 0) {
      mal(`el intento dejó ${encolados.rowCount} fila(s) en la cola de purga de adjuntos`);
      problemas.push("deleteCases encola adjuntos de otro inquilino");
    } else {
      bien("y no deja nada en la cola de purga de adjuntos");
    }
  } finally {
    await dueno.query(`DELETE FROM cases WHERE policy_number = $1 AND tenant_id = $2`, [marca, a.id]);
    await dueno.end();
  }
}

// ── 6. El uso de IA suma en el acumulador del tablero ──────────────────────
//
// El tablero de /metricas lee `ai_usage_mensual` (0046), que mantiene un trigger
// SECURITY DEFINER de `ai_usage`. Ese trigger no corre contra un Postgres de
// verdad en ningún otro chequeo, y si falla, `recordUsage` traga el error: los
// tres topes de presupuesto dejarían de contar sin que nada lo avise. Se prueba
// por el camino de la app (`enTenant`, el rol sin BYPASSRLS), que es el que lo
// dispara:
//   · un INSERT de `ai_usage` entra y suma en el acumulador;
//   · `claimmix_app` no puede escribir el acumulador directo;
//   · al borrar al usuario, la cascada —que corre sin inquilino en la sesión—
//     pasa su uso a `user_id` nulo sin romper el borrado.
//
// El modelo marcador aísla la prueba del uso real del inquilino, y la persona es
// descartable: nunca se usa un usuario real. Escribe, así que sólo corre en CI
// (ensayo) o con `--escribe`. La limpieza corre al empezar y siempre al terminar.
console.log("\n▸ El uso de IA suma en el acumulador del tablero");
if (!escribe) {
  console.log("     (escribe uso de IA marcador: sólo corre en CI o con --escribe contra el ensayo)");
} else if (vetoDeEscritura) {
  mal(`no se escribe: ${vetoDeEscritura}`);
} else {
  const modelo = `prueba-capa-datos-${a.id.slice(0, 8)}`;
  const correo = `capa-datos.${a.id.slice(0, 8)}@capa-datos.invalid`;
  const dueno = new Pool({ connectionString: process.env.DATABASE_URL?.trim() });
  const limpiar = async () => {
    await dueno.query(`DELETE FROM ai_usage WHERE tenant_id = $1 AND model = $2`, [a.id, modelo]);
    await dueno.query(`DELETE FROM ai_usage_mensual WHERE tenant_id = $1 AND model = $2`, [a.id, modelo]);
    await dueno.query(`DELETE FROM "user" WHERE email = $1`, [correo]);
  };
  const acumulado = async () => {
    const [fila] = await enTenant(ctxDe(a), (db) =>
      db
        .select({
          calls: sql<number>`coalesce(sum(${tables.aiUsageMensual.calls}), 0)::int`,
          prompt: sql<number>`coalesce(sum(${tables.aiUsageMensual.prompt_tokens}), 0)::int`,
          completion: sql<number>`coalesce(sum(${tables.aiUsageMensual.completion_tokens}), 0)::int`,
          costo: sql<string>`coalesce(sum(${tables.aiUsageMensual.cost_usd}), 0)::text`,
          conUsuario: sql<number>`count(*) filter (where ${tables.aiUsageMensual.user_id} is not null and ${tables.aiUsageMensual.calls} > 0)::int`,
        })
        .from(tables.aiUsageMensual)
        .where(eq(tables.aiUsageMensual.model, modelo))
    );
    return fila!;
  };
  const esperado = (f: Awaited<ReturnType<typeof acumulado>>) =>
    f.calls === 2 && f.prompt === 14 && f.completion === 6 && Number(f.costo) === 0.015;

  try {
    await limpiar();
    const { rows } = await dueno.query(
      `INSERT INTO "user" (name, email) VALUES ('Prueba capa de datos', $1) RETURNING id::text AS id`,
      [correo]
    );
    const persona: string = rows[0].id;
    await dueno.query(
      `INSERT INTO users (id, tenant_id, full_name, role) VALUES ($1, $2, 'Prueba capa de datos', 'viewer')`,
      [persona, a.id]
    );

    // 1. Dos INSERT por el camino de la app: el trigger tiene que sumarlos.
    let entro = true;
    try {
      for (const [prompt, completion, costo] of [[10, 4, "0.0100"], [4, 2, "0.0050"]] as const) {
        await enTenant(ctxDe(a), (db) =>
          db.insert(tables.aiUsage).values({
            tenant_id: a.id,
            user_id: persona,
            model: modelo,
            prompt_tokens: prompt,
            completion_tokens: completion,
            cost_usd: costo,
          })
        );
      }
    } catch (e) {
      entro = false;
      const codigo = codigoDe(e);
      mal(`un INSERT de ai_usage como claimmix_app falla (${codigo}): el trigger del acumulador está roto`);
      problemas.push("el INSERT de ai_usage falla por el trigger del acumulador");
    }

    if (entro) {
      const suma = await acumulado();
      if (esperado(suma) && suma.conUsuario > 0) {
        bien("dos INSERT de ai_usage suman 2 llamadas, 14 + 6 tokens y 0.015 USD en el acumulador");
      } else {
        mal(
          `el acumulador no suma lo que entró: ${suma.calls} llamada(s), ${suma.prompt} + ${suma.completion} tokens, ` +
            `${suma.costo} USD (esperaba 2, 14 + 6, 0.015)`
        );
        problemas.push("el trigger de ai_usage no suma en ai_usage_mensual");
      }

      // 2. El acumulador no se escribe desde la app: el trigger es su única puerta.
      const pasaron: string[] = [];
      const intentos: Array<[string, () => Promise<unknown>]> = [
        [
          "INSERT",
          () =>
            enTenant(ctxDe(a), (db) =>
              db
                .insert(tables.aiUsageMensual)
                .values({ tenant_id: a.id, mes: "2000-01-01", user_id: null, model: modelo, calls: 99 })
            ),
        ],
        [
          "UPDATE",
          () =>
            enTenant(ctxDe(a), (db) =>
              db.update(tables.aiUsageMensual).set({ calls: 99 }).where(eq(tables.aiUsageMensual.model, modelo))
            ),
        ],
        [
          "DELETE",
          () =>
            enTenant(ctxDe(a), (db) =>
              db.delete(tables.aiUsageMensual).where(eq(tables.aiUsageMensual.model, modelo))
            ),
        ],
      ];
      for (const [verbo, intento] of intentos) {
        try {
          await intento();
          pasaron.push(verbo);
        } catch {
          // Lo esperado: el rol no tiene el permiso.
        }
      }
      if (pasaron.length > 0) {
        mal(`claimmix_app pudo hacer ${pasaron.join(", ")} directo sobre ai_usage_mensual`);
        problemas.push("la app puede escribir ai_usage_mensual directo");
      } else {
        bien("claimmix_app no puede hacer INSERT, UPDATE ni DELETE directo sobre ai_usage_mensual");
      }

      // 3. Borrar al usuario: la cascada pasa su uso a `user_id` nulo, sin romper.
      let borrado = true;
      try {
        await dueno.query(`DELETE FROM "user" WHERE id = $1`, [persona]);
      } catch (e) {
        borrado = false;
        const codigo = codigoDe(e);
        mal(`borrar a un usuario con uso de IA falla (${codigo}): el trigger rompe la cascada`);
        problemas.push("borrar un usuario con uso de IA falla por el trigger del acumulador");
      }
      if (borrado) {
        const tras = await acumulado();
        const huerfanas = await dueno.query(
          `SELECT count(*)::int AS n FROM ai_usage WHERE tenant_id = $1 AND model = $2 AND user_id IS NULL`,
          [a.id, modelo]
        );
        if (esperado(tras) && tras.conUsuario === 0 && huerfanas.rows[0].n === 2) {
          bien("al borrar al usuario, su uso pasa a user_id nulo y el acumulador no pierde nada");
        } else {
          mal(
            `tras borrar al usuario el acumulador quedó en ${tras.calls} llamada(s), ${tras.prompt} + ${tras.completion} ` +
              `tokens, ${tras.conUsuario} fila(s) con usuario, ${huerfanas.rows[0].n} de ai_usage sin usuario (esperaba 2, 14 + 6, 0, 2)`
          );
          problemas.push("la cascada de users no pasa el uso de IA a user_id nulo en el acumulador");
        }
      }
    }
  } finally {
    try {
      await limpiar();
    } finally {
      await dueno.end();
    }
  }
}

// ── 7. El SSO, la purga de adjuntos, la retención y la revisión nocturna ───
//
// Cuatro piezas cuyo SQL —un upsert con CASE, un UPDATE con EXISTS, un UPDATE …
// FROM (VALUES …) y un INSERT … SELECT … ON CONFLICT— sólo tenía pruebas contra
// una base simulada: nunca corrió contra un Postgres. Acá corre:
//   · el PUT (CASE) y el PATCH (EXISTS) de /api/admin/sso con `claimmix_app`, que
//     tiene que poder leer `account` desde el UPDATE;
//   · la cola de purga con dos borrados del mismo objeto: manda el más nuevo, y
//     marcar uno cierra también los más viejos;
//   · la retención en `simular`: cuenta justo lo cerrado antes del corte;
//   · la revisión nocturna dos veces: la segunda no repite nada.
//
// Va en un inquilino descartable porque el upsert del SSO pisaría el de uno real.
// R2 es simulado: la prueba decide qué «se borró» y sólo marca filas propias, así
// que no toca ningún objeto. La retención nunca corre en `borrar`. La limpieza es
// por el id del inquilino y por sus dos correos, nada más. Y al arrancar barre lo
// que dejó, hace más de una hora, una corrida cancelada de esta misma sección (el
// CI cancela la corrida en curso). Escribe, así que sólo corre en CI (ensayo) o
// con `--escribe`; y si las secciones de arriba fallaron no escribe, porque el
// PATCH sin condiciones es un UPDATE sin WHERE que sólo RLS acota.
console.log("\n▸ SSO, purga de adjuntos, retención y revisión nocturna, contra Postgres");
if (!escribe) {
  console.log("     (crea un inquilino descartable: sólo corre en CI o con --escribe contra el ensayo)");
} else if (vetoDeEscritura) {
  mal(`no se escribe: ${vetoDeEscritura}`);
} else if (aislamientoRoto) {
  mal("no se escribe: el aislamiento ya falló más arriba");
} else {
  const MARCA = "Prueba capa de datos, sección 7 ·";
  const correosDe = (r: string) => [`capa-datos-7.${r}@example.com`, `capa-datos-7b.${r}@example.com`];
  const corrida = randomUUID();
  const r8 = corrida.slice(0, 8);
  const [correo, correoAjeno] = correosDe(r8);
  const dueno = new Pool({ connectionString: process.env.DATABASE_URL?.trim() });

  const limpiar = async (ids: string[], correos: string[]) => {
    await dueno.query(`DELETE FROM adjuntos_por_purgar WHERE tenant_id = ANY($1::uuid[])`, [ids]);
    await dueno.query(`DELETE FROM audit_log WHERE tenant_id = ANY($1::uuid[])`, [ids]);
    await dueno.query(`DELETE FROM "user" WHERE email = ANY($1::text[])`, [correos]);
    await dueno.query(`DELETE FROM tenants WHERE id = ANY($1::uuid[])`, [ids]);
  };
  const nuevaPersona = async (email: string): Promise<string> =>
    (
      await dueno.query(
        `INSERT INTO "user" (name, email) VALUES ('Prueba capa de datos', $1) RETURNING id::text AS id`,
        [email]
      )
    ).rows[0].id;
  const igual = (x: unknown, y: unknown) => JSON.stringify(x) === JSON.stringify(y);
  // Un error de la base no se imprime crudo: puede traer parámetros.
  const parte = async (nombre: string, cuerpo: () => Promise<string[]>) => {
    try {
      const errores = await cuerpo();
      if (errores.length === 0) {
        bien(nombre);
      } else {
        for (const e of errores) mal(`${nombre}: ${e}`);
        problemas.push(`${nombre}: no se comporta en Postgres como se espera`);
      }
    } catch (e) {
      mal(`${nombre}: falló (${codigoDe(e)})`);
      problemas.push(`${nombre}: falla contra Postgres`);
    }
  };

  let inquilino: string | null = null;
  try {
    const viejos = await dueno.query(
      `SELECT id::text AS id, contact_email AS correo FROM tenants
        WHERE name LIKE $1 AND contact_email LIKE 'capa-datos-7.%@example.com'
          AND created_at < now() - interval '1 hour'`,
      [`${MARCA} %`]
    );
    const sobras = (viejos.rows as Array<{ id: string; correo: string }>)
      .map((f) => ({ id: f.id, r: f.correo.slice("capa-datos-7.".length, f.correo.indexOf("@")) }))
      .filter((f) => /^[0-9a-f]{8}$/.test(f.r));
    if (sobras.length > 0) {
      await limpiar(
        sobras.map((f) => f.id),
        sobras.flatMap((f) => correosDe(f.r))
      );
      console.log(`     (se barrieron ${sobras.length} inquilino(s) descartable(s) de una corrida cortada)`);
    }

    inquilino = (
      await dueno.query(`INSERT INTO tenants (name, contact_email) VALUES ($1, $2) RETURNING id::text AS id`, [
        `${MARCA} ${corrida}`,
        correo,
      ])
    ).rows[0].id as string;
    const T = inquilino;
    const ctx = ctxDe({ id: T });

    // `persona` pide el SSO y tiene cuenta propia; `ajena` es una cuenta de SSO de otro usuario.
    const persona = await nuevaPersona(correo);
    const ajena = await nuevaPersona(correoAjeno);
    await dueno.query(
      `INSERT INTO users (id, tenant_id, full_name, role) VALUES ($1, $2, 'Prueba capa de datos', 'admin')`,
      [persona, T]
    );
    await dueno.query(
      `INSERT INTO account (account_id, provider_id, user_id) VALUES ($1, 'credential', $2), ($3, $4, $5)`,
      [`fake-cuenta-${r8}`, persona, `fake-sub-ajeno-${r8}`, proveedorDeSso(T), ajena]
    );

    await parte("el PUT y el PATCH de /api/admin/sso andan con claimmix_app", async () => {
      const errores: string[] = [];
      const esperar = (ok: boolean, que: string) => {
        if (!ok) errores.push(que);
      };
      const issuer = "https://idp.example.com";
      const dominio = `${r8}.capa-datos.example.com`;
      const put = async (client_id: string, cifrado: string | null, dom = dominio) =>
        (
          await enTenant(ctx, (db) =>
            guardarIdp(db, T, { issuer, client_id, dominio: dom, client_secret_cifrado: cifrado })
          )
        )[0];
      const patch = async (cambio: CambioDeEstadoSso) =>
        (await enTenant(ctx, (db) => cambiarEstadoSso(db, T, persona, cambio)))[0];
      const secreto = async () =>
        (await dueno.query(`SELECT client_secret_cifrado AS s FROM sso_settings WHERE tenant_id = $1`, [T])).rows[0]
          ?.s ?? null;

      let f = await put("fake-client-a", "fake-cifrado-1");
      esperar(
        f?.tiene_secreto === true && !f.activo && !f.exigir && f.dominio_verificado_en === null,
        "el primer PUT no dejó un IdP con secreto, apagado y sin verificar"
      );

      esperar((await patch({ activo: true })) === undefined, "prendió el SSO con el dominio sin verificar");

      // El DNS no se consulta acá: se marca como verificado, que es lo que deja POST.
      await enTenant(ctx, (db) =>
        db
          .update(tables.ssoSettings)
          .set({ dominio_verificado_en: new Date().toISOString() })
          .where(eq(tables.ssoSettings.tenant_id, T))
      );

      f = await put("fake-client-a", null);
      esperar(
        f?.dominio_verificado_en !== null && (await secreto()) === "fake-cifrado-1",
        "guardar el mismo IdP sin secreto perdió la verificación o el secreto"
      );

      f = await patch({ activo: true });
      esperar(f?.activo === true, "no prendió el SSO con la config completa y el dominio verificado");

      esperar(
        (await patch({ exigir: true })) === undefined,
        "exigió SSO sin que quien lo pide hubiera entrado por él (la cuenta de SSO era de otro usuario)"
      );

      await dueno.query(`INSERT INTO account (account_id, provider_id, user_id) VALUES ($1, $2, $3)`, [
        `fake-sub-${r8}`,
        proveedorDeSso(T),
        persona,
      ]);
      f = await patch({ exigir: true });
      esperar(
        f?.exigir === true && f.activo === true,
        "no exigió SSO con su propia cuenta de SSO: el EXISTS no lee account con claimmix_app"
      );

      f = await put("fake-client-b", null);
      esperar(
        f?.tiene_secreto === false &&
          (await secreto()) === null &&
          f.dominio_verificado_en !== null &&
          !f.activo &&
          !f.exigir,
        "cambiar de client_id sin secreto nuevo no descartó el viejo, o no apagó el SSO, o perdió la verificación"
      );

      esperar((await patch({ activo: true })) === undefined, "prendió el SSO sin secreto");

      await put("fake-client-b", "fake-cifrado-2");
      f = await patch({ activo: true, exigir: true });
      esperar(f?.activo === true && f.exigir === true, "no prendió y exigió el SSO de una vez con todo en orden");

      f = await patch({ activo: false });
      esperar(f?.activo === false && f.exigir === false, "apagar el SSO no apagó también «exigir»");

      f = await put("fake-client-b", null, `otro.${dominio}`);
      esperar(
        f?.dominio_verificado_en === null && f.tiene_secreto === true && (await secreto()) === "fake-cifrado-2",
        "cambiar de dominio no pidió verificar de nuevo, o perdió el secreto del mismo IdP"
      );
      return errores;
    });

    await parte("la cola de purga con dos borrados del mismo objeto (R2 simulado)", async () => {
      const errores: string[] = [];
      const esperar = (ok: boolean, que: string) => {
        if (!ok) errores.push(que);
      };
      const base = `prueba-capa-datos/${corrida}`;
      const P = {
        compartido: `${base}/compartido.txt`,
        vivo: `${base}/vivo.txt`,
        falla: `${base}/falla.txt`,
        cancelado: `${base}/cancelado.txt`,
      };
      // Un adjunto por path a la vez: lo que se borra primero se va con su caso, y el siguiente reusa el path.
      const casoCon = async (path: string): Promise<string> => {
        const { rows } = await dueno.query(
          `INSERT INTO cases (tenant_id, policy_number, status, channel)
           VALUES ($1, $2, 'recibido', 'email_sim') RETURNING id::text AS id`,
          [T, `PRUEBA-PURGA-${r8}`]
        );
        await dueno.query(
          `INSERT INTO claim_attachments (tenant_id, case_id, file_name, content_type, size_bytes, storage_path)
           VALUES ($1, $2, 'fake-adjunto.txt', 'text/plain', 1, $3)`,
          [T, rows[0].id, path]
        );
        return rows[0].id;
      };
      const borrar = async (id: string) => {
        const borrados = await deleteCases(ctx, [id], { id: persona, role: "admin" });
        esperar(borrados.length === 1, "deleteCases no borró el caso de prueba");
      };

      type FilaDeLaCola = {
        id: string;
        case_id: string;
        storage_path: string;
        purgado_en: string | null;
        intentos: number;
        ultimo_error: string | null;
      };
      const cola = async (): Promise<FilaDeLaCola[]> =>
        (
          await dueno.query(
            `SELECT id::text AS id, case_id::text AS case_id, storage_path, purgado_en::text AS purgado_en,
                    intentos::int AS intentos, ultimo_error
               FROM adjuntos_por_purgar WHERE tenant_id = $1 ORDER BY encolado_en, storage_path`,
            [T]
          )
        ).rows;
      const de = (filas: FilaDeLaCola[], path: string) => filas.filter((f) => f.storage_path === path);

      // La purga barre todos los inquilinos: se miran y se marcan sólo las filas de éste.
      const propias = async () => (await vencidosDeLaPurga()).filter((p) => p.tenant_id === T);
      const pasada = async (): Promise<Pendiente[]> => {
        const filas = await propias();
        if (filas.length > 0) {
          await marcarPurga(
            filas.map((p) => ({ id: p.id, ok: p.storage_path !== P.falla, storage_path: p.storage_path }))
          );
        }
        return filas;
      };

      const c1 = await casoCon(P.compartido);
      await borrar(c1);
      const c2 = await casoCon(P.compartido);
      await borrar(c2);
      await borrar(await casoCon(P.vivo));
      await casoCon(P.vivo);
      await borrar(await casoCon(P.falla));
      await borrar(await casoCon(P.cancelado));

      const encolado = await cola();
      esperar(
        encolado.length === 5 && igual(de(encolado, P.compartido).map((f) => f.case_id), [c1, c2]),
        `la cola quedó con ${encolado.length} fila(s) (esperaba 5: dos del objeto compartido, una por cada otro)`
      );

      // Todo vencido hace mucho, menos la purga cancelada (`purgar_despues` nulo).
      await dueno.query(
        `UPDATE adjuntos_por_purgar
            SET purgar_despues = CASE WHEN storage_path = $2 THEN NULL ELSE '2000-01-01T00:00:00Z'::timestamptz END
          WHERE tenant_id = $1`,
        [T, P.cancelado]
      );

      const p1 = await pasada();
      esperar(
        p1.length === 2 &&
          igual(p1.map((p) => p.storage_path).sort(), [P.compartido, P.falla].sort()) &&
          p1.find((p) => p.storage_path === P.compartido)?.case_id === c2,
        "la primera pasada no eligió justo el objeto compartido (por su borrado más nuevo) y el que falla"
      );
      const tras1 = await cola();
      esperar(
        de(tras1, P.compartido).every((f) => f.purgado_en !== null),
        "marcar el objeto compartido no cerró también el borrado más viejo del mismo path"
      );
      const falla = de(tras1, P.falla)[0];
      esperar(
        falla?.purgado_en === null && falla.intentos === 1 && falla.ultimo_error === "no se pudo borrar el objeto en R2",
        "un borrado fallido no sumó un intento con su causa, o se dio por purgado"
      );
      esperar(
        [P.vivo, P.cancelado].every((p) => de(tras1, p).every((f) => f.purgado_en === null && f.intentos === 0)),
        "la pasada tocó un objeto que un adjunto vivo apunta, o una purga cancelada"
      );

      await marcarPurga([{ id: de(tras1, P.compartido)[1].id, ok: true, storage_path: P.compartido }]);
      esperar(igual(await cola(), tras1), "marcar de nuevo un objeto ya purgado cambió la cola");

      const p2 = await pasada();
      esperar(
        p2.length === 1 && p2[0].storage_path === P.falla && de(await cola(), P.falla)[0]?.intentos === 2,
        "la segunda pasada no eligió sólo al que falló, o no le sumó otro intento"
      );

      await dueno.query(`UPDATE adjuntos_por_purgar SET intentos = 5 WHERE tenant_id = $1 AND storage_path = $2`, [
        T,
        P.falla,
      ]);
      esperar((await propias()).length === 0, "una fila con cinco intentos siguió entrando a la purga");
      return errores;
    });

    await parte("la retención en «simular» cuenta justo lo cerrado antes del corte", async () => {
      const errores: string[] = [];
      const esperar = (ok: boolean, que: string) => {
        if (!ok) errores.push(que);
      };
      // Un corte al azar en 1971: nada real cierra ahí, y dos corridas a la par no se pisan.
      const corte = new Date(Date.UTC(1971, 0, 1) + randomInt(360 * 86_400_000));
      const despues = new Date(corte.getTime() + 1);
      const marca = `PRUEBA-RETENCION-${r8}`;
      // `no_relevante` no es un estado cerrado: no cuenta aunque tenga `closed_at`.
      for (const [estado, cierre] of [
        ["cerrado", corte],
        ["rechazado", corte],
        ["no_relevante", corte],
        ["pagado", despues],
      ] as const) {
        await dueno.query(
          `INSERT INTO cases (tenant_id, policy_number, status, channel, closed_at)
           VALUES ($1, $2, $3, 'email_sim', $4::timestamptz)`,
          [T, marca, estado, cierre.toISOString()]
        );
      }
      // El corte de la retención es `ahora` menos los años: se le da un `ahora` que lo deje justo en `c`.
      const ahoraPara = (c: Date) => {
        const d = new Date(c);
        d.setUTCFullYear(d.getUTCFullYear() + 5);
        return d;
      };

      const [modoPrevio, aniosPrevio] = [process.env.RETENCION_MODO, process.env.RETENCION_ANIOS];
      process.env.RETENCION_MODO = "simular"; // nunca «borrar»
      process.env.RETENCION_ANIOS = "5";
      let r1: Awaited<ReturnType<typeof aplicarRetencion>>;
      let r2: Awaited<ReturnType<typeof aplicarRetencion>>;
      try {
        const hasta = Date.now() + 120_000;
        r1 = await aplicarRetencion({ hasta }, ahoraPara(corte));
        r2 = await aplicarRetencion({ hasta }, ahoraPara(despues));
      } finally {
        if (modoPrevio === undefined) delete process.env.RETENCION_MODO;
        else process.env.RETENCION_MODO = modoPrevio;
        if (aniosPrevio === undefined) delete process.env.RETENCION_ANIOS;
        else process.env.RETENCION_ANIOS = aniosPrevio;
      }

      if (!r1 || !r2) {
        errores.push("la retención devolvió nulo con RETENCION_MODO=simular: no corrió");
        return errores;
      }
      esperar(
        r1.modo === "simular" && r2.modo === "simular" && r1.borrados === 0 && r2.borrados === 0,
        "la retención en «simular» no estaba en «simular» o borró algo"
      );
      esperar(
        r1.corte === corte.toISOString() && r2.corte === despues.toISOString(),
        "el corte de la retención no es el que se pidió"
      );
      esperar(
        r2.candidatos - r1.candidatos === 2,
        `mover el corte 1 ms sumó ${r2.candidatos - r1.candidatos} candidato(s) (esperaba 2: el cerrado y el rechazado de justo el corte)`
      );
      const quedan = await dueno.query(`SELECT count(*)::int AS n FROM cases WHERE tenant_id = $1 AND policy_number = $2`, [
        T,
        marca,
      ]);
      esperar(quedan.rows[0].n === 4, `en «simular» quedaron ${quedan.rows[0].n} de los 4 casos de prueba`);
      return errores;
    });

    await parte("la revisión nocturna corre entera y no repite", async () => {
      const errores: string[] = [];
      const esperar = (ok: boolean, que: string) => {
        if (!ok) errores.push(que);
      };
      const marca = `PRUEBA-DESVIOS-${r8}`;
      // Todos con el plazo vencido en 2001: sólo el abierto y de un canal real es un desvío.
      const sembrar = async (estado: string, canal: string, cierre: string | null): Promise<string> =>
        (
          await dueno.query(
            `INSERT INTO cases (tenant_id, policy_number, status, channel, vence_en, vence_plazo, closed_at)
             VALUES ($1, $2, $3, $4, '2001-01-01T00:00:00Z', 'prueba', $5::timestamptz) RETURNING id::text AS id`,
            [T, marca, estado, canal, cierre]
          )
        ).rows[0].id;
      const vencido = await sembrar("escalado", "email", null);
      await sembrar("escalado", "email_sim", null);
      await sembrar("cerrado", "email", "2001-01-02T00:00:00Z");

      const desvios = async () =>
        (
          await dueno.query(
            `SELECT case_id::text AS caso, regla, ancla::text AS ancla FROM case_desvios WHERE tenant_id = $1 ORDER BY 1, 2, 3`,
            [T]
          )
        ).rows;
      // Sólo lo de este inquilino: la revisión barre todos, y el total no es de la prueba.
      const r1 = await revisarDesvios();
      const tras1 = await desvios();
      const r2 = await revisarDesvios();
      const tras2 = await desvios();

      const fallidas = [...new Set([...r1.fallidas, ...r2.fallidas])];
      esperar(
        fallidas.length === 0,
        `no corrieron las reglas ${fallidas.join(", ")} (el código está en el log, desvios.regla_fallo)`
      );
      esperar(
        tras1.length === 1 && tras1[0].caso === vencido && tras1[0].regla === "plazo_vencido",
        `la primera corrida dejó ${tras1.length} desvío(s) del inquilino (esperaba uno: plazo_vencido del caso abierto de un canal real)`
      );
      esperar(igual(tras2, tras1), "la segunda corrida cambió los desvíos: no es idempotente");
      return errores;
    });
  } catch (e) {
    mal(`la sección 7 no pudo prepararse (${codigoDe(e)})`);
    problemas.push("la sección 7 no pudo preparar su inquilino descartable");
  } finally {
    try {
      if (inquilino) await limpiar([inquilino], [correo, correoAjeno]);
    } finally {
      await dueno.end();
    }
  }
}

// ── Veredicto ──────────────────────────────────────────────────────────────
console.log("\n" + "─".repeat(70));
if (problemas.length === 0) {
  console.log("✓ La capa de datos aísla. Ninguna consulta lleva filtro por inquilino");
  console.log("  escrito a mano, y aun así nadie ve lo que no es suyo.");
  process.exit(0);
}
console.log(`✗ ${problemas.length} problema(s):`);
for (const p of problemas) console.log(`   · ${p}`);
process.exit(1);
