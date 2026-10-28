/**
 * Qué número de WhatsApp es de quién: el ruteo de lo que entra y la credencial
 * de lo que sale.
 *
 * Es el único archivo que lee WHATSAPP_PHONE_NUMBER_ID, WHATSAPP_ACCESS_TOKEN,
 * WHATSAPP_BUSINESS_ACCOUNT_ID y WHATSAPP_TENANT_ID (más el sondeo de
 * /api/health, que sólo mira la plataforma); lo vigila `pnpm arquitectura`.
 * Hay una sola app de Meta y varias WABAs: la de la plataforma (la del .env)
 * y, si el cliente la conectó por Embedded Signup, la suya. Lo que cambia de
 * un inquilino a otro es el `phone_number_id`, y su fila en `whatsapp_numeros`
 * (migración 0048) dice a quién pertenece, en qué estado está y, para una WABA
 * propia, con qué token se habla: el del usuario de sistema del cliente, cifrado
 * en esa misma fila. El token del .env es sólo el de la plataforma.
 *
 * Una fila en CUALQUIER estado gana sobre el .env: suspender o dar de baja el
 * número de la plataforma tiene que cortarlo de verdad. Y nada cae en un
 * inquilino por omisión: el único id que entra al de la plataforma sin fila es
 * exactamente el de WHATSAPP_PHONE_NUMBER_ID.
 */

import "server-only";
import { and, eq, inArray, isNotNull, ne, notInArray, sql } from "drizzle-orm";
import { db } from "@/lib/db";
import { enControl } from "@/data/scope";
import { tenants, whatsappNumeros, whatsappWabas } from "@/lib/db/schema";
import { enPrueba, pruebaVencida, SIN_SERVICIO } from "@/lib/billing/plans";
import { logger } from "@/lib/observability/logger";
import { codigoPg } from "@/server/core-sync/config";
import type { CredencialesMeta } from "@/server/whatsapp/cloud-api";
import { aadDelSecreto, aadDelToken, abrirSobre, pruebaDelSecreto } from "@/server/whatsapp/sobres-del-cliente";

/** El inquilino de la plataforma: el del número que está en el .env. Sin él, el ensayo y el timbre no tienen a dónde entrar. */
export function inquilinoDeLaPlataforma(): string | null {
  const id = process.env.WHATSAPP_TENANT_ID ?? process.env.GMAIL_TENANT_ID;
  return id?.trim() || null;
}

/** El `phone_number_id` del .env: el único que entra al inquilino de la plataforma sin fila. */
export function idDeLaPlataforma(): string | null {
  return process.env.WHATSAPP_PHONE_NUMBER_ID?.trim() || null;
}

/** La WABA del .env: la de la plataforma, que el alta propia de cada cliente nunca toca. */
export function wabaDeLaPlataforma(): string | null {
  return process.env.WHATSAPP_BUSINESS_ACCOUNT_ID?.trim() || null;
}

/** El token y la WABA del .env, o null si falta alguno de los dos del número. */
export function credencialDelEntorno(): CredencialesMeta | null {
  const accessToken = process.env.WHATSAPP_ACCESS_TOKEN;
  const phoneNumberId = idDeLaPlataforma();
  if (!accessToken || !phoneNumberId) return null;
  return { accessToken, phoneNumberId, wabaId: wabaDeLaPlataforma() };
}

export interface WebhookDelEntorno {
  url: string;
  verifyToken: string;
}

/**
 * El webhook que Meta tiene que usar por cada número que se suma: el de este
 * ambiente, con el token del apretón de manos. Null si falta alguno de los dos
 * o si el sitio no es https: Meta no llama a otra cosa.
 */
export function webhookDelEntorno(): WebhookDelEntorno | null {
  const sitio = process.env.NEXT_PUBLIC_SITE_URL?.trim().replace(/\/+$/, "");
  const verifyToken = process.env.WHATSAPP_VERIFY_TOKEN;
  if (!sitio || !verifyToken || !/^https:\/\/[^/\s]/i.test(sitio) || !URL.canParse(sitio)) return null;
  return { url: `${sitio}/api/webhooks/whatsapp`, verifyToken };
}

