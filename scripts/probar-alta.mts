/**
 * `pnpm alta:probar` — ¿anda el alta en dos pasos, de punta a punta, en QA?
 *
 * Tres cosas, en este orden:
 *
 * 1. Le pregunta al despliegue de QA qué configuración tiene (`/api/health`), si el
 *    registro coincide con ella (`/registro`) y si rechaza un enlace sellado con
 *    otro secreto (`/alta/correo`).
 * 2. Recorre en este proceso los dos pasos del alta, con el código de la rama y la
 *    base de QA. Primero el enlace del correo (`crearCuentaDelEnlace`): la cuenta,
 *    el correo verificado y la sesión, y ni un espacio. Después el pedido del
 *    espacio (`crearEspacio`): el perfil, el número, la auditoría y los cupos por
 *    red. Y además el segundo uso del mismo enlace, el tope por red y un enlace
 *    de antes de separar los pasos, que abre sólo la cuenta.
 * 3. Barre lo que dejó. Siempre, también si algo falló.
 *
 * Escribe en la base de QA y en ninguna otra: la URL tiene que ser el origen de QA
 * y las dos cadenas pasan por la lista blanca de `motivoDeVetoDeBases("qa")`. Nunca
 * manda un correo: el remitente es falso y lo único que hace es dejar que
 * `marcarCorreoVerificado` marque la cuenta.
 *
 * Los logs de Actions son públicos: lo que sale por pantalla es un código de la
 * tabla cerrada de `scripts/lib/probar-alta-reglas.mts` y nada más. Ni banderas, ni
 * conteos, ni correos, ni ids, ni el enlace, ni la clave, ni las cadenas.
 *
 * Los módulos de verdad escriben en el logger, que sale por `console`: acá se les
 * apaga, y ellos se tragan los errores de la base y devuelven la ruta de «falla».
 * La causa no sale, así que cuando un paso termina en esa ruta se prueba la base
 * aparte (`baseContesta`): si no contesta, es `pasajero` (no se pudo probar); si
 * contesta, el paso falló con la base arriba y es `destino_inesperado`, que pone
 * rojo. Un defecto que rompe siempre ese paso no se confunde con un parpadeo.
 *
 * Lee de `process.env` CRON_SECRET, BETTER_AUTH_SECRET (el workflow lo genera),
 * QA_DATABASE_URL y QA_DATABASE_URL_APP (si faltan, de `.env.local`) y, si está,
 * GITHUB_SHA. Una corrida a la vez: toma un candado de la base.
 *
 *   pnpm alta:probar --url <url> [--corrida <hex6>] [--resultado <archivo>]
 *   pnpm alta:probar --url <url> --solo-barrer
 *
 * Sale con 0 si anduvo o no se pudo probar (un aviso), con 1 si el alta se rompió y
 * con 2 si se negó a correr.
 */
import { randomBytes } from "node:crypto";
import { writeFileSync } from "node:fs";
import { Pool, neonConfig, type PoolClient } from "@neondatabase/serverless";
import { codigoDe } from "../tests/e2e/base-de-ensayo";
import { leerDeEnvLocal } from "./lib/env-local.mjs";
import { endpointDe, esUrlDeQa, motivoDeVetoDeBases } from "./lib/hosts-vetados.mjs";
import { ROL_APP } from "./lib/permisos-por-perfil.mjs";
import {
  CUPOS_DE_LA_RED_DE_PRUEBA,
  CUPOS_ESPERADOS,
  LETRAS,
  PREFIJO_CORREO,
  PREFIJO_EMPRESA,
  clasificarError,
  codigoDeDestinoInesperado,
  compararContadores,
  correoDe,
  diagnosticarCierre,
  empresaDe,
  esCorrida,
  formatear,
  hallazgo,
  ipDe,
  leerSalud,
  margenDelTope,
  numeroDe,
  revisarEnlaceAjeno,
  revisarRegistro,
  topesDesdeBanderas,
  veredicto,
  veredictoDelBarrido,
  type CodigoDeHallazgo,
  type Hallazgo,
  type Letra,
} from "./lib/probar-alta-reglas.mjs";

process.on("uncaughtException", () => {
  console.log(formatear(hallazgo("error")));
  process.exit(1);
});

neonConfig.webSocketConstructor = globalThis.WebSocket as never;

type Fila = Record<string, unknown>;

/** Adónde deja el enlace del correo a quien acaba de crear la cuenta: al segundo paso. */
const DESTINO_DEL_ENLACE = "/alta";

