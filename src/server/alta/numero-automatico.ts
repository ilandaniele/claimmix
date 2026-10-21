/**
 * El número de WhatsApp por código: de «pedí el SMS» a «tu WhatsApp está conectado».
 *
 * Es lo único que decide. `alta-de-numero.ts` habla con Graph, `numeros.ts` da el
 * token y la WABA, y la función SECURITY DEFINER de la 0049 es la única puerta con
 * la que la app escribe el `phone_number_id` y el estado 'conectado'. Acá se arma
 * el orden de los pasos, los topes y qué se devuelve a quien lo pidió:
 *
 *   - `pedirCodigo`: suma el número a la WABA de la plataforma (si no está) y
 *     le pide a Meta que mande el código por SMS o por llamada;
 *   - `verificarCodigo`: se lo entrega a Meta, registra el número y lo deja
 *     'conectado'.
 *
 * Con `BASE_POR_CLIENTE` el número vive en control: se lee y se escribe con
 * `enControl`, y cada paso que se guarda se espeja a la base del cliente (la copia
 * que lee /configuracion). El espejo nunca hace fallar el paso. Un número queda
 * 'conectado' sólo con su webhook propio puesto y leído de Graph: sin él, lo que le
 * escriban caería en el webhook de la WABA, que puede ser el de otro ambiente.
 *
 * Ninguna de las dos tira: lo inesperado vuelve como 'meta' y se anota. Todo caso
 * raro termina en 'revision' más un aviso al operador, que lo conecta a mano desde
 * /admin/altas o borra el número que sobre: nunca queda uno conectado a medias.
 * Sin la bandera (`numeroAutomatico()`) o sin la 0049 nada llama a Graph.
 *
 * Los cupos del código se devuelven sólo si Graph no se tocó: desde el primer
 * pedido (aunque sea el GET que cuenta los números de la WABA) se quedan gastados,
 * porque cada vuelta cuesta lo mismo contra los topes de Meta.
 *
 * Los cupos, las salidas y el webhook propio del número, que comparten otros caminos
 * del alta, viven en `pasos-del-numero.ts`.
 *
 * Lo que no sale de acá: el número de la plataforma (`idDeLaPlataforma()`) no se
 * toca ni se guarda en una fila, no se borra nada de la WABA, y ni el token, ni el
 * código de seis dígitos, ni el PIN llegan al registro, a la base o al resultado.
 * El nombre visible es el de la plataforma, leído de Graph; lo que tipeó el
 * cliente (empresa, número) no entra en ningún pedido salvo el número a sumar.
 */

import "server-only";

import { eq, ne, sql } from "drizzle-orm";
import { after } from "next/server.js";

import { enControl } from "@/data/scope";
import { pruebaVencida } from "@/lib/billing/plans";
import { filasDe } from "@/lib/db/filas";
import { tenants, whatsappNumeros } from "@/lib/db/schema";
import { ID_DE_META } from "@/lib/meta-ids";
import { nombreDelError } from "@/lib/observability/error-code";
import { logger } from "@/lib/observability/logger";
import { claveDeCupo } from "@/lib/rate-limit/clave";
import { topeEntero } from "@/lib/topes";
import { avisarNumeroEnRevision } from "@/server/alta/aviso-operador";
import { numeroAutomatico } from "@/server/alta/numero-automatico-activo";
import type { ResultadoDelNumero } from "@/server/alta/numero-resultados";
import {
  aRevision,
  cuposDePedirCodigo,
  cuposDeRegistrar,
  cuposDeVerificar,
  deFalla,
  DIA_MS,
  fijarElWebhook,
  HORA_MS,
  sinDueno,
  soltar,
  tomar,
  type Entorno,
  type Guardado,
  type QuienPide,
  type Tomado,
} from "@/server/alta/pasos-del-numero";
import { mismoNumero } from "@/server/alta/validar";
import { esNumeroDeOtroAmbiente } from "@/server/ambiente/de-otro-ambiente";
import { espejarSinFallar } from "@/server/bases/espejar-sin-fallar";
import { codigoPg } from "@/server/core-sync/config";
import {
  agregarNumero,
  CODIGO_DE_SEIS,
  codigoYaVerificado,
  numeroYaRegistrado,
  partirNumero,
  pedirCodigoAMeta,
  registrarNumero,
  verificarCodigoEnMeta,
  type MetodoDeCodigo,
} from "@/server/whatsapp/alta-de-numero";
import { credencialDelEntorno, idDeLaPlataforma, webhookDelEntorno } from "@/server/whatsapp/numeros";
import { recorrerLaWaba } from "@/server/whatsapp/verificar-en-meta";