/**
 * La fila de `whatsapp_wabas` que manda sobre un número: la del mismo inquilino, de la misma
 * WABA que el número y viva (ni cancelada ni revocada). Una app propia que se canceló o se
 * desconectó conserva `origen = 'app_propia'` pero ya no es dueña del número: sin este filtro,
 * apagar `ALTA_APP_PROPIA` después de cancelar dejaba al cliente sin recibir ni enviar.
 */
const wabaVivaDelNumero = () =>
  and(
    eq(whatsappWabas.tenant_id, whatsappNumeros.tenant_id),
    eq(whatsappWabas.waba_id, whatsappNumeros.waba_id),
    notInArray(whatsappWabas.estado, ["cancelada", "revocada"])
  );

/** Adónde va un mensaje: el inquilino y si entró por la WABA propia del cliente (pesa distinto en el cupo). */
export interface Destino {
  tenantId: string;
  wabaPropia: boolean;
}

/**
 * A qué inquilino va cada `phone_number_id` del lote: id -> destino. Un id
 * que no está en el mapa se descarta. `wabaPropia` sale de que la fila tenga
 * token propio (la misma regla que `credencialesWhatsApp.propia`); el id del .env
 * sin fila es de la plataforma.
 *
 * Una sola consulta por POST. Va con `db` y sin inquilino porque todavía no lo
 * hay: es justo lo que se está buscando.
 *
 * - fila 'conectado' de un inquilino activo: va a ese inquilino;
 * - fila en cualquier otro estado: se descarta;
 * - sin fila y el id es el de la plataforma: va al inquilino de la plataforma;
 * - sin fila y cualquier otro id: se descarta.
 *
 * `wabaDe` (phone_number_id -> `entry.id` del evento) sólo sirve para vigilar:
 * si la WABA con que Meta firmó no es la de la fila se anota
 * `whatsapp.waba_no_coincide`, pero el evento sigue su camino, porque quien
 * decide a quién pertenece un número es la fila y no el sobre del webhook.
 *
 * - fila de una app propia viva (`whatsapp_wabas.origen`, misma WABA, ni cancelada ni
 *   revocada): se descarta. Su webhook es `/api/webhooks/whatsapp/app/[ruta]`, con la
 *   firma de su App Secret; esta ruta firma con el de la plataforma, así que un lote de
 *   acá nunca debería traerla. Una app propia cancelada o desconectada ya no cuenta.
 *
 * Sin la 0051 (falta `whatsapp_wabas`, 42P01) se lee igual cada número, sin saber su
 * origen. Sin la 0048 queda sólo la regla de la plataforma. Cualquier otro
 * error de la base se tira: el webhook responde 500 y Meta reintenta, en vez
 * de resolver "por las dudas".
 */
