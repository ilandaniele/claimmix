/**
 * Webhook de la app de Meta de un cliente (la «app propia»): una ruta por espacio,
 * `/api/webhooks/whatsapp/app/<ruta>`. Meta firma cada POST con el App Secret de esa
 * app, así que la firma se prueba con el secreto de la fila de la ruta y nunca con el
 * de la plataforma, y el camino con Bearer de la ruta de la plataforma no existe acá.
 *
 * La ruta es un secreto menor, no una credencial: el orden de los pasos está pensado
 * para que quien la adivine o la pruebe a ciegas no cueste una consulta a la base ni
 * un descifrado por pedido. Primero el formato y los cupos en memoria, después la
 * fila (con caché de 30 s que también guarda el «no existe»), después el tope del
 * cuerpo, y sólo entonces el secreto y la firma.
 *
 * Los mensajes van por el mismo camino que los de la plataforma (`atenderLoteDeMeta`),
 * pero acá el dueño del número lo dice la ruta y no el `phone_number_id`: lo que venga
 * para otro número se descarta y se cuenta. Los avisos de la cuenta se atienden
 * después de contestar, con el espacio ya resuelto.
 */

import { after, type NextRequest, NextResponse } from "next/server";
import { getClientIp, RATE_LIMIT_CONFIGS, rateLimit } from "@/lib/rate-limit";
import { claveDeCupo } from "@/lib/rate-limit/clave";
import { checkRateLimit, liberarIntento } from "@/lib/rate-limit/memory";
import { nombreDelError } from "@/lib/observability/error-code";
import { logger } from "@/lib/observability/logger";
import { avisarNumeroEnRevision } from "@/server/alta/aviso-operador";
import { atenderEventosDeCuenta } from "@/server/alta/eventos-de-cuenta";
import { primerMensajeDeApp, wabaEnFalla, webhookDeAppVerificado } from "@/server/alta/panel-operador";
import { derivar } from "@/server/alta/sellado";
import { urlDelWebhookDeApp } from "@/server/alta/waba-propia-activa";
import { leerApp, revisarTokenDeApp, type RevisionDeToken } from "@/server/whatsapp/app-del-cliente";
import {
  leerHastaElTope,
  parseCloudApiMessages,
  parseEventosDeCuenta,
  resolveWebhookChallenge,
  verificarFirmaDeApp,
} from "@/server/whatsapp/cloud-api";
import { appDeLaRuta, credencialesWhatsApp, type AppDeLaRuta } from "@/server/whatsapp/numeros";
import { aadDelSecreto, abrirSobre } from "@/server/whatsapp/sobres-del-cliente";
import { atenderLoteDeMeta } from "@/server/whatsapp/webhook-de-meta";

export const dynamic = "force-dynamic";
// El `after()` corre con este mismo techo, contado desde que entra el pedido.
export const maxDuration = 300;

/** 16 bytes en base64url: lo que genera el alta. Cualquier otra cosa no es de nadie. */
const RUTA = /^[A-Za-z0-9_-]{22}$/;
/** El desafío que Meta pide repetir: ASCII visible y corto, para no devolver lo que no se pueda mostrar. */
const DESAFIO = /^[\x21-\x7E]{1,256}$/;
/** Un lote de Meta pesa unos pocos KB; esto deja de sobra para el más grande y corta lo que no es de Meta. */
const TOPE_DEL_CUERPO = 3 * 1024 * 1024;
const MINUTO_MS = 60_000;
const HORA_MS = 60 * MINUTO_MS;

type Ctx = { params: Promise<{ ruta: string }> };

const error = (status: number, code: string, message: string, headers?: Record<string, string>) =>
  NextResponse.json({ error: { code, message } }, { status, headers });

// ── GET: el apretón de manos de Meta ─────────────────────────────────────────

export async function GET(request: NextRequest, context: Ctx): Promise<NextResponse> {
  const { ruta } = await context.params;
  if (!RUTA.test(ruta)) return error(404, "NOT_FOUND", "Not found.");

  let marca: string;
  try {
    marca = derivar("wa-verify-app", ruta);
  } catch {
    logger.error({}, "whatsapp.webhook.app_sin_marca");
    return error(500, "INTERNAL_ERROR", "Webhook verification is not available.");
  }
  // Antes que la base: quien no sabe la marca no cuesta una consulta.
  const desafio = resolveWebhookChallenge(request.nextUrl.searchParams, marca);
  if (desafio === null) return error(403, "VERIFICATION_FAILED", "Invalid verify token.");
  if (!DESAFIO.test(desafio)) return error(400, "INVALID_CHALLENGE", "Invalid challenge.");

  try {
    // Una ruta que no es de ninguna fila viva no repite el desafío: la marca se deriva de la ruta, y la ruta no es secreta para quien la pegó.
    if (!(await webhookDeAppVerificado(ruta))) return error(404, "NOT_FOUND", "Not found.");
  } catch (err) {
    logger.error({ error: nombreDelError(err) }, "whatsapp.webhook.app_verificacion_fallo");
    return error(500, "INTERNAL_ERROR", "Webhook verification failed.");
  }
  return new NextResponse(desafio, {
    status: 200,
    headers: { "Content-Type": "text/plain", "X-Content-Type-Options": "nosniff" },
  });
}