/** Lo mismo que `DIA_MS` de `src/server/alta/cupo-por-ip.ts`. */
const DIA_MS = 24 * 60 * 60_000;
const DESTINO_DE_ALTA = "/bandeja?bienvenida=1";

/* ───── Lo que se lee y se rechaza, antes de importar o conectar nada ───── */

function rechazar(mensaje: string): never {
  console.error(`✖ ${mensaje}`);
  process.exit(2);
}

function exigir(valor: string | undefined, mensaje: string): string {
  if (!valor) rechazar(mensaje);
  return valor;
}

const argumento = (nombre: string): string | undefined => {
  const i = process.argv.indexOf(nombre);
  return i === -1 ? undefined : process.argv[i + 1];
};

function deEnvLocal(nombre: string): string | undefined {
  try {
    return leerDeEnvLocal(nombre) ?? undefined;
  } catch {
    return undefined;
  }
}

const usuarioDe = (cadena: string): string => {
  try {
    return decodeURIComponent(new URL(cadena).username);
  } catch {
    return "";
  }
};

const url = argumento("--url") ?? "";
const soloBarrer = process.argv.includes("--solo-barrer");
const archivoDeResultado = argumento("--resultado");

if (!esUrlDeQa(url)) rechazar("la URL no es el origen de QA");
if (process.argv.includes("--corrida") && !esCorrida(argumento("--corrida"))) {
  rechazar("--corrida tiene que ser un hexadecimal de seis dígitos");
}
const corrida = argumento("--corrida") ?? randomBytes(3).toString("hex");
const origen = new URL(url).origin;

const cron = soloBarrer ? "" : exigir(process.env.CRON_SECRET?.trim(), "falta CRON_SECRET");
if (!soloBarrer) exigir(process.env.BETTER_AUTH_SECRET?.trim(), "falta BETTER_AUTH_SECRET");

const dueno = exigir(process.env.QA_DATABASE_URL?.trim() || deEnvLocal("QA_DATABASE_URL"), "falta QA_DATABASE_URL");
const app = exigir(process.env.QA_DATABASE_URL_APP?.trim() || deEnvLocal("QA_DATABASE_URL_APP"), "falta QA_DATABASE_URL_APP");

for (const [nombre, cadena] of [
  ["QA_DATABASE_URL", dueno],
  ["QA_DATABASE_URL_APP", app],
] as const) {
  const motivo = motivoDeVetoDeBases("qa", cadena);
  if (motivo !== null) rechazar(`${nombre}: ${motivo}`);
}
if (endpointDe(dueno) !== endpointDe(app)) rechazar("las dos cadenas de QA no son del mismo endpoint");
if (usuarioDe(app) !== ROL_APP) rechazar(`QA_DATABASE_URL_APP tiene que entrar como ${ROL_APP}`);

/* ───── Lo que se encontró ───── */

const hallazgos: Hallazgo[] = [];

/** Se imprime en el momento: si la corrida se corta, lo ya visto queda en el log. Un código se cuenta una vez. */
function anotar(h: CodigoDeHallazgo | Hallazgo): void {
  const encontrado = typeof h === "string" ? hallazgo(h) : h;
  if (hallazgos.some((x) => x.codigo === encontrado.codigo)) return;
  hallazgos.push(encontrado);
  console.log(formatear(encontrado));
}

const COMO_HALLAZGO = { pasajero: "pasajero", pg: "error_pg", otro: "error" } as const;
const SQLSTATE = /^(?:[0-9]{2}|[PHFXZ][0-9A-Z])[0-9A-Z]{3}$/;

/** Un error de la base o de la red, como hallazgo. Nunca lleva su mensaje al log. */
function deError(e: unknown): Hallazgo {
  const codigo = codigoDe(e);
  const mensaje = e instanceof Error ? e.message : String(e);
  return hallazgo(COMO_HALLAZGO[clasificarError(SQLSTATE.test(codigo) ? codigo : undefined, `${codigo} ${mensaje}`)]);
}

/**
 * Apaga la consola de los módulos de verdad: escriben en el logger y los logs de
 * Actions son públicos. Lo que esta prueba imprime sale por `console.log`.
 */
function atajarLaConsola(): void {
  const nada = () => {};
  console.error = nada;
  console.warn = nada;
  console.info = nada;
  console.debug = nada;
}

/* ───── Lo que se pide al despliegue ───── */

async function pedir(ruta: string, init: RequestInit = {}): Promise<{ codigo: number; texto: string }> {
  try {
    const r = await fetch(new URL(ruta, origen), {
      redirect: "manual",
      cache: "no-store",
      signal: AbortSignal.timeout(15_000),
      ...init,
    });
    return { codigo: r.status, texto: await r.text() };
  } catch {
    return { codigo: 0, texto: "" };
  }
}