export async function resolverNumeros(
  ids: string[],
  wabaDe?: ReadonlyMap<string, string>
): Promise<Map<string, Destino>> {
  const ruta = new Map<string, Destino>();
  const unicos = [...new Set(ids)];
  if (unicos.length === 0) return ruta;

  const conFila = new Set<string>();
  try {
    const delNumero = {
      phone_number_id: whatsappNumeros.phone_number_id,
      tenant_id: whatsappNumeros.tenant_id,
      waba_id: whatsappNumeros.waba_id,
      estado: whatsappNumeros.estado,
      // Un booleano y no el token: acá sólo importa si tiene uno propio.
      waba_propia: sql<boolean>`${whatsappNumeros.token_cifrado} is not null`,
      billing_status: tenants.billing_status,
    };
    // sin-inquilino: Todavía no hay inquilino, es lo que se busca: el dueño del
    // phone_number_id con que Meta firmó el evento, en todos los estados.
    const conOrigen = () =>
      db
        .select({ ...delNumero, origen: whatsappWabas.origen })
        .from(whatsappNumeros)
        .innerJoin(tenants, eq(tenants.id, whatsappNumeros.tenant_id))
        .leftJoin(whatsappWabas, wabaVivaDelNumero())
        .where(inArray(whatsappNumeros.phone_number_id, unicos));
    // sin-inquilino: lo mismo, sin el origen. Con la 0048 y sin la 0051 el join da 42P01 por
    // `whatsapp_wabas`: sin esa tabla no hay filas de app propia, y no se puede perder el ruteo.
    const sinOrigen = () =>
      db
        .select(delNumero)
        .from(whatsappNumeros)
        .innerJoin(tenants, eq(tenants.id, whatsappNumeros.tenant_id))
        .where(inArray(whatsappNumeros.phone_number_id, unicos))
        .then((filas): Awaited<ReturnType<typeof conOrigen>> => filas.map((f) => ({ ...f, origen: null })));
    let filas: Awaited<ReturnType<typeof conOrigen>>;
    try {
      filas = await conOrigen();
    } catch (e) {
      if (codigoPg(e) !== "42P01") throw e;
      filas = await sinOrigen();
    }
    for (const f of filas) {
      if (!f.phone_number_id) continue;
      conFila.add(f.phone_number_id);
      if (f.origen === "app_propia") {
        logger.warn({ tenantId: f.tenant_id }, "whatsapp.webhook.app_por_plataforma");
        continue;
      }
      const firmada = wabaDe?.get(f.phone_number_id);
      if (firmada && f.waba_id && firmada !== f.waba_id) {
        logger.warn({ tenantId: f.tenant_id, wabaFirmada: firmada, wabaDeLaFila: f.waba_id }, "whatsapp.waba_no_coincide");
      }
      if (f.estado === "conectado" && !SIN_SERVICIO.has(f.billing_status)) {
        ruta.set(f.phone_number_id, { tenantId: f.tenant_id, wabaPropia: f.waba_propia === true });
      }
    }
  } catch (e) {
    if (codigoPg(e) !== "42P01") throw e;
  }

  const propio = idDeLaPlataforma();
  const plataforma = inquilinoDeLaPlataforma();
  if (propio && plataforma && unicos.includes(propio) && !conFila.has(propio)) {
    ruta.set(propio, { tenantId: plataforma, wabaPropia: false });
  }
  return ruta;
}

export interface AppDeLaRuta {
  tenantId: string;
  appId: string;
  /** El App Secret en su sobre: lo abre quien verifica la firma, con `aadDelSecreto(tenantId, appId)`. */
  secretoCifrado: string;
  wabaId: string | null;
  /** El del número vivo (el que no está dado de baja), o null si todavía no tiene. */
  phoneNumberId: string | null;
  /** El estado de la WABA (`whatsapp_wabas.estado`). */
  estado: string;
  /** El estado del número vivo, o null si no tiene. */
  numeroEstado: string | null;
  /** Ya entró un mensaje por este webhook (`primer_mensaje_en`). */
  primerMensaje: boolean;
  /** El inquilino está suspendido o dado de baja: lo firmado se acusa, pero no se guarda. */
  sinServicio: boolean;
  /** Epoch ms del último cambio de la fila (`actualizado_en`); null si la base no lo trajo. */
  actualizadoEn: number | null;
}

const VIDA_DE_LA_RUTA_MS = 30_000;
/** Una ruta inventada ocupa un lugar en el mapa: sin tope, quien las prueba una por una lo llenaría. */
const TOPE_DE_RUTAS = 1000;
const rutasEnMemoria = new Map<string, { vence: number; fila: AppDeLaRuta | null }>();