export type { QuienPide };

/** Los topes del número automático, leídos del entorno cada vez (cada uno acotado, ver `topeEntero`). */
export function topesDelNumero() {
  return {
    /** Números en total de la WABA, el de la plataforma y cualquier estado incluidos. */
    numerosWaba: topeEntero("ALTA_NUMEROS_MAXIMOS_WABA"),
    /** Números nuevos por día, de todos los espacios juntos. */
    numerosDia: topeEntero("ALTA_TOPE_NUMEROS_DIA"),
    codigosInquilino: topeEntero("ALTA_TOPE_CODIGOS_INQUILINO_DIA"),
    codigosIp: topeEntero("ALTA_TOPE_CODIGOS_IP_DIA"),
    codigosDia: topeEntero("ALTA_TOPE_CODIGOS_DIA"),
    verificacionesHora: topeEntero("ALTA_TOPE_VERIFICACIONES_HORA"),
  };
}

type Topes = ReturnType<typeof topesDelNumero>;

/* ── La base ──────────────────────────────────────────────────────────────── */

/**
 * La fila del número del espacio y lo que decide si puede seguir, en una sola
 * consulta, contra control: la copia del cliente puede ir atrás. `funcion` dice si
 * la 0049 está aplicada. 42P01 y 42703 (la 0048 sin aplicar) cuentan como «sin fila».
 */
async function leerFila(tenantId: string) {
  try {
    const filas = await enControl({ tenantId }, (db) =>
      db
        .select({
          numero_e164: whatsappNumeros.numero_e164,
          estado: whatsappNumeros.estado,
          phone_number_id: whatsappNumeros.phone_number_id,
          billing_status: tenants.billing_status,
          trial_ends_at: tenants.trial_ends_at,
          autoalta: tenants.autoalta,
          funcion: sql<boolean>`to_regprocedure('public.claimmix_numero_automatico(uuid, uuid, text, text, text, text, inet)') is not null`,
        })
        .from(whatsappNumeros)
        .innerJoin(tenants, eq(tenants.id, whatsappNumeros.tenant_id))
        .where(ne(whatsappNumeros.estado, "baja"))
        .limit(1)
    );
    return filas[0] ?? null;
  } catch (e) {
    const codigo = codigoPg(e);
    if (codigo === "42P01" || codigo === "42703") return null;
    throw e;
  }
}

type Fila = NonNullable<Awaited<ReturnType<typeof leerFila>>>;

/** Por qué este espacio no puede pasar por acá, o null si puede. Casi todo lo vuelve a mirar la función de la 0049. */
function porQueNo(fila: Fila): string | null {
  if (fila.funcion !== true) return "sin_migracion";
  if (fila.autoalta !== true) return "no_es_alta_automatica";
  if (fila.billing_status !== "trial" && fila.billing_status !== "active") return "sin_servicio";
  if (pruebaVencida(fila, new Date())) return "prueba_vencida";
  if (fila.estado !== "pedido") return "estado";
  if (esNumeroDeOtroAmbiente(fila.phone_number_id ?? "", fila.numero_e164)) return "de_otro_ambiente";
  return null;
}

/**
 * ¿Hay todavía un número por conectar en este espacio? Para /preparando, que muestra
 * el panel sin tener la copia de /configuracion: la base del cliente aún no existe.
 *
 * Neutral hacia afuera (H3): sin fila devuelve lo mismo que «pedido», true. El pedido
 * de un número que pertenece a otro espacio no puede distinguirse de uno todavía sin
 * pedir; quien no puede seguir se entera al probar, y `filaHabilitada` avisa «sin_fila».
 * Acá no hay registro ni aviso: se llama en cada refresco. Si control no contesta,
 * false y callado: se espera sin formularios en vez de tirar la pantalla.
 */