function comoJson(texto: string): unknown {
  try {
    return JSON.parse(texto);
  } catch {
    return null;
  }
}

const dormir = (ms: number) => new Promise<void>((listo) => setTimeout(listo, ms));

/** Sella con un secreto que el despliegue no tiene: ese enlace tiene que salir «vencido». */
function sellarConSecretoAjeno<D>(sellar: (datos: D) => string, datos: D): string {
  const propio = process.env.BETTER_AUTH_SECRET ?? "";
  process.env.BETTER_AUTH_SECRET = randomBytes(32).toString("hex");
  try {
    return sellar(datos);
  } finally {
    process.env.BETTER_AUTH_SECRET = propio;
  }
}

/* ───── La base: el candado y el barrido ───── */

const filas = async (c: PoolClient, texto: string, parametros?: unknown[]): Promise<Fila[]> =>
  (await c.query(texto, parametros)).rows as Fila[];

/** Una consulta con la cadena de la app: sus permisos son los que cuentan para los topes de bases y de MB. */
async function comoApp(texto: string): Promise<Fila[]> {
  const pool = new Pool({ connectionString: app });
  pool.on("error", () => {});
  try {
    return (await pool.query(texto)).rows as Fila[];
  } finally {
    await pool.end();
  }
}

/** ¿Contesta la base de la app ahora? Distingue un parpadeo de la red de un defecto cuando el módulo tragó la falla. */
async function baseContesta(): Promise<boolean> {
  try {
    await comoApp("select 1");
    return true;
  } catch {
    return false;
  }
}

/** Un destino que no se esperaba: `pasajero` sólo si el módulo tragó una falla y la base no contesta. */
async function destinoInesperado(destino: string) {
  return codigoDeDestinoInesperado(destino, await baseContesta());
}

/**
 * Una transacción con el candado de esta prueba. Es distinto del de las altas
 * (`claimmix_alta`, dentro de la función): una corrida a la vez, y la función
 * sigue serializando a las demás. Devuelve null si otra corrida lo tiene.
 */
async function tomarCandado(pool: Pool, espera: "180s" | "60s"): Promise<PoolClient | null> {
  const cliente = await pool.connect();
  cliente.on("error", () => {});
  try {
    await cliente.query("BEGIN");
    await cliente.query(`SET LOCAL lock_timeout = '${espera}'`);
    await cliente.query("SET LOCAL idle_in_transaction_session_timeout = '0'");
    await cliente.query("SELECT pg_advisory_xact_lock(hashtext('claimmix_alta_probar'))");
    return cliente;
  } catch (e) {
    cliente.release(true);
    if (codigoDe(e) === "55P03") return null;
    throw e;
  }
}

/** Los inquilinos de la prueba: el nombre con el prefijo Y el dueño con un correo de la prueba. */
const INQUILINOS_DE_LA_PRUEBA = `
  select t.id::text as id from public.tenants t
   where starts_with(t.name, $1)
     and exists (
       select 1 from public.users u join public."user" a on a.id = u.id
        where u.tenant_id = t.id and u.role = 'owner' and a.email like $2
     )`;

/**
 * Borra lo de la prueba y cuenta lo que queda. `corrida` limita a una corrida; sin
 * ella barre toda la familia (lo que dejó una corrida cortada). Los espacios
 * cuelgan de `tenants` con CASCADE (users, whatsapp_numeros) y las sesiones y
 * cuentas de `"user"`; la auditoría no tiene FK, se borra aparte.
 */
async function barrer(c: PoolClient, corrida: string | null): Promise<number> {
  const quien = corrida ? `${corrida}-` : "";
  const empresa = `${PREFIJO_EMPRESA}${quien}`;
  const correo = `${PREFIJO_CORREO}${quien}%@example.com`;

  const ids = (await filas(c, INQUILINOS_DE_LA_PRUEBA, [empresa, correo])).map((f) => String(f.id));
  if (ids.length > 0) {
    await c.query("delete from public.audit_log where tenant_id = any($1::uuid[])", [ids]);
    await c.query("delete from public.tenants where id = any($1::uuid[])", [ids]);
  }
  await c.query(`delete from public."user" where email like $1`, [correo]);
  await c.query("delete from public.rate_limit_counters where bucket_key ~ $1", [CUPOS_DE_LA_RED_DE_PRUEBA.source]);

  const [quedan] = await filas(
    c,
    `select (
       (select count(*) from (${INQUILINOS_DE_LA_PRUEBA}) q)
       + (select count(*) from public."user" where email like $2)
       + (select count(*) from public.rate_limit_counters where bucket_key ~ $3)
     )::int as n`,
    [PREFIJO_EMPRESA, `${PREFIJO_CORREO}%@example.com`, CUPOS_DE_LA_RED_DE_PRUEBA.source]
  );
  return Number(quedan?.n ?? 0);
}