/**
 * La fila de la app propia que corresponde a la ruta del webhook, o null si esa
 * ruta no es de nadie. Una sola consulta: la WABA con su número vivo (el mismo
 * predicado que `resolverNumeros`: el que no está dado de baja) y el estado de
 * cobro del inquilino. Va con `db` y sin inquilino porque todavía no lo hay.
 *
 * Con caché por instancia de 30 s, que guarda también el nulo (R4): quien prueba rutas
 * inventadas pega en la base una vez cada 30 s por ruta, no una por pedido. Nada la
 * invalida: un cambio de secreto o una baja tardan hasta 30 s en verse, y mientras
 * tanto una firma que no verifica da 401 y Meta reintenta. Lo que no se arregla con el
 * 401 es una fila vieja que dice "no guardes" cuando ya hay que guardar (el número recién
 * conectado): ahí quien llama pide `fresca`, que se salta la lectura del caché (la respuesta
 * sí lo renueva) y se acusa recibo sabiendo el estado de ahora.
 *
 * Un error de la base se tira: el webhook responde 500 y Meta reintenta.
 */
export async function appDeLaRuta(ruta: string, { fresca = false }: { fresca?: boolean } = {}): Promise<AppDeLaRuta | null> {
  const ahora = Date.now();
  const guardada = rutasEnMemoria.get(ruta);
  if (!fresca && guardada && guardada.vence > ahora) return guardada.fila;

  // sin-inquilino: Todavía no hay inquilino, es lo que se busca: el dueño de la
  // ruta del webhook, para poder verificar la firma antes de creerle nada al pedido.
  const [f] = await db
    .select({
      tenant_id: whatsappWabas.tenant_id,
      app_id: whatsappWabas.app_id,
      app_secreto_cifrado: whatsappWabas.app_secreto_cifrado,
      waba_id: whatsappWabas.waba_id,
      estado: whatsappWabas.estado,
      primer_mensaje_en: whatsappWabas.primer_mensaje_en,
      actualizado_en: whatsappWabas.actualizado_en,
      phone_number_id: whatsappNumeros.phone_number_id,
      numero_estado: whatsappNumeros.estado,
      billing_status: tenants.billing_status,
    })
    .from(whatsappWabas)
    .innerJoin(tenants, eq(tenants.id, whatsappWabas.tenant_id))
    .leftJoin(
      whatsappNumeros,
      and(eq(whatsappNumeros.tenant_id, whatsappWabas.tenant_id), ne(whatsappNumeros.estado, "baja"))
    )
    .where(
      and(
        eq(whatsappWabas.ruta_webhook, ruta),
        eq(whatsappWabas.origen, "app_propia"),
        isNotNull(whatsappWabas.app_secreto_cifrado)
      )
    )
    .limit(1);

  const fila: AppDeLaRuta | null =
    f && f.app_id && f.app_secreto_cifrado
      ? {
          tenantId: f.tenant_id,
          appId: f.app_id,
          secretoCifrado: f.app_secreto_cifrado,
          wabaId: f.waba_id,
          phoneNumberId: f.phone_number_id,
          estado: f.estado,
          numeroEstado: f.numero_estado,
          primerMensaje: f.primer_mensaje_en !== null,
          sinServicio: SIN_SERVICIO.has(f.billing_status),
          actualizadoEn: Number.isFinite(Date.parse(f.actualizado_en)) ? Date.parse(f.actualizado_en) : null,
        }
      : null;

  if (rutasEnMemoria.size >= TOPE_DE_RUTAS) {
    for (const [clave, v] of rutasEnMemoria) if (v.vence <= ahora) rutasEnMemoria.delete(clave);
    // Si ninguna venció, sale la más vieja: el mapa guarda el orden de entrada.
    if (rutasEnMemoria.size >= TOPE_DE_RUTAS) rutasEnMemoria.delete(rutasEnMemoria.keys().next().value as string);
  }
  rutasEnMemoria.set(ruta, { vence: ahora + VIDA_DE_LA_RUTA_MS, fila });
  return fila;
}

export interface DatosLegales {
  razonSocial: string;
  cuit: string;
  contacto: string | null;
}

/**
 * Lo que dicen las páginas legales públicas de un cliente: su razón social, su CUIT y su
 * mail de contacto. Null si el slug no es de nadie o el cliente todavía no cargó sus datos.
 *
 * Se publican mientras la app de Meta del cliente pueda estar apuntando acá: con `app_id`
 * cargado y la WABA no cancelada (R3). Incluye `revocada`, porque la app sigue apuntando a
 * esas direcciones después de desconectar. Despublicar es poner `slug_legal` en NULL.
 */
