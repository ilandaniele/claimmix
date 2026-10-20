/**
 * `pnpm alta:probar` — ¿anda el alta por el enlace del correo, de punta a punta, en QA?
 *
 * Tres cosas, en este orden:
 *
 * 1. Le pregunta al despliegue de QA qué configuración tiene (`/api/health`), si el
 *    registro coincide con ella (`/registro`) y si rechaza un enlace sellado con
 *    otro secreto (`/alta/correo`).
 * 2. Recorre en este proceso la acción de `/alta/correo`, con el código de la rama
 *    y la base de QA: la cuenta, el correo verificado, el espacio, el número, la
 *    auditoría, la sesión, los cupos por red y el segundo uso del mismo enlace.
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
  PREFIJO_CORREO,
  PREFIJO_EMPRESA,
  clasificarError,
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

/** Las copias de `src/app/alta/correo/actions.ts`: `"use server"` no deja exportarlas. */
const YA_TENES_CUENTA = "/login?aviso=ya_tenes_cuenta";
const conMotivo = (enlace: string, e: "clave" | "distintas" | "intentos" | "falla") => `${enlace}&e=${e}`;

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

  const { APIError } = await import("better-auth/api");
  const { ipValida } = await import("@/lib/audit/log");
  const { auth } = await import("@/lib/auth");
  const { marcarCorreoVerificado } = await import("@/lib/auth/on-password-reset");
  const { altaAbierta, enAlta } = await import("@/lib/auth/registro-permitido");
  const { diasDePrueba } = await import("@/lib/billing/plans");
  const { claveDeCupo } = await import("@/lib/rate-limit/clave");
  const { clientIpFromHeaders, topePorIp } = await import("@/lib/rate-limit/index");
  const { topeEntero } = await import("@/lib/topes");
  const { llegoAlAviso } = await import("@/server/alta/aviso-operador");
  const { crearInquilino, topeDeBases, topeDeMb, topeGlobalDelDia } = await import("@/server/alta/crear-inquilino");
  const { soltarCupoDeAlta, tomarCupoDeAlta } = await import("@/server/alta/cupo-por-ip");
  const { conError, prepararEspacio, SIN_ESPACIO } = await import("@/server/alta/destinos");
  const { abrirToken, sellarToken } = await import("@/server/alta/token-de-registro");

  type AltaCreada = Awaited<ReturnType<typeof crearInquilino>>;
  type CupoDeAlta = Awaited<ReturnType<typeof tomarCupoDeAlta>>["cupo"];
  interface Recorrido {
    destino: string;
    userId: string | null;
    alta: AltaCreada | null;
    cupo: CupoDeAlta | null;
    error: unknown;
  }

  /**
   * La acción de `/alta/correo` (`destinoDelEnlace`), copiada línea a línea. Cambia
   * lo que no se puede correr fuera de un pedido de Next: la IP sale de una
   * cabecera armada acá, el aviso al operador pasa a ser un hallazgo, no hay logger
   * y los errores se guardan para clasificarlos. Un test ata el orden de las
   * llamadas al de la acción.
   */
  async function recorrerElEnlace(crudo: string, password: string, ipDeOrigen: string): Promise<Recorrido> {
    let userId: string | null = null;
    let error: unknown = null;
    const sin = (destino: string): Recorrido => ({ destino, userId, alta: null, cupo: null, error });

    const token = abrirToken(crudo);
    // Sin `t`, la pantalla dice «enlace vencido».
    if (!token) return sin("/alta/correo");
    const enlace = `/alta/correo?t=${crudo}`;

    if (!altaAbierta(token.e)) return sin("/login?error=registro_cerrado");

    const headerStore = new Headers({ "x-vercel-forwarded-for": ipDeOrigen });
    const ip = clientIpFromHeaders(headerStore);
    const porIp = await topePorIp(ip);
    if (!porIp.allowed) return sin(conMotivo(enlace, "intentos"));

    try {
      const creada = await enAlta("correo", () =>
        auth.api.signUpEmail({
          body: { name: token.nombre, email: token.e, password },
          // Sin cookies: la sesión se abre abajo, cuando la cuenta ya tiene el correo verificado.
          headers: new Headers(),
        })
      );
      userId = creada.user.id;
      const { internalAdapter } = await auth.$context;
      if (!(await internalAdapter.findUserById(userId))) return sin(YA_TENES_CUENTA);
    } catch (e) {
      const code = e instanceof APIError ? e.body?.code : undefined;
      if (code === "USER_ALREADY_EXISTS") return sin(YA_TENES_CUENTA);
      error = e;
      return sin(conMotivo(enlace, "falla"));
    }

    await marcarCorreoVerificado(userId);

    let alta: AltaCreada | null = null;
    const { clave, cupo } = await tomarCupoDeAlta(ip);
    const con = (destino: string): Recorrido => ({ destino, userId, alta, cupo, error });
    if (cupo.allowed) {
      try {
        alta = await crearInquilino({
          userId,
          empresa: token.empresa,
          numero: token.numero,
          ip: ipValida(ip),
        });
      } catch (e) {
        error = e;
      }
      if (alta === null || (alta.resultado !== "ok" && alta.resultado !== "ok_numero_en_revision")) {
        await soltarCupoDeAlta(clave, cupo.ventana);
      }
    }

    try {
      await auth.api.signInEmail({ body: { email: token.e, password }, headers: headerStore });
    } catch (e) {
      error = e;
      return con("/login");
    }

    // `ventana: 0` es que el contador no contestó: no hubo «demasiados intentos».
    if (!cupo.allowed) return con(conError(cupo.ventana === 0 ? "falla" : "intentos"));
    if (alta === null) return con(conError("falla"));
    if (alta.resultado !== "ok" && alta.resultado !== "ok_numero_en_revision") return con(SIN_ESPACIO[alta.resultado]);

    if (alta.creadas24h !== null && alta.tope !== null && llegoAlAviso(alta.creadas24h, alta.tope)) {
      anotar("cerca_del_aviso");
    }
    return con(await prepararEspacio(alta, DESTINO_DE_ALTA));
  }

  const datosDe = (l: Letra) => ({
    e: correoDe(corrida, l),
    empresa: empresaDe(corrida, l),
    numero: numeroDe(corrida, l),
    nombre: "Prueba del alta",
    locale: "es-AR" as const,
  });
  const claveAleatoria = () => randomBytes(18).toString("base64url");

  /** Por qué el recorrido no dejó el espacio: el hallazgo, o el cierre sin conteo que hay que diagnosticar. */
  function fallaDelRecorrido(r: Recorrido): CodigoDeHallazgo | "cierre_sin_conteo" | null {
    if (r.error !== null) return deError(r.error).codigo;
    if (r.cupo && !r.cupo.allowed && r.cupo.ventana === 0) return "contador_sin_respuesta";
    if (r.alta?.resultado === "alta_cerrada") return r.alta.creadas24h !== null ? "tope_lleno" : "cierre_sin_conteo";
    if (r.alta?.resultado === "no_verificado") return "correo_sin_verificar";
    if (r.alta && r.alta.resultado !== "ok") return "resultado_inesperado";
    return r.alta && r.destino === DESTINO_DE_ALTA ? null : "destino_inesperado";
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

  async function comprobarAlta(c: PoolClient, userId: string, tenantId: string, letra: Letra): Promise<void> {
    const ip = ipDe(corrida, letra);
    const [f] = await filas(
      c,
      `select
         (select email_verified from public."user" where id = $1::uuid) as verificado,
         (select count(*)::int from public.users where id = $1::uuid and role = 'owner' and tenant_id = $2::uuid) as perfil,
         (select count(*)::int from public.tenants
           where id = $2::uuid and name = $3 and autoalta and plan = 'piloto' and billing_status = 'trial'
             and abs(extract(epoch from (trial_ends_at - (now() + make_interval(days => $4::int))))) < 3600) as inquilino,
         (select count(*)::int from public.whatsapp_numeros where tenant_id = $2::uuid and numero_e164 = $5) as numero,
         (select count(*)::int from public.audit_log
           where tenant_id = $2::uuid and event_type = 'tenant.created' and payload->>'origen' = 'autoalta'
             and payload->>'numero_en_revision' = 'false' and host(ip) = $6) as auditoria,
         (select count(*)::int from public.session where user_id = $1::uuid) as sesiones`,
      [userId, tenantId, empresaDe(corrida, letra), diasDePrueba(), numeroDe(corrida, letra), ip]
    );
    const antes = hallazgos.length;
    if (f?.verificado !== true) anotar("correo_sin_verificar");
    if (Number(f?.perfil) !== 1) anotar("sin_perfil_de_dueno");
    if (Number(f?.inquilino) !== 1) anotar("inquilino_mal_creado");
    if (Number(f?.numero) !== 1) anotar("sin_numero");
    if (Number(f?.auditoria) !== 1) anotar("sin_auditoria");
    if (Number(f?.sesiones) < 1) anotar("sin_sesion");
    if (hallazgos.length === antes) anotar("alta_ok");
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

  /** El alta por el enlace, y abrirlo otra vez. Con `cierre_sin_conteo` no anota nada: lo decide quien llama. */
  async function altaPorElEnlace(c: PoolClient, letra: "g" | "r"): Promise<{ userId: string | null; cierreSinConteo: boolean }> {
    const ip = ipDe(corrida, letra);
    const antes = await leerCupos(c, ip);
    const enlace = sellarToken(datosDe(letra));

    const primera = await recorrerElEnlace(enlace, claveAleatoria(), ip);
    const falla = fallaDelRecorrido(primera);
    if (falla === "cierre_sin_conteo") return { userId: null, cierreSinConteo: true };
    const { alta, userId } = primera;
    if (falla !== null || alta === null || userId === null) {
      anotar(falla ?? "destino_inesperado");
      return { userId: null, cierreSinConteo: false };
    }

    await comprobarAlta(c, userId, alta.tenantId, letra);
    const despuesDeLaPrimera = await leerCupos(c, ip);
    const delPrimero = compararContadores(antes, despuesDeLaPrimera, { "auth:ip": 1, "alta:ip": 1 });

    const foto = await fotoDeLaPrueba(c);
    const segunda = await recorrerElEnlace(enlace, claveAleatoria(), ip);
    if ((await fotoDeLaPrueba(c)) !== foto) anotar("segunda_vez_creo_algo");
    else if (segunda.error !== null) anotar(deError(segunda.error));
    else anotar(segunda.destino === YA_TENES_CUENTA ? "segunda_vez_ok" : "destino_inesperado");

    const delSegundo = compararContadores(antes, await leerCupos(c, ip), { "auth:ip": 2, "alta:ip": 1 });
    anotar(delPrimero.codigo === "contadores_ok" ? delSegundo : delPrimero);
    return { userId, cierreSinConteo: false };
  }

  /** Un cupo que no dejó un espacio se devuelve: pedir un espacio a quien ya tiene uno no gasta el cupo del día. */
  async function cupoDevuelto(c: PoolClient, userId: string): Promise<void> {
    const ip = ipDe(corrida, "a");
    const antes = await leerCupos(c, ip);
    const { clave, cupo } = await tomarCupoDeAlta(ip);
    if (!cupo.allowed) return anotar(cupo.ventana === 0 ? "contador_sin_respuesta" : "cupos_mal_contados");

    try {
      const alta = await crearInquilino({
        userId,
        empresa: empresaDe(corrida, "a"),
        numero: numeroDe(corrida, "a"),
        ip: ipValida(ip),
      });
      if (alta.resultado !== "ya_tiene_espacio") anotar("resultado_inesperado");
    } finally {
      await soltarCupoDeAlta(clave, cupo.ventana);
    }

    if (cupo.ventana !== Math.floor(Date.now() / DIA_MS) * DIA_MS) return anotar("contador_movido");
    const despues = await leerCupos(c, ip);
    anotar(compararContadores(antes, despues, { "alta:ip": 0 }).codigo === "contadores_ok" ? "cupo_devuelto" : "cupo_no_devuelto");
  }

  /** Con el cupo del día de la red lleno, el enlace deja la cuenta con sesión pero sin espacio. */
  async function topePorRed(c: PoolClient): Promise<void> {
    const ip = ipDe(corrida, "b");
    const tope = topeEntero("ALTA_TOPE_IP_DIA");
    const antes = await leerCupos(c, ip);

    const ventanas = new Set<number>();
    for (let i = 0; i < tope; i++) ventanas.add((await tomarCupoDeAlta(ip)).cupo.ventana);

    const r = await recorrerElEnlace(sellarToken(datosDe("b")), claveAleatoria(), ip);
    if (r.error !== null) return anotar(deError(r.error));
    ventanas.add(r.cupo?.ventana ?? 0);
    if (ventanas.has(0)) return anotar("contador_sin_respuesta");
    if (ventanas.size > 1) return anotar("contador_movido");

    const [f] = await filas(
      c,
      `select
         (select email_verified from public."user" where email = $1) as verificado,
         (select count(*)::int from public.session s join public."user" a on a.id = s.user_id where a.email = $1) as sesiones,
         (select count(*)::int from public.users u join public."user" a on a.id = u.id where a.email = $1) as perfiles`,
      [correoDe(corrida, "b")]
    );
    if (f?.verificado !== true) anotar("correo_sin_verificar");
    if (Number(f?.sesiones) < 1) anotar("sin_sesion");

    const cortado =
      r.destino === conError("intentos") &&
      r.alta === null &&
      Number(f?.perfiles) === 0 &&
      compararContadores(antes, await leerCupos(c, ip), { "alta:ip": tope + 1 }).codigo === "contadores_ok";
    anotar(cortado ? "tope_por_ip_ok" : "tope_por_ip_no_corta");
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
      const [dia] = await filas(c, "select count(*)::int as n from public.tenants where autoalta and created_at > now() - interval '24 hours'");
      const margen = margenDelTope(Number(dia?.n ?? 0), topeGlobalDelDia(), llegoAlAviso);
      anotar(margen);
      if (margen.codigo !== "margen_ok") return;

      const numeros = (["g", "a", "b", "r"] as const).map((l) => numeroDe(corrida, l));
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
      alta = await altaPorElEnlace(c, "g");
      if (!alta.cierreSinConteo) return;
      const causa = await diagnosticarElCierre(c);
      if (causa !== "posible_23505") return anotar(causa);
      alta = await altaPorElEnlace(c, "r");
      if (alta.cierreSinConteo) anotar("alta_cerrada_sin_conteo");
    });

    const userId = alta.userId;
    if (userId === null) return;
    await escenario(() => cupoDevuelto(c, userId));
    await escenario(() => topePorRed(c));
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