/**
 * Barre con el candado en la mano y cierra la transacción. Si la conexión cayó,
 * abre otra, vuelve a tomar el candado (60 s) y barre de nuevo.
 */
async function barrerBajoCandado(pool: Pool, candado: PoolClient | null, corrida: string | null) {
  let cliente = candado;
  let error: "pasajero" | "pg" | "otro" | undefined;
  for (let intento = 0; intento < 2; intento++) {
    try {
      cliente ??= await tomarCandado(pool, "60s");
      if (!cliente) return veredictoDelBarrido({ candado: false, residuo: 0 });
      const residuo = await barrer(cliente, corrida);
      await cliente.query("COMMIT");
      cliente.release();
      return veredictoDelBarrido({ candado: true, residuo });
    } catch (e) {
      cliente?.release(true);
      cliente = null;
      const h = deError(e);
      error = h.codigo === "pasajero" ? "pasajero" : h.codigo === "error_pg" ? "pg" : "otro";
      if (error !== "pasajero") break;
    }
  }
  return veredictoDelBarrido({ candado: true, error, residuo: 0 });
}

async function barrerSolo(): Promise<void> {
  const pool = new Pool({ connectionString: dueno });
  pool.on("error", () => {});
  try {
    anotar((await barrerBajoCandado(pool, null, null)).hallazgo);
  } finally {
    await pool.end();
  }
}

/* ───── La prueba ───── */