export async function datosLegalesDelSlug(slug: string): Promise<DatosLegales | null> {
  // sin-inquilino: Página pública, sin sesión: el slug al azar es lo único que se tiene.
  const [f] = await db
    .select({
      razon_social: whatsappWabas.razon_social,
      cuit: whatsappWabas.cuit,
      contact_email: tenants.contact_email,
    })
    .from(whatsappWabas)
    .innerJoin(tenants, eq(tenants.id, whatsappWabas.tenant_id))
    .where(
      and(
        eq(whatsappWabas.slug_legal, slug),
        eq(whatsappWabas.origen, "app_propia"),
        isNotNull(whatsappWabas.app_id),
        ne(whatsappWabas.estado, "cancelada")
      )
    )
    .limit(1);
  if (!f?.razon_social || !f.cuit) return null;
  return { razonSocial: f.razon_social, cuit: f.cuit, contacto: f.contact_email };
}

export interface CredencialesDelNumero extends CredencialesMeta {
  /** De quién es el número: la clave de lo que se cuenta por inquilino, como el tope de plantillas. */
  tenantId: string;
  /** El espacio salió del alta automática. */
  autoalta: boolean;
  /** Salió del alta automática y sigue en prueba: `autoalta` solo no alcanza, un alta sola que ya paga deja de estar topeada. */
  enPrueba: boolean;
  /** Está en prueba y la fecha de fin ya pasó. */
  vencida: boolean;
  /** Habla con la WABA de su propiedad (la fila trae su token) y no con la de la plataforma: sólo ahí un rechazo de la cuenta es suyo. */
  propia: boolean;
  /**
   * Es la app propia del cliente y todavía no salió ninguna respuesta con este número: el
   * envío que Meta acepte marca `primera_respuesta_en`. Ausente vale false.
   */
  primeraRespuestaPendiente?: boolean;
}

/**
 * Con qué número y qué token habla este inquilino, o null si no tiene número
 * con el que mandar. Quien recibe null no envía nada y lo anota con
 * `avisarSinNumero`.
 *
 * - fila 'conectado': su número y su token. Con `token_cifrado` se descifra con el
 *   AAD de su espacio y su WABA (el usuario de sistema del cliente); con NULL,
 *   el token del .env, sea cual sea la WABA anotada: el vínculo propio escribe el
 *   token junto con la WABA, así que una fila sin token es del camino de la
 *   plataforma (incluida la WABA de prueba y la que no tiene
 *   WHATSAPP_BUSINESS_ACCOUNT_ID cargada). Si el inquilino está suspendido o
 *   dado de baja, null: es lo que corta TODO envío saliente (texto, plantillas,
 *   recordatorios) de un solo lugar;
 * - si la WABA es de una app propia viva (`whatsapp_wabas.origen`, la misma WABA del
 *   número, ni cancelada ni revocada), además abre el App
 *   Secret y devuelve `prueba` (`appsecret_proof` del token), nunca el secreto. Con
 *   esa prueba firman cada llamada a Graph los cinco llamadores del envío. Si el
 *   secreto no abre, null: sin prueba, una app con «Require App Secret» rechaza todo;
 * - fila en otro estado: null, aunque sea la plataforma;
 * - sin fila: la plataforma usa el .env; cualquier otro inquilino, null.
 *
 * Sin la 0051 (falta `whatsapp_wabas`) lee el número sin el origen. Nunca tira. Ante un error de la base devuelve null y lo anota: no se cae al
 * .env, porque puede haber una fila suspendida que el error esconde.
 */