export async function numeroPorConectar(tenantId: string): Promise<boolean> {
  try {
    const fila = await leerFila(tenantId);
    return fila === null || porQueNo(fila) === null;
  } catch {
    return false;
  }
}

/**
 * La fila del espacio si puede seguir; si no, null y el motivo queda en el registro.
 * Sin fila no hay nadie mirándolo (la pantalla ya dijo «lo revisamos»): se avisa.
 */
async function filaHabilitada(tenantId: string): Promise<Fila | null> {
  const fila = await leerFila(tenantId);
  const motivo = fila ? porQueNo(fila) : "sin_fila";
  if (!fila || motivo) {
    logger.info({ tenantId, motivo }, "alta.numero_automatico_no_aplica");
    if (!fila) after(() => avisarNumeroEnRevision("sin_fila", tenantId));
    else if (motivo === "de_otro_ambiente") after(() => avisarNumeroEnRevision("de_otro_ambiente", tenantId));
    return null;
  }
  return fila;
}

const GUARDADOS: ReadonlySet<string> = new Set<Guardado>([
  "ok",
  "no_aplica",
  "datos_invalidos",
  "id_de_la_plataforma",
  "id_ocupado",
  "sin_migracion",
  "error",
]);

/**
 * Escribe un paso con la función de la 0049: 'agregado' (el id que Graph dio) o
 * 'conectado'. Nunca tira: lo que no sea 'ok' lo decide quien llama. Un paso que
 * quedó en control se espeja a la base del cliente antes de contestar, porque es la
 * copia que lee la pantalla a la que vuelve la persona.
 */
async function guardarPaso(
  quien: QuienPide,
  paso: "agregado" | "conectado",
  phoneNumberId: string,
  wabaId: string,
  idPlataforma: string
): Promise<Guardado> {
  try {
    const filas = await enControl({ tenantId: quien.tenantId }, (db) =>
      db.execute(sql`
        select public.claimmix_numero_automatico(
          ${quien.tenantId}::uuid, ${quien.userId}::uuid, ${paso}::text, ${phoneNumberId}::text,
          ${wabaId}::text, ${idPlataforma}::text, ${quien.ip}::inet
        ) as r
      `)
    );
    const crudo = filasDe<{ r?: unknown }>(filas)[0]?.r;
    const r = (typeof crudo === "string" ? JSON.parse(crudo) : crudo) as { resultado?: unknown } | null | undefined;
    const resultado = r?.resultado;
    const guardado = typeof resultado === "string" && GUARDADOS.has(resultado) ? (resultado as Guardado) : "error";
    if (guardado === "ok") await espejarSinFallar(quien.tenantId);
    return guardado;
  } catch (e) {
    const codigo = codigoPg(e);
    if (codigo === "23505") return "id_ocupado";
    if (codigo === "42883" || codigo === "42P01" || codigo === "42703") return "sin_migracion";
    logger.error({ error: nombreDelError(e), codigo }, "alta.numero_automatico_guardado_fallo");
    return "error";
  }
}

/**
 * El token y la WABA de la plataforma, su número (que nunca se toca) y el webhook de
 * este ambiente. Null si falta algo; quien llama avisa. Sin webhook no se toca Graph:
 * un número sumado así quedaría en el de la WABA.
 */
function entornoDeMeta(): Entorno | null {
  const entorno = credencialDelEntorno();
  const plataforma = idDeLaPlataforma();
  const webhook = webhookDelEntorno();
  if (!entorno?.wabaId || !plataforma || !webhook) {
    logger.warn({}, "alta.numero_automatico_sin_credencial");
    return null;
  }
  return { cred: { accessToken: entorno.accessToken, wabaId: entorno.wabaId }, plataforma, webhook };
}

type Paso<T> = { ok: true; valor: T } | { ok: false; resultado: ResultadoDelNumero };

const corta = (resultado: ResultadoDelNumero): Paso<never> => ({ ok: false, resultado });

/* ── Pedir el código ──────────────────────────────────────────────────────── */