async function probarTodo(): Promise<void> {
  process.env.DATABASE_URL = dueno;
  process.env.DATABASE_URL_APP = app;
  process.env.ADMIN_EMAILS = "";
  process.env.SIGNUP_ALLOWED_EMAILS = "";
  process.env.GOOGLE_CLIENT_ID = "";
  process.env.GOOGLE_CLIENT_SECRET = "";
  process.env.DEMO_TENANT_ID = "";
  process.env.GMAIL_TENANT_ID = "";
  process.env.ALTA_REMITENTE_CORREO = "alta-probar@example.com";
  process.env.ALTA_REMITENTE_REFRESH_TOKEN = "fake-refresh-token-alta-probar";
  process.env.GMAIL_CLIENT_ID = "fake-client-id-alta-probar";
  process.env.GMAIL_CLIENT_SECRET = "fake-client-secret-alta-probar";
  process.env.RATE_LIMIT_PROVIDER = "postgres";
  process.env.LOG_LEVEL = "error";
  process.env.BASE_POR_CLIENTE = "0";
  process.env.NEXT_PUBLIC_SITE_URL = origen;

  const cabecera = { headers: { authorization: `Bearer ${cron}` } };
  let respuesta = await pedir("/api/health", cabecera);
  if (![200, 503, 401].includes(respuesta.codigo)) {
    await dormir(5_000);
    respuesta = await pedir("/api/health", cabecera);
  }
  const salud = leerSalud(respuesta.codigo, comoJson(respuesta.texto), process.env.GITHUB_SHA);
  for (const h of salud.hallazgos) anotar(h);
  const banderas = salud.banderas;
  if (banderas === null) return;

  process.env.ALTA_AUTOMATICA = "1";
  Object.assign(process.env, topesDesdeBanderas(banderas));

  atajarLaConsola();
  const { altaAbierta } = await import("@/lib/auth/registro-permitido");
  const { diasDePrueba } = await import("@/lib/billing/plans");
  const { claveDeCupo } = await import("@/lib/rate-limit/clave");
  const { topeEntero } = await import("@/lib/topes");
  const { llegoAlAviso } = await import("@/server/alta/aviso-operador");
  const { topeGlobalDelDia } = await import("@/server/alta/crear-inquilino");
  const { topeDeBases, topeDeMb } = await import("@/server/alta/catalogo");
  const { conError, crearEspacio, SIN_ESPACIO } = await import("@/server/alta/crear-espacio");
  const { crearCuentaDelEnlace, YA_TENES_CUENTA } = await import("@/server/alta/cuenta-del-enlace");
  const { tomarCupoDeAlta } = await import("@/server/alta/cupo-por-ip");
  const { sellarToken } = await import("@/server/alta/token-de-registro");

  type Espacio = Awaited<ReturnType<typeof crearEspacio>>;

  /**
   * El primer paso: lo que hace quien abre el enlace del correo. Es el módulo de la
   * acción de `/alta/correo`, no una copia; acá sólo se arma la cabecera de la red.
   * De lo que pasó adentro se ve adónde sigue la persona y lo que quedó en la base.
   */
  const recorrerElEnlace = (crudo: string, password: string, ipDeOrigen: string): Promise<string> =>
    crearCuentaDelEnlace({
      token: crudo,
      clave: password,
      repetida: password,
      headerStore: new Headers({ "x-vercel-forwarded-for": ipDeOrigen }),
    });

  /** El segundo paso: lo que hace `crearMiEspacio` cuando la sesión ya se miró. */
  const pedirElEspacio = (userId: string, l: Letra): Promise<Espacio> =>
    crearEspacio({
      userId,
      empresa: empresaDe(corrida, l),
      whatsapp: numeroDe(corrida, l),
      terminos: true,
      numeroAutomatico: false,
      ip: ipDe(corrida, l),
    });

  const datosDe = (l: Letra) => ({ e: correoDe(corrida, l), nombre: "Prueba del alta", locale: "es-AR" as const });
  const claveAleatoria = () => randomBytes(18).toString("base64url");
  const ventanaDelDia = () => Math.floor(Date.now() / DIA_MS) * DIA_MS;

  /** Cuántas altas lleva el día contra el tope y el aviso al operador. */
  async function margenDeHoy(c: PoolClient): Promise<Hallazgo> {
    const [dia] = await filas(c, "select count(*)::int as n from public.tenants where autoalta and created_at > now() - interval '24 hours'");
    return margenDelTope(Number(dia?.n ?? 0), topeGlobalDelDia(), llegoAlAviso);
  }

  /** Por qué el pedido no dejó el espacio, o el cierre sin conteo que hay que diagnosticar. Null si lo dejó. */
  async function fallaDelEspacio(c: PoolClient, r: Espacio): Promise<CodigoDeHallazgo | "cierre_sin_conteo" | null> {
    if (r.alta) {
      if (r.alta.resultado !== "ok") return "resultado_inesperado";
      return r.destino === DESTINO_DE_ALTA ? null : "destino_inesperado";
    }
    if (r.destino === SIN_ESPACIO.ya_tiene_espacio) return "resultado_inesperado";
    if (r.destino !== SIN_ESPACIO.alta_cerrada) return destinoInesperado(r.destino);
    const margen = await margenDeHoy(c);
    return margen.codigo === "tope_lleno" || margen.codigo === "tope_0" ? margen.codigo : "cierre_sin_conteo";
  }

  /** Cuánto subió cada contador de la red: la suma de todas las ventanas de la clave, que no se mueve con el reloj. */
  async function leerCupos(c: PoolClient, ip: string): Promise<Record<string, number>> {
    const cupos: Record<string, number> = {};
    for (const ambito of ["auth:ip", "alta:ip"] as const) {
      const [f] = await filas(c, "select coalesce(sum(hits), 0)::int as n from public.rate_limit_counters where bucket_key = $1", [
        claveDeCupo(ambito, ip),
      ]);
      cupos[ambito] = Number(f?.n ?? 0);
    }
    return cupos;
  }

  /** Todo lo que la prueba pudo crear, contado: dos fotos iguales son que no se creó nada. */
  async function fotoDeLaPrueba(c: PoolClient): Promise<string> {
    const [f] = await filas(
      c,
      `select
         (select count(*)::int from public.tenants where starts_with(name, $1)) as inquilinos,
         (select count(*)::int from public."user" where email like $2) as cuentas,
         (select count(*)::int from public.users u join public."user" a on a.id = u.id where a.email like $2) as perfiles,
         (select count(*)::int from public.whatsapp_numeros n join public.tenants t on t.id = n.tenant_id where starts_with(t.name, $1)) as numeros,
         (select count(*)::int from public.audit_log l join public.tenants t on t.id = l.tenant_id where starts_with(t.name, $1)) as auditorias,
         (select count(*)::int from public.session s join public."user" a on a.id = s.user_id where a.email like $2) as sesiones`,
      [`${PREFIJO_EMPRESA}${corrida}-`, `${PREFIJO_CORREO}${corrida}-%@example.com`]
    );
    return JSON.stringify(f);
  }

  /**
   * Después del enlace hay cuenta, con el correo verificado y la sesión abierta, y
   * ni espacio, ni perfil, ni número. Devuelve el id de la cuenta si está todo bien;
   * si no, anota lo que falta y devuelve null.
   */
  async function comprobarCuenta(c: PoolClient, letra: Letra, bien: "enlace_ok" | "enlace_viejo_ok"): Promise<string | null> {
    const [f] = await filas(
      c,
      `select
         (select id::text from public."user" where email = $1) as id,
         (select email_verified from public."user" where email = $1) as verificado,
         (select count(*)::int from public.session s join public."user" a on a.id = s.user_id where a.email = $1) as sesiones,
         (select count(*)::int from public.users u join public."user" a on a.id = u.id where a.email = $1) as perfiles,
         (select count(*)::int from public.tenants where starts_with(name, $2)) as inquilinos,
         (select count(*)::int from public.whatsapp_numeros where numero_e164 = $3) as numeros`,
      [correoDe(corrida, letra), empresaDe(corrida, letra), numeroDe(corrida, letra)]
    );
    const id = typeof f?.id === "string" ? f.id : null;
    const fallas: CodigoDeHallazgo[] = [];
    if (id === null) fallas.push("destino_inesperado");
    else {
      if (f?.verificado !== true) fallas.push("correo_sin_verificar");
      if (Number(f?.sesiones) < 1) fallas.push("sin_sesion");
      if (Number(f?.perfiles) + Number(f?.inquilinos) + Number(f?.numeros) > 0) fallas.push("enlace_creo_espacio");
    }
    for (const falla of fallas) anotar(falla);
    if (fallas.length > 0) return null;
    anotar(bien);
    return id;
  }

  async function comprobarAlta(c: PoolClient, userId: string, tenantId: string, letra: Letra): Promise<void> {
    const ip = ipDe(corrida, letra);
    const [f] = await filas(
      c,
      `select
         (select count(*)::int from public.users where id = $1::uuid and role = 'owner' and tenant_id = $2::uuid) as perfil,
         (select count(*)::int from public.tenants
           where id = $2::uuid and name = $3 and autoalta and plan = 'piloto' and billing_status = 'trial'
             and abs(extract(epoch from (trial_ends_at - (now() + make_interval(days => $4::int))))) < 3600) as inquilino,
         (select count(*)::int from public.whatsapp_numeros where tenant_id = $2::uuid and numero_e164 = $5) as numero,
         (select count(*)::int from public.audit_log
           where tenant_id = $2::uuid and event_type = 'tenant.created' and payload->>'origen' = 'autoalta'
             and payload->>'numero_en_revision' = 'false' and host(ip) = $6) as auditoria`,
      [userId, tenantId, empresaDe(corrida, letra), diasDePrueba(), numeroDe(corrida, letra), ip]
    );
    const fallas: CodigoDeHallazgo[] = [];
    if (Number(f?.perfil) !== 1) fallas.push("sin_perfil_de_dueno");
    if (Number(f?.inquilino) !== 1) fallas.push("inquilino_mal_creado");
    if (Number(f?.numero) !== 1) fallas.push("sin_numero");
    if (Number(f?.auditoria) !== 1) fallas.push("sin_auditoria");
    for (const falla of fallas) anotar(falla);
    if (fallas.length === 0) anotar("alta_ok");
  }

  /** Por qué `alta_cerrada` vino sin conteos: falta la migración, un tope de la base, o fue un 23505. */
  async function diagnosticarElCierre(c: PoolClient) {
    const [a] = await filas(
      c,
      `select
         to_regprocedure('public.claimmix_crear_inquilino(uuid,uuid,text,text,integer,integer,inet)') is not null as funcion,
         (to_regclass('public.whatsapp_numeros') is not null and exists (
            select 1 from information_schema.columns
             where table_schema = 'public' and table_name = 'tenants' and column_name = 'autoalta'
         )) as objetos`
    );
    const [b] = await comoApp(
      `select
         (select count(*) from pg_database where datname ~ '^t_[0-9a-f]{32}$')::int as bases,
         (select coalesce(sum(pg_database_size(oid)), 0) from pg_database
           where not datistemplate and has_database_privilege(oid, 'CONNECT')) / 1048576 as mb`
    );
    return diagnosticarCierre({
      funcion: a?.funcion === true,
      objetos: a?.objetos === true,
      topeBases: topeDeBases(),
      bases: Number(b?.bases ?? 0),
      topeMb: topeDeMb(),
      mb: Number(b?.mb ?? 0),
    });
  }

  /**
   * Los dos pasos del alta y abrir otra vez el enlace, con lo que cada uno gasta de
   * los cupos de la red. Con `cierre_sin_conteo` no anota nada: lo decide quien llama.
   */
  async function altaEnDosPasos(c: PoolClient, letra: "g" | "r"): Promise<{ userId: string | null; cierreSinConteo: boolean }> {
    const ip = ipDe(corrida, letra);
    const antes = await leerCupos(c, ip);
    const enlace = sellarToken(datosDe(letra));
    const cupos: Hallazgo[] = [];
    const sinAlta = { userId: null, cierreSinConteo: false };

    // Primer paso: el enlace crea la cuenta y nada más.
    const primera = await recorrerElEnlace(enlace, claveAleatoria(), ip);
    if (primera !== DESTINO_DEL_ENLACE) {
      anotar(await destinoInesperado(primera));
      return sinAlta;
    }
    const userId = await comprobarCuenta(c, letra, "enlace_ok");
    if (userId === null) return sinAlta;
    cupos.push(compararContadores(antes, await leerCupos(c, ip), CUPOS_ESPERADOS.enlace));

    // Segundo paso: la persona dice que viene a dar de alta su empresa.
    const espacio = await pedirElEspacio(userId, letra);
    const falla = await fallaDelEspacio(c, espacio);
    if (falla === "cierre_sin_conteo") return { userId: null, cierreSinConteo: true };
    if (falla !== null || espacio.alta === undefined) {
      anotar(falla ?? "destino_inesperado");
      return sinAlta;
    }
    const { alta } = espacio;
    if (alta.creadas24h !== null && alta.tope !== null && llegoAlAviso(alta.creadas24h, alta.tope)) anotar("cerca_del_aviso");
    await comprobarAlta(c, userId, alta.tenantId, letra);
    cupos.push(compararContadores(antes, await leerCupos(c, ip), CUPOS_ESPERADOS.espacio));

    // Abrir otra vez el mismo enlace: la cuenta ya existe y no cambia nada.
    const foto = await fotoDeLaPrueba(c);
    const segunda = await recorrerElEnlace(enlace, claveAleatoria(), ip);
    if ((await fotoDeLaPrueba(c)) !== foto) anotar("segunda_vez_creo_algo");
    else anotar(segunda === YA_TENES_CUENTA ? "segunda_vez_ok" : await destinoInesperado(segunda));
    cupos.push(compararContadores(antes, await leerCupos(c, ip), CUPOS_ESPERADOS.enlaceOtraVez));

    anotar(cupos.find((h) => h.codigo !== "contadores_ok") ?? hallazgo("contadores_ok"));
    return { userId, cierreSinConteo: false };
  }

  /** Un cupo que no dejó un espacio se devuelve: pedir un espacio a quien ya tiene uno no gasta el cupo del día. */
  async function cupoDevuelto(c: PoolClient, userId: string): Promise<void> {
    const ventana = ventanaDelDia();
    const antes = await leerCupos(c, ipDe(corrida, "a"));

    const r = await pedirElEspacio(userId, "a");
    if (r.alta !== undefined) return anotar("resultado_inesperado");
    if (r.destino !== SIN_ESPACIO.ya_tiene_espacio) return anotar(await destinoInesperado(r.destino));

    if (ventanaDelDia() !== ventana) return anotar("contador_movido");
    const despues = await leerCupos(c, ipDe(corrida, "a"));
    anotar(compararContadores(antes, despues, { "alta:ip": 0 }).codigo === "contadores_ok" ? "cupo_devuelto" : "cupo_no_devuelto");
  }

  /** Con el cupo del día de la red lleno, pedir el espacio vuelve a /alta con «intentos» y no crea nada. */
  async function topePorRed(c: PoolClient): Promise<void> {
    const ip = ipDe(corrida, "b");
    const tope = topeEntero("ALTA_TOPE_IP_DIA");
    const antes = await leerCupos(c, ip);
    const ventana = ventanaDelDia();

    // La cuenta nace por el enlace, como en la vida real; el cupo se llena a mano.
    const destinoDelEnlace = await recorrerElEnlace(sellarToken(datosDe("b")), claveAleatoria(), ip);
    if (destinoDelEnlace !== DESTINO_DEL_ENLACE) return anotar(await destinoInesperado(destinoDelEnlace));
    const userId = await comprobarCuenta(c, "b", "enlace_ok");
    if (userId === null) return;

    const ventanas = new Set<number>();
    for (let i = 0; i < tope; i++) ventanas.add((await tomarCupoDeAlta(ip)).cupo.ventana);
    const r = await pedirElEspacio(userId, "b");
    if (ventanas.has(0)) return anotar("contador_sin_respuesta");
    if (ventanas.size > 1 || ventanaDelDia() !== ventana) return anotar("contador_movido");
    // El cupo está lleno: `crearInquilino` no corre, así que «falla» sólo puede venir del contador.
    if (r.destino === conError("falla")) return anotar("contador_sin_respuesta");

    const [f] = await filas(c, "select count(*)::int as perfiles from public.users where id = $1::uuid", [userId]);
    const cortado =
      r.destino === conError("intentos") &&
      r.alta === undefined &&
      Number(f?.perfiles) === 0 &&
      compararContadores(antes, await leerCupos(c, ip), { "alta:ip": tope + 1 }).codigo === "contadores_ok";
    anotar(cortado ? "tope_por_ip_ok" : "tope_por_ip_no_corta");
  }

  /**
   * Un enlace emitido antes de separar los pasos todavía lleva la empresa y el
   * número. Sellado con el secreto propio, abre como uno nuevo: la cuenta y nada más.
   */
  async function enlaceConFormaVieja(c: PoolClient): Promise<void> {
    const viejo = { ...datosDe("v"), empresa: empresaDe(corrida, "v"), numero: numeroDe(corrida, "v") };
    const destino = await recorrerElEnlace(sellarToken(viejo), claveAleatoria(), ipDe(corrida, "v"));
    if (destino !== DESTINO_DEL_ENLACE) return anotar(await destinoInesperado(destino));
    await comprobarCuenta(c, "v", "enlace_viejo_ok");
  }

  /** Un escenario que tira no frena a los demás. */
  async function escenario(trabajo: () => Promise<void>): Promise<void> {
    try {
      await trabajo();
    } catch (e) {
      anotar(deError(e));
    }
  }

  /* El despliegue: el formulario del registro y un enlace sellado con otro secreto. */
  const registro = await pedir("/registro");
  for (const h of revisarRegistro(registro.codigo, registro.texto, banderas)) anotar(h);
  const ajeno = await pedir(`/alta/correo?t=${encodeURIComponent(sellarConSecretoAjeno(sellarToken, datosDe("g")))}`);
  anotar(revisarEnlaceAjeno(ajeno.codigo, ajeno.texto));

  /* La base: una corrida a la vez, y el barrido pase lo que pase. */
  const pool = new Pool({ connectionString: dueno });
  pool.on("error", () => {});
  let candado: PoolClient | null = null;
  try {
    candado = await tomarCandado(pool, "180s");
    if (candado === null) return anotar("candado_ocupado");
    const c = candado;
    await barrer(c, null);

    try {
      const margen = await margenDeHoy(c);
      anotar(margen);
      if (margen.codigo !== "margen_ok") return;

      const numeros = (Object.keys(LETRAS) as Letra[]).map((l) => numeroDe(corrida, l));
      const [ocupados] = await filas(
        c,
        `select count(*)::int as n from public.whatsapp_numeros
          where regexp_replace(numero_e164, '^[+]549', '+54') = any (
                  array(select regexp_replace(x, '^[+]549', '+54') from unnest($1::text[]) as x)
                ) and estado <> 'baja'`,
        [numeros]
      );
      if (Number(ocupados?.n) > 0) return anotar("numero_ocupado");
    } catch (e) {
      const codigo = codigoDe(e);
      if (codigo === "42703" || codigo === "42P01" || codigo === "42883") return anotar("migracion_pendiente");
      throw e;
    }

    if (!altaAbierta(correoDe(corrida, "g"))) return anotar("alta_apagada");
    if (topeGlobalDelDia() === 0) return anotar("tope_0");

    let alta = { userId: null as string | null, cierreSinConteo: false };
    await escenario(async () => {
      alta = await altaEnDosPasos(c, "g");
      if (!alta.cierreSinConteo) return;
      const causa = await diagnosticarElCierre(c);
      if (causa !== "posible_23505") return anotar(causa);
      alta = await altaEnDosPasos(c, "r");
      if (alta.cierreSinConteo) anotar("alta_cerrada_sin_conteo");
    });

    const userId = alta.userId;
    if (userId !== null) {
      await escenario(() => cupoDevuelto(c, userId));
      await escenario(() => topePorRed(c));
    }
    await escenario(() => enlaceConFormaVieja(c));
  } catch (e) {
    anotar(deError(e));
  } finally {
    try {
      if (candado !== null) anotar((await barrerBajoCandado(pool, candado, corrida)).hallazgo);
    } finally {
      await pool.end();
    }
  }
}

try {
  await (soloBarrer ? barrerSolo() : probarTodo());
} catch (e) {
  anotar(deError(e));
}

const { resultado, salida } = veredicto(hallazgos);
if (!soloBarrer) console.log(`alta: resultado=${resultado} corrida=${corrida}`);
if (archivoDeResultado && !soloBarrer) writeFileSync(archivoDeResultado, resultado);
process.exit(salida);