// ── POST: lo que Meta manda de la app ────────────────────────────────────────

/** Pregunta a Graph si el token del cliente sigue sirviendo, para decidir una baja; sin token abierto no hay confirmación. */
async function revisarElToken(fila: AppDeLaRuta, secreto: string): Promise<RevisionDeToken> {
  const cred = await credencialesWhatsApp(fila.tenantId);
  if (!cred) return { ok: false, motivo: "meta", codigo: null };
  return revisarTokenDeApp(cred.accessToken, { appId: fila.appId, secreto });
}

/**
 * Muchas firmas malas pueden ser un secreto cambiado: se le pregunta a Meta, y sólo si lo rechaza la cuenta cae. Nunca tira.
 * El secreto que se probó puede ser de hace 30 s (caché): si el cliente ya pegó uno nuevo, el rechazo era del viejo y la
 * falla sólo se marca si la fila todavía tiene el mismo (`secretoCifrado`); sin marca no hay aviso.
 */
async function revisarElSecreto(fila: AppDeLaRuta, secreto: string, ruta: string): Promise<void> {
  try {
    const r = await leerApp({ appId: fila.appId, secreto }, urlDelWebhookDeApp(ruta) ?? "");
    if (r.ok || r.falla !== "rechazo") return;
    if (!(await wabaEnFalla(fila.tenantId, "secreto_invalido", { secretoCifrado: fila.secretoCifrado }))) return;
    await avisarNumeroEnRevision("secreto_invalido", fila.tenantId);
  } catch (err) {
    logger.error({ error: nombreDelError(err) }, "whatsapp.webhook.app_revision_fallo");
  }
}