/**
 * Suma el número del espacio a la WABA y guarda el id que Graph le dio. Va con
 * el nombre visible de la plataforma, leído en el mismo recorrido que cuenta los
 * números: sin él no se agrega nada. Nunca se adopta un número que ya estaba.
 *
 * `alTocarGraph` se llama justo antes del primer pedido a Graph: desde ahí los
 * cupos del código ya no se devuelven, termine como termine el recorrido.
 */
async function sumarALaWaba(
  quien: QuienPide,
  fila: Fila,
  entorno: Entorno,
  topes: Topes,
  alTocarGraph: () => void
): Promise<Paso<string>> {
  const { tenantId } = quien;
  const partes = partirNumero(fila.numero_e164);
  if (!partes) return corta(aRevision("pais", tenantId));

  alTocarGraph();
  const waba = await recorrerLaWaba(entorno.cred.wabaId, "id,display_phone_number,verified_name", entorno.cred.accessToken);
  // Un conteo a medias no es un conteo: ante la duda se cierra.
  if (!waba?.completa) return corta("meta");
  if (waba.filas.some((f) => mismoNumero(f.display, fila.numero_e164))) return corta(aRevision("ya_en_la_waba", tenantId));
  if (waba.filas.length >= topes.numerosWaba) return corta(aRevision("sin_lugar", tenantId));
  const nombre = waba.filas.find((f) => f.id === entorno.plataforma)?.nombre;
  if (!nombre) return corta(aRevision("sin_nombre", tenantId));

  const toma = await tomar([
    { cual: "inquilino", clave: claveDeCupo("wa:alta-numero", tenantId), limit: 1, windowMs: HORA_MS },
    { cual: "global", clave: claveDeCupo("wa:altas-numero"), limit: topes.numerosDia, windowMs: DIA_MS },
  ]);
  if (!toma.ok) return corta(toma.cual === "inquilino" ? "esperar" : aRevision("sin_lugar", tenantId));

  const agregado = await agregarNumero(entorno.cred, partes, nombre);
  if (!agregado.ok) {
    if (agregado.falla === "rechazo") return corta(aRevision("rechazo", tenantId));
    // Sólo «esperar» es seguro de que Meta no hizo nada. Un timeout, un 5xx o un 2xx sin id
    // pueden haber dejado el número en la WABA: los cupos se quedan y lo mira el operador.
    if (agregado.falla === "meta") return corta(aRevision("incierto", tenantId));
    await soltar(toma.tomados);
    return corta(agregado.falla);
  }

  // Desde acá el número está en la WABA: el operador se entera pase lo que pase después.
  after(() => avisarNumeroEnRevision("agregado", tenantId));
  const id = agregado.valor;
  if (!ID_DE_META.test(id) || id === entorno.plataforma) return corta(sinDueno(quien, "agregado", "datos_invalidos"));
  const guardado = await guardarPaso(quien, "agregado", id, entorno.cred.wabaId, entorno.plataforma);
  if (guardado !== "ok") return corta(sinDueno(quien, "agregado", guardado));
  return { ok: true, valor: id };
}

/**
 * Paso 1: suma el número a la WABA si falta y pide que Meta mande el código.
 *
 * Los cupos de código se devuelven sólo si Graph no se tocó: una compuerta cortó
 * antes de cualquier pedido. Desde el recorrido de la WABA (un GET que también
 * cuesta contra los topes de Meta) se quedan gastados, y los de `request_code`,
 * aunque haya dado timeout o una respuesta rara: Meta puede haber mandado el SMS
 * o hecho la llamada.
 */