export async function credencialesWhatsApp(tenantId: string): Promise<CredencialesDelNumero | null> {
  try {
    const delNumero = {
      estado: whatsappNumeros.estado,
      phone_number_id: whatsappNumeros.phone_number_id,
      waba_id: whatsappNumeros.waba_id,
      token_cifrado: whatsappNumeros.token_cifrado,
      billing_status: tenants.billing_status,
      trial_ends_at: tenants.trial_ends_at,
      autoalta: tenants.autoalta,
    };
    const conWaba = () =>
      enControl({ tenantId }, (c) =>
        c
          .select({
            ...delNumero,
            origen: whatsappWabas.origen,
            app_id: whatsappWabas.app_id,
            app_secreto_cifrado: whatsappWabas.app_secreto_cifrado,
            primera_respuesta_en: whatsappWabas.primera_respuesta_en,
          })
          .from(whatsappNumeros)
          .innerJoin(tenants, eq(tenants.id, whatsappNumeros.tenant_id))
          .leftJoin(whatsappWabas, wabaVivaDelNumero())
      );
    // Con la 0048 y sin la 0051 el join da 42P01 por `whatsapp_wabas`: sin esa tabla
    // todo número es de la plataforma o de Embedded Signup, y nadie se queda sin enviar.
    const sinWaba = () =>
      enControl({ tenantId }, (c) =>
        c
          .select(delNumero)
          .from(whatsappNumeros)
          .innerJoin(tenants, eq(tenants.id, whatsappNumeros.tenant_id))
      ).then((filas): Awaited<ReturnType<typeof conWaba>> =>
        filas.map((f) => ({ ...f, origen: null, app_id: null, app_secreto_cifrado: null, primera_respuesta_en: null }))
      );
    const filas = await conWaba()
      .catch((e: unknown) => {
        if (codigoPg(e) !== "42P01") throw e;
        return sinWaba();
      })
      .catch((e: unknown) => {
        if (codigoPg(e) !== "42P01") throw e;
        return [];
      });

    const viva = filas.find((f) => f.estado === "conectado");
    if (!viva) {
      if (filas.length > 0 || tenantId !== inquilinoDeLaPlataforma()) return null;
      const delEntorno = credencialDelEntorno();
      return delEntorno && { ...delEntorno, tenantId, autoalta: false, enPrueba: false, vencida: false, propia: false };
    }

    if (SIN_SERVICIO.has(viva.billing_status)) return null;

    const accessToken = viva.token_cifrado
      ? viva.waba_id && abrirSobre(viva.token_cifrado, aadDelToken(tenantId, viva.waba_id))
      : process.env.WHATSAPP_ACCESS_TOKEN;
    if (!accessToken) {
      logger.warn({ tenantId, wabaId: viva.waba_id }, "whatsapp.credenciales_sin_token");
      return null;
    }
    if (!viva.phone_number_id) return null;

    const appPropia = viva.origen === "app_propia";
    const secreto = appPropia && viva.app_id ? abrirSobre(viva.app_secreto_cifrado, aadDelSecreto(tenantId, viva.app_id)) : null;
    if (appPropia && !secreto) {
      logger.warn({ tenantId, wabaId: viva.waba_id }, "whatsapp.credenciales_sin_secreto");
      return null;
    }

    const prueba = enPrueba(viva);
    return {
      accessToken,
      phoneNumberId: viva.phone_number_id,
      wabaId: viva.waba_id,
      tenantId,
      autoalta: viva.autoalta === true,
      enPrueba: prueba,
      vencida: prueba && pruebaVencida(viva, new Date()),
      propia: !!viva.token_cifrado,
      ...(secreto ? { prueba: pruebaDelSecreto(accessToken, secreto), primeraRespuestaPendiente: !viva.primera_respuesta_en } : {}),
    };
  } catch (e) {
    logger.error({ detalle: codigoPg(e) ?? (e instanceof Error ? e.message : "unknown") }, "whatsapp.credenciales_error");
    return null;
  }
}

/** Un envío o una descarga que no salió porque el inquilino no tiene número con el que hablar. */
export function avisarSinNumero(tenantId: string, donde: string): void {
  logger.warn({ tenantId, donde }, "whatsapp.sin_numero");
}