export async function POST(request: NextRequest, context: Ctx): Promise<NextResponse> {
  // El reloj de Vercel corre desde acá, no desde el `after()`.
  const hasta = Date.now() + maxDuration * 1000;
  const { ruta } = await context.params;
  if (!RUTA.test(ruta)) return error(404, "NOT_FOUND", "Not found.");

  // Dos cupos en memoria antes de tocar nada: por IP y por ruta. Una firma buena los devuelve.
  // El de IP no lleva la ruta: con ella, quien inventa rutas estrena un cupo en cada pedido y la base y el mapa de contadores no tienen tope.
  const claveIp = claveDeCupo("wa:firma:ip", getClientIp(request));
  const claveRuta = claveDeCupo("wa:firma:ruta", ruta);
  const porIp = checkRateLimit(claveIp, 60, MINUTO_MS);
  const porRuta = porIp.allowed ? checkRateLimit(claveRuta, 120, MINUTO_MS) : null;
  if (!porIp.allowed || !porRuta?.allowed) {
    if (porIp.allowed) liberarIntento(claveIp, porIp.ventana);
    const reintento = Math.max(1, Math.ceil(((porRuta ?? porIp).resetAt - Date.now()) / 1000));
    return error(429, "RATE_LIMITED", "Too many requests.", { "Retry-After": String(reintento) });
  }

  let buscada: AppDeLaRuta | null;
  try {
    buscada = await appDeLaRuta(ruta);
  } catch (err) {
    // Un 500 y no un descarte: Meta reintenta, y esto es la base que no contestó, no una ruta ajena.
    logger.error({ error: nombreDelError(err) }, "whatsapp.webhook.app_ruteo_failed");
    return error(500, "ROUTING_FAILED", "Could not resolve the webhook.");
  }
  if (!buscada) return error(404, "NOT_FOUND", "Not found.");
  const fila = buscada;

  // El tope va antes de descifrar el secreto: un cuerpo enorme no cuesta ni una operación de la clave.
  const declarado = Number(request.headers.get("content-length"));
  if (declarado > TOPE_DEL_CUERPO) return error(413, "PAYLOAD_TOO_LARGE", "Request body is too large.");
  const crudo = await leerHastaElTope(request, TOPE_DEL_CUERPO);
  if (crudo === "demasiado_grande") return error(413, "PAYLOAD_TOO_LARGE", "Request body is too large.");
  if (!crudo) return error(400, "INVALID_PAYLOAD", "Request body could not be read.");

  const secreto = abrirSobre(fila.secretoCifrado, aadDelSecreto(fila.tenantId, fila.appId));
  if (!secreto) return error(500, "INTERNAL_ERROR", "Webhook secret is not available.");

  if (!verificarFirmaDeApp(crudo, request.headers.get("x-hub-signature-256"), secreto)) {
    // Sin el cuerpo, la cabecera ni el secreto: sólo de quién es la ruta.
    logger.warn({ tenantId: fila.tenantId }, "whatsapp.webhook.app_firma_invalida");
    const malas = checkRateLimit(claveDeCupo("wa:firma", ruta), 20, HORA_MS);
    // Al llenarse el tope se pregunta a Meta una vez por hora entre todas las instancias; quien manda cuerpos mal firmados no provoca más.
    if (malas.allowed && malas.remaining === 0) {
      const cupo = await rateLimit(claveDeCupo("wa:firma:revision", ruta), RATE_LIMIT_CONFIGS.REVISION_SECRETO);
      if (cupo.allowed) after(() => revisarElSecreto(fila, secreto, ruta));
    }
    return error(401, "UNAUTHORIZED", "Invalid webhook signature.");
  }
  liberarIntento(claveIp, porIp.ventana);
  liberarIntento(claveRuta, porRuta.ventana);

  let payload: unknown;
  try {
    payload = JSON.parse(crudo.toString("utf8"));
  } catch {
    return error(400, "INVALID_PAYLOAD", "Request body must be valid JSON.");
  }

  // Los avisos de la cuenta no esperan a los mensajes ni demoran el acuse; sólo los de la WABA de esta fila.
  const { tenantId, wabaId } = fila;
  const eventos = wabaId ? parseEventosDeCuenta(payload).filter((e) => e.wabaId === wabaId) : [];
  if (wabaId && eventos.length > 0) {
    after(async () => {
      // El aviso se compara con el último cambio de la fila, y el caché puede ir 30 s atrasado: se lee de nuevo (raro, y fuera del acuse).
      const actual = await appDeLaRuta(ruta, { fresca: true }).catch(() => null);
      await atenderEventosDeCuenta(eventos, {
        tenantId,
        wabaId,
        actualizadoEn: (actual ?? fila).actualizadoEn,
        revisar: () => revisarElToken(fila, secreto),
      });
    });
  }

  // La firma dice que el pedido es de esta app, no que sea para este número: la app puede estar suscripta a más de una WABA.
  const todos = parseCloudApiMessages(payload);
  // Sólo un número conectado de un espacio con servicio guarda lo que llega; lo demás se acusa y no se toca.
  const decidir = (f: AppDeLaRuta) => ({
    propios: todos.filter((m) => !!f.phoneNumberId && m.toPhoneNumberId?.trim() === f.phoneNumberId),
    guarda: f.numeroEstado === "conectado" && !f.sinServicio && (f.estado === "conectada" || f.estado === "falla"),
  });
  let vigente = fila;
  let { propios, guarda } = decidir(vigente);
  if (todos.length > 0 && !guarda) {
    // Un caché de hasta 30 s puede decir «todavía no» cuando el número ya se conectó, y Meta no reintenta un 200: antes de descartar, se lee de nuevo.
    try {
      vigente = (await appDeLaRuta(ruta, { fresca: true })) ?? vigente;
    } catch (err) {
      logger.error({ error: nombreDelError(err) }, "whatsapp.webhook.app_ruteo_failed");
      return error(500, "ROUTING_FAILED", "Could not resolve the webhook.");
    }
    ({ propios, guarda } = decidir(vigente));
  }
  if (todos.length > propios.length) {
    logger.warn({ tenantId, cantidad: todos.length - propios.length }, "whatsapp.webhook.app_ajena");
  }
  if (!guarda && propios.length > 0) {
    logger.warn({ tenantId, cantidad: propios.length, estado: vigente.estado }, "whatsapp.webhook.app_sin_servicio");
  }

  const respuesta = guarda
    ? await atenderLoteDeMeta(propios, (numero) => (numero === vigente.phoneNumberId ? tenantId : undefined), hasta)
    : { status: 200 as const, cuerpo: { ok: true, received: 0, case_ids: [] as string[] } };

  // El primer mensaje se anota sólo si alguien lo atendió: acusado y descartado, el panel mentiría y la falta de respuesta daría un diagnóstico falso.
  if (guarda && respuesta.status === 200 && propios.length > 0 && !vigente.primerMensaje) {
    after(() =>
      primerMensajeDeApp(tenantId).catch((err) =>
        logger.error({ error: nombreDelError(err) }, "whatsapp.webhook.app_primer_mensaje_fallo")
      )
    );
  }
  return NextResponse.json(respuesta.cuerpo, { status: respuesta.status });
}