export async function pedirCodigo(quien: QuienPide, metodo: MetodoDeCodigo): Promise<ResultadoDelNumero> {
  if (!numeroAutomatico()) return "revision";
  const { tenantId } = quien;
  const topes = topesDelNumero();
  let deCodigo: Tomado[] = [];
  let salio = false;
  try {
    const toma = await tomar(cuposDePedirCodigo(tenantId, quien.ip, topes));
    if (!toma.ok) return "esperar";
    deCodigo = toma.tomados;

    const fila = await filaHabilitada(tenantId);
    if (!fila) return "revision";
    const entorno = entornoDeMeta();
    if (!entorno) return aRevision("sin_credencial", tenantId);

    const alTocarGraph = () => {
      salio = true;
    };
    let id = fila.phone_number_id;
    if (!id) {
      const sumado = await sumarALaWaba(quien, fila, entorno, topes, alTocarGraph);
      if (!sumado.ok) return sumado.resultado;
      id = sumado.valor;
    } else if (id === entorno.plataforma) {
      return sinDueno(quien, "agregado", "id_de_la_plataforma");
    }

    alTocarGraph();
    const pedido = await pedirCodigoAMeta(entorno.cred, id, metodo, quien.idioma);
    return pedido.ok ? "codigo_enviado" : deFalla(pedido.falla, tenantId);
  } catch (e) {
    logger.error({ error: nombreDelError(e) }, "alta.numero_automatico_fallo");
    return "meta";
  } finally {
    if (!salio) await soltar(deCodigo);
  }
}

/* ── Verificar el código ──────────────────────────────────────────────────── */

/**
 * Registra el número en Cloud API (si Meta no lo tiene ya registrado: `register`
 * pone un PIN nuevo cada vez y no se repite), le pone su webhook propio y lo deja
 * 'conectado'. Si el webhook no queda, el número queda registrado y 'pedido': otro
 * intento de la persona repite el webhook sin volver a registrar.
 */
async function registrarYConectar(quien: QuienPide, id: string, entorno: Entorno): Promise<ResultadoDelNumero> {
  const { tenantId } = quien;
  const registrado = await numeroYaRegistrado(entorno.cred, id);
  if (!registrado.ok) return deFalla(registrado.falla, tenantId);

  if (!registrado.valor) {
    const toma = await tomar(cuposDeRegistrar(tenantId));
    if (!toma.ok) return "esperar";
    const registro = await registrarNumero(entorno.cred, id);
    if (!registro.ok) return deFalla(registro.falla, tenantId);
  }

  const sinWebhook = await fijarElWebhook(tenantId, id, entorno);
  if (sinWebhook) return sinWebhook;

  const guardado = await guardarPaso(quien, "conectado", id, entorno.cred.wabaId, entorno.plataforma);
  return guardado === "ok" ? "conectado" : sinDueno(quien, "conectado", guardado);
}

/**
 * Paso 2: entrega el código de seis números a Meta, registra el número y lo deja
 * conectado. El código vive en esta llamada: no se guarda ni se anota.
 *
 * Si Meta rechaza el código pero el número ya figura verificado (un intento
 * anterior que se cortó después de aceptarlo), sigue al registro.
 */
export async function verificarCodigo(quien: QuienPide, codigo: string): Promise<ResultadoDelNumero> {
  if (!numeroAutomatico()) return "revision";
  if (!CODIGO_DE_SEIS.test(codigo)) return "codigo_invalido";
  const { tenantId } = quien;
  let tomados: Tomado[] = [];
  let salio = false;
  try {
    const toma = await tomar(cuposDeVerificar(tenantId, topesDelNumero()));
    if (!toma.ok) return "esperar";
    tomados = toma.tomados;

    const fila = await filaHabilitada(tenantId);
    if (!fila) return "revision";
    const id = fila.phone_number_id;
    if (!id) return "pedi_primero";
    const entorno = entornoDeMeta();
    if (!entorno) return aRevision("sin_credencial", tenantId);
    if (id === entorno.plataforma) return sinDueno(quien, "conectado", "id_de_la_plataforma");

    salio = true;
    const verificado = await verificarCodigoEnMeta(entorno.cred, id, codigo);
    if (!verificado.ok) {
      if (verificado.falla !== "rechazo") return verificado.falla;
      const yaVerificado = await codigoYaVerificado(entorno.cred, id);
      if (!yaVerificado.ok) return deFalla(yaVerificado.falla, tenantId);
      if (!yaVerificado.valor) return "codigo_incorrecto";
    }

    return await registrarYConectar(quien, id, entorno);
  } catch (e) {
    logger.error({ error: nombreDelError(e) }, "alta.numero_automatico_fallo");
    return "meta";
  } finally {
    if (!salio) await soltar(tomados);
  }
}
