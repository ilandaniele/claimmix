/**
 * El alta con la WABA propia del cliente (Embedded Signup): de «abrí el popup de
 * Meta» a «tu WhatsApp está conectado».
 *
 * Es lo único que decide el orden de los pasos. `embedded-signup.ts` y
 * `alta-de-numero.ts` hablan con Graph, y la función SECURITY DEFINER de la 0051
 * (`claimmix_waba_propia`) es la única puerta con la que la app escribe la fila de
 * la WABA, su estado y el token del cliente. Acá se arma qué se pregunta, en qué
 * orden y qué se le devuelve a quien lo pidió:
 *
 *   - `iniciarWaba`: mira que haya lugar esta semana y arma lo que el popup
 *     precarga;
 *   - `vincularWaba`: cambia el código del popup por el token, saca de él (y no del
 *     navegador) qué WABA y qué número son, y los guarda;
 *   - `continuarWaba`: suscribe la app, pide el código, registra el número, le pone
 *     su webhook y lo deja conectado. Se puede repetir las veces que haga falta:
 *     cada vuelta retoma donde quedó, así un corte no obliga a abrir el popup otra
 *     vez (el código dura 30 segundos);
 *   - `aceptarNumero`, `codigoWaba`, `pinWaba`, `cancelarWaba`, `desconectarWaba`:
 *     lo que la persona hace en la pantalla entre medio.
 *
 * Las filas que nacen de la app de Meta del propio cliente (`origen = app_propia`)
 * siguen los mismos pasos con otras reglas: cada llamada a Graph lleva el
 * `appsecret_proof`, el número no recibe webhook propio (el de la app ya apunta al
 * espacio) y `conectar` espera a que ese webhook se haya verificado. Qué se pide
 * en cada pantalla de esa vía vive en `app-propia.ts`.
 *
 * Lo que viene del navegador (el evento del popup, los ids) es una pista: la verdad
 * es lo que Meta dice del token. Nada acá tira; lo inesperado vuelve como `meta`
 * y se anota. El token, el PIN y el código del popup no llegan a un registro, a un
 * resultado ni al navegador: se cifran con el espacio y la WABA como AAD, para que
 * el sobre de uno no abra en la fila de otro.
 *
 * La WABA y el número de la plataforma no se asignan a nadie, y esta ruta no usa los
 * topes del número por código (los de la WABA de la plataforma): el cupo propio es
 * de WABAs nuevas por semana.
 */

import "server-only";

import { randomInt } from "node:crypto";

import { and, eq, ne, sql } from "drizzle-orm";
import { after } from "next/server.js";

import { enControl } from "@/data/scope";
import { filasDe } from "@/lib/db/filas";
import { tenants, whatsappNumeros, whatsappWabas } from "@/lib/db/schema";
import { getT } from "@/lib/i18n";
import { ID_DE_USUARIO_DE_META } from "@/lib/meta-ids";
import { nombreDelError } from "@/lib/observability/error-code";
import { logger } from "@/lib/observability/logger";
import { claveDeCupo } from "@/lib/rate-limit/clave";
import { cifrar } from "@/lib/security/cifrado";
import { topeEntero } from "@/lib/topes";
import { CATEGORIA_INICIAL, categoriaDePerfil, type CategoriaDePerfil } from "@/lib/whatsapp-categorias";
import { avisarNumeroEnRevision, type MotivoDeRevision } from "@/server/alta/aviso-operador";
import { topesDelNumero } from "@/server/alta/numero-automatico";
import type { ResultadoDelNumero } from "@/server/alta/numero-resultados";
import {
  DIA_MS,
  HORA_MS,
  aRevision,
  cuposDePedirCodigo,
  cuposDeRegistrar,
  cuposDeVerificar,
  fijarElWebhook,
  soltar,
  tomar,
  type Entorno,
  type Guardado,
  type QuienPide,
  type Tomado,
} from "@/server/alta/pasos-del-numero";
import { mismoNumero, normalizarE164 } from "@/server/alta/validar";
import { activaPara, urlDelWebhookDeApp, wabaPropia } from "@/server/alta/waba-propia-activa";
import {
  esResultadoDeWaba,
  pasoCancelado,
  reconectando,
  type FallaDeWaba,
  type OrigenDeWaba,
  type ResultadoDeApp,
  type ResultadoDeWaba,
} from "@/server/alta/waba-resultados";
import { esNumeroDeOtroAmbiente } from "@/server/ambiente/de-otro-ambiente";
import { espejarSinFallar } from "@/server/bases/espejar-sin-fallar";
import { codigoPg } from "@/server/core-sync/config";
import {
  CODIGO_DE_SEIS,
  codigoYaVerificado,
  numeroYaRegistrado,
  partirNumero,
  pedirCodigoAMeta,
  registrarNumero,
  verificarCodigoEnMeta,
  type CredencialDeAlta,
  type FallaDeGraph,
  type MetodoDeCodigo,
} from "@/server/whatsapp/alta-de-numero";
import {
  completarPerfil,
  leerApp,
  leerSalud,
  pruebaDelSecreto,
  type AppDelCliente,
} from "@/server/whatsapp/app-del-cliente";
import {
  bajaDelNumero,
  canjearCodigo,
  codigoVencido,
  crearPlantillaReabrir,
  datosDelNumero,
  desuscribirApp,
  negocioDeLaWaba,
  revisarToken,
  suscribirApp,
} from "@/server/whatsapp/embedded-signup";
import { efectoDeError, motivoDeAlta, PARAMETRO_INVALIDO, type MotivoDeAlta, type PasoDeAlta } from "@/server/whatsapp/errores-de-graph";
import { idDeLaPlataforma, wabaDeLaPlataforma, webhookDelEntorno } from "@/server/whatsapp/numeros";
import { aadDelPin, aadDelSecreto, aadDelToken, abrirSobre } from "@/server/whatsapp/sobres-del-cliente";
import { estaEnLaWaba, recorrerLaWaba } from "@/server/whatsapp/verificar-en-meta";

/** Abrir la pantalla previa y el popup es barato, pero cada vuelta mira la base y arma el pedido: tres por día alcanzan. */
const INICIOS_POR_DIA = 3;
/** Cada intento con código canjea, revisa y consulta Graph: cinco por hora cubren a quien se equivoca y reintenta. */
const VINCULOS_POR_HORA = 5;
/** «Aceptar el número» y «reintentar» vuelven a hablar con Graph aunque no estrenen nada: veinte por hora por espacio, que el tope por IP solo no frena. */
const SEGUIDAS_POR_HORA = 20;
const NOMBRE_ESTADO = /^[A-Z_]{1,30}$/;
/** Lo que Graph contesta a `register` cuando el PIN no es el del segundo factor que el número ya tiene (sin confirmar con Meta; los tests lo fijan). */
const PIN_NO_COINCIDE = 133005;
/** Demasiados intentos de PIN (133008) o muy seguidos (133009): se espera, no es un rechazo que haya que mirar. */
const PIN_CON_ESPERA: ReadonlySet<number> = new Set([133008, 133009]);

const EVENTO_SOLO_WABA = "FINISH_ONLY_WABA";
const EVENTO_APP_DE_WHATSAPP = "FINISH_WHATSAPP_BUSINESS_APP_ONBOARDING";

/** Cuántas WABAs nuevas de portfolios distintos se aceptan por semana, de todos los espacios juntos. */
const topeSemanal = () => topeEntero("ALTA_TOPE_WABAS_SEMANA");

/* ── Tipos ────────────────────────────────────────────────────────────────── */

/** Lo que la base sabe de la WABA propia de un espacio y de su número vivo, con el token y el PIN ya abiertos. */
export interface FilaDeWaba {
  estado: string | null;
  falla: string | null;
  wabaId: string | null;
  businessId: string | null;
  phoneNumberId: string | null;
  /** El número que la persona tipeó al darse de alta; el que Meta informó está en `numeroMeta`. */
  numeroTipeado: string | null;
  numeroMeta: string | null;
  numeroAceptado: boolean;
  token: string | null;
  pin: string | null;
  nombreEstado: string | null;
  plantillaEnviadaEn: Date | null;
  /** Estado de la fila viva de `whatsapp_numeros`; null si no hay. */
  numeroEstado: string | null;
  /** El correo de contacto del espacio, para precargar el popup. */
  emailDeContacto?: string | null;
  /** `tenants.name`: precarga la razón social y el nombre de la app de la vía de la app propia. */
  nombreDelEspacio?: string | null;
  /** Cómo nació la fila viva; null si el espacio no tiene fila. */
  origen: OrigenDeWaba | null;
  /** De acá hasta `puedeEnviar`: lo de la app propia del cliente, null en Embedded Signup. `secreto` va abierto y no sale del servidor. */
  appId: string | null;
  secreto: string | null;
  ruta: string | null;
  webhookAppVerificadoEn: Date | null;
  datosAppEn: Date | null;
  primerMensajeEn: Date | null;
  primeraRespuestaEn: Date | null;
  slugLegal: string | null;
  razonSocial: string | null;
  cuit: string | null;
  acuerdoVersion: string | null;
  recordatorioEn: Date | null;
  puedeEnviar: "AVAILABLE" | "LIMITED" | "BLOCKED" | null;
  /** El rubro que el cliente eligió para el perfil del número (app propia); null si no eligió o no es de la app propia. */
  categoria?: CategoriaDePerfil | null;
}

/**
 * Lo que devuelve un paso escrito: los de `Guardado` del número por código y los
 * que sólo existen acá (la función de la 0051 distingue qué le pasó al pedido).
 */
export type GuardadoDeWaba =
  | Guardado
  | "de_la_plataforma"
  | "numero_ocupado"
  | "ya_conectado"
  | "transicion"
  | "cupo"
  | "apagado"
  | "app_ocupada"
  | "otra_app"
  | "webhook_pendiente";

/** Dónde se lee y se escribe: el espacio mismo, o (en el panel del operador) un operador en su nombre. */
export interface Almacen {
  leer(): Promise<FilaDeWaba | null>;
  guardar(paso: string, datos: Record<string, unknown>): Promise<GuardadoDeWaba>;
}

/** Lo que el SDK de Meta precarga en el popup. Nada de esto se guarda. */
export interface SetupDeMeta {
  business: {
    name: string;
    email?: string;
    website?: string;
    phone?: { code: 54; number: string };
    address: { country: "AR" };
    timezone: "UTC-03:00";
  };
  phone: { displayName: string; category: CategoriaDePerfil; description: string };
}

/** Lo que el navegador cuenta del popup. Todo es una pista salvo el código. */
export interface PedidoDeVinculo {
  code: string;
  evento?: string;
  wabaId?: string;
  phoneNumberId?: string;
  /** El `userID` del `authResponse` del popup: el id de la persona en esta app, el mismo que firma el aviso de borrado de Meta. */
  userId?: string;
}

/* ── La base ──────────────────────────────────────────────────────────────── */

const GUARDADOS: ReadonlySet<string> = new Set<GuardadoDeWaba>([
  "ok",
  "no_aplica",
  "datos_invalidos",
  "de_la_plataforma",
  "id_ocupado",
  "numero_ocupado",
  "ya_conectado",
  "transicion",
  "cupo",
  "apagado",
  "app_ocupada",
  "otra_app",
  "webhook_pendiente",
]);

/** Los pasos que cambian `whatsapp_numeros`: la copia de la base del cliente se pone al día antes de contestar. */
const PASOS_QUE_SE_ESPEJAN: ReadonlySet<string> = new Set(["vincular", "conectar", "desconectar", "app_token"]);

const aFecha = (v: string | null | undefined): Date | null => (v ? new Date(v) : null);

/** El nombre de la restricción que rechazó una escritura (23505), con el error de Drizzle o sin él. */
function restriccionPg(e: unknown): string | null {
  for (const x of [e, (e as { cause?: unknown } | null | undefined)?.cause]) {
    const r = x as { constraint?: unknown; constraint_name?: unknown } | null | undefined;
    const nombre = r?.constraint ?? r?.constraint_name;
    if (typeof nombre === "string") return nombre;
  }
  return null;
}

/**
 * El almacén del espacio: lee y escribe contra control con la sesión de la persona.
 * La lectura es una sola consulta que parte del espacio (siempre hay fila) y le
 * cuelga la WABA y el número vivo, si los hay. La escritura nunca tira: lo que no
 * sea 'ok' lo decide quien llama.
 */
export function almacenDelInquilino(quien: QuienPide): Almacen {
  const { tenantId, userId, ip } = quien;
  return {
    async leer() {
      try {
        const filas = await enControl({ tenantId }, (db) =>
          db
            .select({
              estado: whatsappWabas.estado,
              falla: whatsappWabas.falla,
              wabaId: whatsappWabas.waba_id,
              businessId: whatsappWabas.business_id,
              numeroMeta: whatsappWabas.numero_meta,
              numeroAceptado: whatsappWabas.numero_aceptado,
              nombreEstado: whatsappWabas.nombre_estado,
              plantilla: whatsappWabas.plantilla_enviada_en,
              pinCifrado: whatsappWabas.pin_cifrado,
              numeroEstado: whatsappNumeros.estado,
              phoneNumberId: whatsappNumeros.phone_number_id,
              numeroTipeado: whatsappNumeros.numero_e164,
              wabaDelNumero: whatsappNumeros.waba_id,
              tokenCifrado: whatsappNumeros.token_cifrado,
              emailDeContacto: tenants.contact_email,
              nombreDelEspacio: tenants.name,
              origenDeWaba: whatsappWabas.origen,
              appId: whatsappWabas.app_id,
              secretoCifrado: whatsappWabas.app_secreto_cifrado,
              ruta: whatsappWabas.ruta_webhook,
              webhookVerificadoEn: whatsappWabas.webhook_app_verificado_en,
              datosAppEn: whatsappWabas.datos_app_en,
              primerMensajeEn: whatsappWabas.primer_mensaje_en,
              primeraRespuestaEn: whatsappWabas.primera_respuesta_en,
              slugLegal: whatsappWabas.slug_legal,
              razonSocial: whatsappWabas.razon_social,
              cuit: whatsappWabas.cuit,
              acuerdoVersion: whatsappWabas.acuerdo_version,
              recordatorioEn: whatsappWabas.recordatorio_en,
              puedeEnviar: whatsappWabas.puede_enviar,
              categoria: whatsappWabas.categoria_perfil,
            })
            .from(tenants)
            .leftJoin(whatsappWabas, eq(whatsappWabas.tenant_id, tenants.id))
            .leftJoin(whatsappNumeros, and(eq(whatsappNumeros.tenant_id, tenants.id), ne(whatsappNumeros.estado, "baja")))
            .where(eq(tenants.id, tenantId))
            .limit(1)
        );
        const f = filas[0];
        if (!f) return null;
        // El token es de la fila del número, pero sólo vale si es el de esta WABA.
        const propio = f.wabaId !== null && f.wabaDelNumero === f.wabaId;
        return {
          estado: f.estado,
          falla: f.falla,
          wabaId: f.wabaId,
          businessId: f.businessId,
          phoneNumberId: f.phoneNumberId,
          numeroTipeado: f.numeroTipeado,
          numeroMeta: f.numeroMeta,
          numeroAceptado: f.numeroAceptado === true,
          token: f.wabaId && propio ? abrirSobre(f.tokenCifrado, aadDelToken(tenantId, f.wabaId)) : null,
          pin: f.wabaId ? abrirSobre(f.pinCifrado, aadDelPin(tenantId, f.wabaId)) : null,
          nombreEstado: f.nombreEstado,
          plantillaEnviadaEn: f.plantilla ? new Date(f.plantilla) : null,
          numeroEstado: f.numeroEstado,
          emailDeContacto: f.emailDeContacto,
          nombreDelEspacio: f.nombreDelEspacio,
          origen: f.estado === null ? null : f.origenDeWaba === "app_propia" ? "app_propia" : "embedded_signup",
          appId: f.appId ?? null,
          // Un secreto que no abre queda en null: la acción que lo necesita pide cargarlo de nuevo.
          secreto: f.appId && f.secretoCifrado ? abrirSobre(f.secretoCifrado, aadDelSecreto(tenantId, f.appId)) : null,
          ruta: f.ruta ?? null,
          webhookAppVerificadoEn: aFecha(f.webhookVerificadoEn),
          datosAppEn: aFecha(f.datosAppEn),
          primerMensajeEn: aFecha(f.primerMensajeEn),
          primeraRespuestaEn: aFecha(f.primeraRespuestaEn),
          slugLegal: f.slugLegal ?? null,
          razonSocial: f.razonSocial ?? null,
          cuit: f.cuit ?? null,
          acuerdoVersion: f.acuerdoVersion ?? null,
          recordatorioEn: aFecha(f.recordatorioEn),
          puedeEnviar: f.puedeEnviar ?? null,
          categoria: categoriaDePerfil(f.categoria),
        };
      } catch (e) {
        const codigo = codigoPg(e);
        // Sin la 0051 (o sin la 0048) no hay nada que leer: la función de arriba contesta «apagado».
        if (codigo === "42P01" || codigo === "42703") return null;
        throw e;
      }
    },

    async guardar(paso, datos) {
      try {
        const filas = await enControl({ tenantId }, (db) =>
          db.execute(sql`
            select public.claimmix_waba_propia(
              ${tenantId}::uuid, ${userId}::uuid, ${paso}::text, ${JSON.stringify(datos)}::jsonb,
              ${wabaDeLaPlataforma()}::text, ${idDeLaPlataforma()}::text, ${process.env.META_APP_ID?.trim() || null}::text, ${ip}::inet
            ) as r
          `)
        );
        const crudo = filasDe<{ r?: unknown }>(filas)[0]?.r;
        const r = (typeof crudo === "string" ? JSON.parse(crudo) : crudo) as { resultado?: unknown } | null | undefined;
        const resultado = r?.resultado;
        const guardado = typeof resultado === "string" && GUARDADOS.has(resultado) ? (resultado as GuardadoDeWaba) : "error";
        if (guardado === "ok") {
          if (PASOS_QUE_SE_ESPEJAN.has(paso)) await espejarSinFallar(tenantId);
        } else {
          logger.info({ tenantId, paso, guardado }, "alta.waba_guardado");
        }
        return guardado;
      } catch (e) {
        const codigo = codigoPg(e);
        if (codigo === "23505") {
          const restriccion = restriccionPg(e);
          if (restriccion === "whatsapp_wabas_app_viva") return "app_ocupada";
          // La ruta o el slug salen de `randomBytes`/`randomInt`: chocar es una falla, no un dato de la persona.
          if (restriccion === "whatsapp_wabas_ruta" || restriccion === "whatsapp_wabas_slug_legal") {
            logger.error({ codigo, restriccion }, "alta.waba_guardado_fallo");
            return "error";
          }
          return "id_ocupado";
        }
        if (codigo === "42883" || codigo === "42P01" || codigo === "42703") return "sin_migracion";
        logger.error({ error: nombreDelError(e), codigo }, "alta.waba_guardado_fallo");
        return "error";
      }
    },
  };
}

/* ── Salidas ──────────────────────────────────────────────────────────────── */

/** Las salidas de `pasos-del-numero.ts` hablan de más cosas que las de la WABA propia: lo que no está en la lista es «meta». */
const aResultado = (r: ResultadoDelNumero): ResultadoDeWaba => (esResultadoDeWaba(r) ? r : "meta");

/** Una WABA que se mira a mano: el aviso sale después de contestar y la persona ve «revision». */
export const revisar = (motivo: MotivoDeRevision, tenantId: string): ResultadoDeWaba => aResultado(aRevision(motivo, tenantId));

/** Avisa al operador sin cambiar lo que la persona ve. */
export function avisar(motivo: MotivoDeRevision, tenantId: string): void {
  after(() => avisarNumeroEnRevision(motivo, tenantId));
}

/** Lo que la persona ve cuando la función de la base no dejó escribir el paso. */
export function resultadoDe(guardado: Exclude<GuardadoDeWaba, "ok">, tenantId: string): ResultadoDeApp {
  switch (guardado) {
    // Los cuatro que sólo existen en la vía de la app propia se cuentan como la base los dijo.
    case "apagado":
    case "app_ocupada":
    case "otra_app":
    case "webhook_pendiente":
      return guardado;
    case "no_aplica":
      return revisar("sin_dueno", tenantId);
    case "de_la_plataforma":
    case "id_de_la_plataforma":
      return "de_la_plataforma";
    case "id_ocupado":
    case "numero_ocupado":
      avisar("numero_ocupado", tenantId);
      return "numero_ocupado";
    case "ya_conectado":
      return "conectado";
    // Otro pedido ya movió la fila: lo que importa es lo que haya quedado, que se ve al refrescar.
    case "transicion":
      return "esperar";
    case "cupo":
      avisar("cupo_semanal", tenantId);
      return "cupo";
    case "sin_migracion":
      return "apagado";
    case "datos_invalidos":
    case "error":
      return "meta";
  }
}

/** Anota por qué quedó mal. Si la base no lo deja (la fila ya avanzó) no hay nada más que hacer. */
async function fallar(almacen: Almacen, falla: FallaDeWaba, extra: Record<string, unknown> = {}): Promise<void> {
  await almacen.guardar("estado", { estado: "falla", falla, ...extra });
}

/** Lo que hace falta para leer un rechazo de Graph de la app propia: con qué app, en qué paso y la ruta de su webhook. */
export interface EnApp {
  app: AppDelCliente;
  cred: CredencialDeAlta;
  ruta: string | null;
  paso: PasoDeAlta;
}

/** La falla queda anotada en la fila y el operador se entera, sin cambiar lo que la persona ve. */
async function caer(almacen: Almacen, tenantId: string, falla: FallaDeWaba, motivo: MotivoDeRevision): Promise<void> {
  await fallar(almacen, falla);
  avisar(motivo, tenantId);
}

/** Un rechazo de Graph tal como lo clasifica el alta: el código y, si Graph lo informó, el subcódigo. */
export type RechazoDeGraph = { falla: FallaDeGraph; codigo: number | null; subcodigo?: number | null };

/** Lo que un rechazo de Graph con el token de la app propia quiere decir, ya confirmado con Meta donde el código solo no alcanza. */
export type CausaDeRechazo = Exclude<MotivoDeAlta, "confirmar_app" | "confirmar_salud"> | "secreto_invalido" | "waba_bloqueada";

/** ¿La app del cliente sigue aceptando su secreto? Es la pregunta que separa un secreto rotado de un token vencido. */
async function veredictoDelSecreto(ctx: EnApp): Promise<"vale" | "invalido" | "esperar" | "meta"> {
  const app = await leerApp(ctx.app, (ctx.ruta ? urlDelWebhookDeApp(ctx.ruta) : null) ?? "");
  if (app.ok) return "vale";
  return app.falla === "rechazo" ? "invalido" : app.falla;
}

/**
 * Qué es un rechazo de Graph con el token de la app propia. Los códigos que son de la cuenta y no del mensaje
 * se separan en `errores-de-graph.ts`; los que dependen de otra pregunta se confirman acá y no se adivinan:
 * la autenticación (190 y 102) con `leerApp`, el 131031 fuera del registro con `leerSalud` y el 100, que
 * también es el de un `appsecret_proof` inválido (secreto rotado), con `leerApp`. No escribe: quien llama decide.
 */
export async function causaDeRechazo(g: RechazoDeGraph, ctx: EnApp): Promise<CausaDeRechazo> {
  const motivo = motivoDeAlta(ctx.paso, g.codigo, g.subcodigo);
  if (motivo === "confirmar_salud") {
    // El 131031 sólo dice «bloqueada» si la salud de la WABA lo confirma.
    const salud = await leerSalud(ctx.cred, ctx.cred.wabaId);
    if (salud.ok && salud.valor.puedeEnviar === "BLOCKED") return "waba_bloqueada";
    logger.warn({ codigo: g.codigo }, "alta.waba_131031_sin_bloqueo");
    return "meta";
  }
  if (motivo === "confirmar_app") {
    // Un rechazo de autenticación sin subcódigo: si la app tampoco entra es el secreto; si entra, es el token.
    const veredicto = await veredictoDelSecreto(ctx);
    return veredicto === "vale" ? "token_vencido" : veredicto === "invalido" ? "secreto_invalido" : veredicto;
  }
  if (g.falla === "rechazo" && g.codigo === PARAMETRO_INVALIDO && (motivo === "waba_invalida" || motivo === "meta")) {
    if ((await veredictoDelSecreto(ctx)) === "invalido") return "secreto_invalido";
  }
  return motivo;
}

/** Un rechazo de Graph con el token de la app propia: se anota la falla que le toca (`causaDeRechazo`) y, si es de la cuenta, el operador se entera. */
async function fallaDeGraphDeApp(
  almacen: Almacen,
  tenantId: string,
  g: RechazoDeGraph,
  causa: FallaDeWaba,
  motivo: MotivoDeRevision,
  ctx: EnApp
): Promise<ResultadoDeApp> {
  const que = await causaDeRechazo(g, ctx);
  switch (que) {
    case "esperar":
      return "esperar";
    case "falta_permiso":
    case "waba_no_asignada":
    case "waba_invalida":
    case "pin_incorrecto":
      return que;
    case "token_vencido":
      await caer(almacen, tenantId, "token_vencido", "token_vencido");
      return "token_vencido";
    case "secreto_invalido":
      await caer(almacen, tenantId, "secreto_invalido", "secreto_invalido");
      return "app_invalida";
    case "pago_pendiente":
    case "waba_restringida":
    case "waba_bloqueada":
      await caer(almacen, tenantId, que, que);
      return que;
    case "falta_pin": {
      const anotado = await almacen.guardar("estado", { estado: "falta_pin" });
      return anotado === "ok" ? "falta_pin" : resultadoDe(anotado, tenantId);
    }
    case "meta":
      if (g.falla !== "rechazo") return g.falla;
      await fallar(almacen, causa);
      return revisar(motivo, tenantId);
  }
}

/**
 * Lo que Graph contestó con el token del cliente, como lo ve la persona. Un rechazo
 * se anota con su causa y se mira a mano; reintentar no lo arregla. Un token que
 * Graph dice muerto es otra cosa: el cliente tiene que volver a conectar. Con `enApp`
 * (la app propia del cliente) el rechazo se lee con más detalle: `fallaDeGraphDeApp`.
 */
async function fallaDeGraph(
  almacen: Almacen,
  tenantId: string,
  g: RechazoDeGraph,
  causa: FallaDeWaba,
  motivo: MotivoDeRevision,
  enApp?: EnApp
): Promise<ResultadoDeApp> {
  if (g.codigo !== null && PIN_CON_ESPERA.has(g.codigo)) return "esperar";
  if (enApp) return fallaDeGraphDeApp(almacen, tenantId, g, causa, motivo, enApp);
  const efecto = efectoDeError(g.codigo);
  if (efecto === "token_vencido") {
    await fallar(almacen, "token_vencido");
    return revisar("token_vencido", tenantId);
  }
  if (efecto === "pago_pendiente") return revisar("pago_pendiente", tenantId);
  if (g.falla === "rechazo") {
    await fallar(almacen, causa);
    return revisar(motivo, tenantId);
  }
  return g.falla;
}

/** Nada de lo público tira: lo inesperado se anota por nombre y vuelve como `meta`. */
export async function sinTirar<T>(donde: string, enFalla: T, f: () => Promise<T>): Promise<T> {
  try {
    return await f();
  } catch (e) {
    logger.error({ error: nombreDelError(e), donde }, "alta.waba_fallo");
    return enFalla;
  }
}

/**
 * ¿El espacio ya tiene su WhatsApp conectado, por esta ruta o por el camino viejo?
 * Una WABA propia caída o reconectándose, con su número todavía vivo y su token, no:
 * tiene que poder volver a pasar por acá (es la misma lectura que `v_propio` en la 0051).
 */
export const yaConectada = (fila: FilaDeWaba) =>
  !reconectando({ estado: fila.estado, numero: fila.numeroEstado, conToken: fila.token !== null }) &&
  (fila.estado === "conectada" || fila.numeroEstado === "conectado" || fila.numeroEstado === "suspendido");

/** Una fila viva de la vía de la app propia del cliente. */
export const esDeApp = (fila: FilaDeWaba) =>
  fila.origen === "app_propia" && fila.estado !== null && fila.estado !== "cancelada" && fila.estado !== "revocada";

/**
 * ¿Meta informó otro número que el tipeado y la persona todavía no lo aceptó? Sin número tipeado (en la app
 * propia es opcional) no hay con qué comparar: pedir que lo acepte sería frenarla siempre.
 */
export const numeroPorAceptar = (fila: Pick<FilaDeWaba, "numeroAceptado" | "numeroMeta" | "numeroTipeado">) =>
  !fila.numeroAceptado && !!fila.numeroTipeado && !mismoNumero(fila.numeroMeta, fila.numeroTipeado);

/** La app del cliente de esta fila, con el secreto ya abierto. Null si no es de esa vía o el secreto no abrió. */
export function appDe(fila: FilaDeWaba | null): AppDelCliente | null {
  return fila && fila.origen === "app_propia" && fila.appId && fila.secreto ? { appId: fila.appId, secreto: fila.secreto } : null;
}

/** El `appsecret_proof` va como último argumento de cada llamada a Graph de la app propia; con Embedded Signup no hay y la llamada queda como era. */
export const conPrueba = (cred: CredencialDeAlta): [string] | [] => (cred.prueba ? [cred.prueba] : []);

export type Seguir =
  | { ok: true; fila: FilaDeWaba; cred: CredencialDeAlta; id: string; app: AppDelCliente | null }
  | { ok: false; resultado: ResultadoDeApp };

export const enAppDe = (listo: Extract<Seguir, { ok: true }>, paso: PasoDeAlta): EnApp | undefined =>
  listo.app ? { app: listo.app, cred: listo.cred, ruta: listo.fila.ruta, paso } : undefined;

/**
 * Lo que hace falta para seguir hablando con Graph en nombre del cliente, o por qué
 * no se puede. Sin token no hay vuelta atrás con lo que hay guardado: se abre el
 * popup de nuevo (o, con la app propia, el token se carga otra vez). `aunqueConectada`
 * es para lo que se hace con el número ya andando (volver a registrarlo con el nombre aprobado).
 */
export function paraSeguir(fila: FilaDeWaba | null, aunqueConectada = false): Seguir {
  if (!fila) return { ok: false, resultado: "apagado" };
  if (!aunqueConectada && yaConectada(fila)) return { ok: false, resultado: "conectado" };
  const { token, wabaId, phoneNumberId, estado } = fila;
  if (!token || !wabaId || !phoneNumberId || estado === null || estado === "cancelada" || estado === "revocada") {
    return { ok: false, resultado: "vencido" };
  }
  if (wabaId === wabaDeLaPlataforma() || phoneNumberId === idDeLaPlataforma()) {
    return { ok: false, resultado: "de_la_plataforma" };
  }
  const app = appDe(fila);
  // Una fila de la app propia sin su secreto no se puede firmar: la persona lo carga de nuevo.
  if (fila.origen === "app_propia" && !app) return { ok: false, resultado: "app_invalida" };
  const cred: CredencialDeAlta = {
    accessToken: token,
    wabaId,
    ...(app ? { prueba: pruebaDelSecreto(token, app.secreto) } : {}),
  };
  return { ok: true, fila, cred, id: phoneNumberId, app };
}

/**
 * El webhook de este ambiente y el número de la plataforma, que `fijarElWebhook` pide. Null si falta algo.
 * Con la app propia no hay webhook del número: el callback de la app del cliente ya apunta al espacio (R21).
 */
function entornoDelCliente(cred: CredencialDeAlta, app: AppDelCliente | null): Entorno | null {
  const plataforma = idDeLaPlataforma();
  const webhook = app ? null : webhookDelEntorno();
  if (!plataforma || (!app && !webhook)) {
    logger.warn({}, "alta.waba_sin_credencial");
    return null;
  }
  return { cred, plataforma, webhook };
}

/* ── Iniciar ──────────────────────────────────────────────────────────────── */

/**
 * Paso 0: antes de mostrar el botón de Meta, ¿hay lugar esta semana? No escribe nada.
 * Devuelve lo que el popup precarga; el nombre ya viene validado por quien llama.
 * El rubro lo elige el cliente; uno que no esté en la lista de Meta se descarta y
 * sale el inicial, porque Meta no aceptaría el popup con un valor inventado.
 */
export async function iniciarWaba(
  quien: QuienPide,
  datos: { nombre: string; web?: string; categoria?: CategoriaDePerfil }
): Promise<{ resultado: "listo"; setup: SetupDeMeta } | { resultado: ResultadoDeApp }> {
  const { tenantId } = quien;
  const toma = await tomar([
    { cual: "inicio", clave: claveDeCupo("wa:es:inicio", tenantId), limit: INICIOS_POR_DIA, windowMs: DIA_MS },
  ]);
  if (!toma.ok) return { resultado: "esperar" };

  let listo = false;
  try {
    const almacen = almacenDelInquilino(quien);
    const fila = await almacen.leer();
    if (!fila || !activaPara(fila, wabaPropia())) return { resultado: "apagado" };
    if (yaConectada(fila)) return { resultado: "conectado" };
    // Una alta que empezó con la app del cliente sigue por su camino; el popup no la pisa.
    if (esDeApp(fila)) return { resultado: "transicion" };

    const guardado = await almacen.guardar("iniciar", { tope: topeSemanal() });
    // Un espacio que no puede pasar por acá (sin alta automática, sin servicio) no es un número a mirar.
    if (guardado === "no_aplica") return { resultado: "revision" };
    if (guardado !== "ok") return { resultado: resultadoDe(guardado, tenantId) };

    const partes = fila.numeroTipeado ? partirNumero(fila.numeroTipeado) : null;
    const { nombre, web } = datos;
    const setup: SetupDeMeta = {
      business: {
        name: nombre,
        ...(fila.emailDeContacto ? { email: fila.emailDeContacto } : {}),
        ...(web ? { website: web } : {}),
        ...(partes ? { phone: { code: 54 as const, number: partes.numero } } : {}),
        address: { country: "AR" },
        timezone: "UTC-03:00",
      },
      phone: {
        displayName: nombre,
        category: categoriaDePerfil(datos.categoria) ?? CATEGORIA_INICIAL,
        description: getT(quien.idioma)("alta.whatsapp.descripcionPerfil").replace("{empresa}", nombre),
      },
    };
    listo = true;
    return { resultado: "listo", setup };
  } catch (e) {
    logger.error({ error: nombreDelError(e) }, "alta.waba_iniciar_fallo");
    return { resultado: "meta" };
  } finally {
    if (!listo) await soltar(toma.tomados);
  }
}

/* ── Vincular ─────────────────────────────────────────────────────────────── */

/**
 * Paso 1: el popup terminó. Canjea el código (vale 30 segundos y una sola vez),
 * le pregunta a Meta qué es el token y de ahí saca la WABA y el número: lo que el
 * navegador dijo sólo ayuda a elegir entre las que el token ya autoriza. Guarda el
 * vínculo con el token y un PIN que nadie ve, y sigue con `continuarWaba`, salvo
 * que el número de Meta no sea el que la persona tipeó: eso lo confirma ella.
 *
 * Los cupos se devuelven sólo si Graph no se tocó; desde el canje quedan gastados.
 */
export async function vincularWaba(
  quien: QuienPide,
  pedido: PedidoDeVinculo
): Promise<{ resultado: ResultadoDeApp; numeroMeta?: string }> {
  const { tenantId } = quien;
  let tomados: Tomado[] = [];
  let salio = false;
  try {
    const toma = await tomar([
      { cual: "vinculos", clave: claveDeCupo("wa:es", tenantId), limit: VINCULOS_POR_HORA, windowMs: HORA_MS },
    ]);
    if (!toma.ok) return { resultado: "esperar" };
    tomados = toma.tomados;

    const almacen = almacenDelInquilino(quien);
    const fila = await almacen.leer();
    if (!fila || !activaPara(fila, wabaPropia())) return { resultado: "apagado" };
    if (yaConectada(fila)) return { resultado: "conectado" };
    // El código del popup no se gasta en una alta que va por la app del cliente.
    if (esDeApp(fila)) return { resultado: "transicion" };
    const wabaPlataforma = wabaDeLaPlataforma();
    const idPlataforma = idDeLaPlataforma();
    if (!wabaPlataforma || !idPlataforma) return { resultado: revisar("sin_credencial", tenantId) };

    // Estos dos finales los dice el evento del popup, que escribe el navegador y no hay token que lo confirme: se corta antes de gastar el código, sin escribir nada. Dejarlo en falla por un evento sin verificar pisaría una conexión a medias; el mismo final, confirmado con Graph, sí se anota más abajo.
    if (pedido.evento === EVENTO_SOLO_WABA) return { resultado: "sin_numero" };
    if (pedido.evento === EVENTO_APP_DE_WHATSAPP) return { resultado: "coexistencia" };

    salio = true;
    const canje = await canjearCodigo(pedido.code);
    if (!canje.ok) {
      if (canje.falla === "esperar") return { resultado: "esperar" };
      // Sólo un código vencido o ya usado se arregla abriendo el popup de nuevo; otro rechazo (la app o su secreto mal puestos) no.
      if (codigoVencido(canje)) return { resultado: "vencido" };
      await fallar(almacen, "canje");
      avisar("canje", tenantId);
      return { resultado: "meta" };
    }
    const token = canje.valor.token;

    const revisado = await revisarToken(token);
    if (!revisado.ok) {
      if (revisado.falla !== "rechazo") return { resultado: revisado.falla };
      await fallar(almacen, "token_invalido");
      return { resultado: revisar("canje", tenantId) };
    }
    const { wabaIds } = revisado.valor;
    // El token del canje es de un usuario del sistema: su `user_id` no es el de la persona. Con el del popup el aviso de borrado de Meta encuentra la fila; sin él queda el del token.
    const fbUserId = [pedido.userId, revisado.valor.fbUserId].find((id) => id && ID_DE_USUARIO_DE_META.test(id));

    const waba = pedido.wabaId && wabaIds.includes(pedido.wabaId) ? pedido.wabaId : wabaIds.length === 1 ? wabaIds[0] : null;
    if (!waba) {
      // Ninguna WABA autorizada, o varias y el navegador no dijo cuál: no se adivina.
      await fallar(almacen, "token_invalido");
      return { resultado: revisar("canje", tenantId) };
    }
    if (waba === wabaPlataforma) return { resultado: "de_la_plataforma" };

    let phoneNumberId: string | null = null;
    if (pedido.phoneNumberId) {
      const esta = await estaEnLaWaba(waba, pedido.phoneNumberId, token);
      if (esta === null) return { resultado: "meta" };
      if (esta) phoneNumberId = pedido.phoneNumberId;
    }
    if (!phoneNumberId) {
      const lista = await recorrerLaWaba(waba, "id", token);
      // Una lista a medias no es una lista: ante la duda se cierra.
      if (!lista?.completa) return { resultado: "meta" };
      const ids = lista.filas.flatMap((f) => (f.id ? [f.id] : []));
      if (ids.length === 0) {
        await fallar(almacen, "sin_numero");
        return { resultado: "sin_numero" };
      }
      if (ids.length > 1) return { resultado: "meta" };
      phoneNumberId = ids[0];
    }
    if (phoneNumberId === idPlataforma) return { resultado: "de_la_plataforma" };

    const datos = await datosDelNumero(token, phoneNumberId);
    if (!datos.ok) {
      return { resultado: await fallaDeGraph(almacen, tenantId, datos, "token_invalido", "canje") };
    }
    if (datos.valor.enLaApp) {
      await fallar(almacen, "coexistencia");
      return { resultado: "coexistencia" };
    }
    const numeroMeta = normalizarE164(datos.valor.display);
    if (!numeroMeta) return { resultado: "meta" };
    if (!numeroMeta.startsWith("+54")) return { resultado: revisar("pais", tenantId) };
    if (esNumeroDeOtroAmbiente(phoneNumberId, numeroMeta)) return { resultado: revisar("de_otro_ambiente", tenantId) };

    // El portfolio lo cuenta el cupo semanal: sale de Meta, no del navegador. Si Meta no lo informa la WABA cuenta como el suyo.
    const negocio = await negocioDeLaWaba(token, waba);
    if (!negocio.ok && negocio.falla !== "rechazo") return { resultado: negocio.falla };

    // Si la misma WABA se vuelve a vincular se conserva el PIN: el número ya registrado lo exige idéntico.
    const pin = fila.pin && fila.wabaId === waba ? fila.pin : String(randomInt(0, 1_000_000)).padStart(6, "0");
    const guardado = await almacen.guardar("vincular", {
      business_id: (negocio.ok && negocio.valor) || waba,
      waba_id: waba,
      phone_number_id: phoneNumberId,
      numero_meta: numeroMeta,
      ...(fbUserId ? { fb_user_id: fbUserId } : {}),
      token_cifrado: cifrar(token, aadDelToken(tenantId, waba)),
      pin_cifrado: cifrar(pin, aadDelPin(tenantId, waba)),
      tope: topeSemanal(),
    });
    if (guardado !== "ok") return { resultado: resultadoDe(guardado, tenantId) };

    // La base ya pisó el token de la WABA anterior: se la suelta con el que se leyó antes, o Meta le sigue mandando eventos a una WABA que nadie conoce.
    const { token: tokenViejo, wabaId: wabaVieja, phoneNumberId: numeroViejo } = fila;
    if (tokenViejo && wabaVieja && wabaVieja !== waba) {
      after(() => soltarEnMeta(tenantId, tokenViejo, wabaVieja, numeroViejo === phoneNumberId ? null : numeroViejo));
    }

    if (fila.numeroTipeado && !mismoNumero(numeroMeta, fila.numeroTipeado)) return { resultado: "numero_distinto", numeroMeta };
    return { resultado: await continuarWaba(tenantId, almacen) };
  } catch (e) {
    logger.error({ error: nombreDelError(e) }, "alta.waba_vincular_fallo");
    return { resultado: "meta" };
  } finally {
    if (!salio) await soltar(tomados);
  }
}

/* ── Continuar ────────────────────────────────────────────────────────────── */

/**
 * Crea `reabrir_denuncia` en la WABA del cliente, ya con el número conectado. Va
 * después de contestar: no se espera a Meta para decirle que está listo. Si falla, el
 * número funciona dentro de las 24 horas y la tarea programada lo reintenta.
 */
async function crearLaPlantilla(tenantId: string, almacen: Almacen, cred: CredencialDeAlta): Promise<void> {
  try {
    const creada = await crearPlantillaReabrir(cred.accessToken, cred.wabaId, ...conPrueba(cred));
    if (creada.ok) {
      await almacen.guardar("estado", { estado: "conectada", plantilla_enviada_en: new Date().toISOString() });
    } else {
      await avisarNumeroEnRevision("plantilla", tenantId);
    }
  } catch (e) {
    logger.error({ error: nombreDelError(e) }, "alta.waba_plantilla_fallo");
    await avisarNumeroEnRevision("plantilla", tenantId);
  }
}

/**
 * El perfil del número con la app propia: Meta lo trae casi vacío, y se completa con el correo del espacio, el
 * rubro que el cliente eligió (el inicial si no eligió) y una descripción con la razón social. Sólo escribe lo que está vacío (nunca pisa lo que el
 * cliente puso) y no frena nada: si no sale, el cliente lo edita en WhatsApp Manager.
 */
async function completarElPerfil(fila: FilaDeWaba, cred: CredencialDeAlta, id: string): Promise<void> {
  try {
    const perfil = await completarPerfil(cred, id, {
      ...(fila.emailDeContacto ? { email: fila.emailDeContacto } : {}),
      vertical: fila.categoria ?? CATEGORIA_INICIAL,
      ...(fila.razonSocial
        ? { descripcion: getT("es-AR")("alta.whatsapp.descripcionPerfil").replace("{empresa}", fila.razonSocial) }
        : {}),
    });
    if (!perfil.ok) logger.warn({ falla: perfil.falla, codigo: perfil.codigo }, "alta.app_perfil_no_se_completo");
  } catch (e) {
    logger.warn({ error: nombreDelError(e) }, "alta.app_perfil_fallo");
  }
}

/**
 * Paso 2, y todo lo que sigue hasta «conectado»: suscribe la app a la WABA, mira si
 * el número ya tiene el código verificado y el registro, le pone su webhook propio y
 * lo deja conectado. Cada vuelta empieza por lo que la base y Graph dicen que falta,
 * así que repetirla (un corte, un «reintentar», la persona que vuelve del código) no
 * repite lo que ya está hecho.
 * `leida` es la fila que quien llama ya leyó en esta misma llamada: se usa tal cual para no pedirla de nuevo
 * (una consulta por endpoint). Si quien llama escribió antes, no la pasa y se lee la de ahora.
 */
export async function continuarWaba(tenantId: string, almacen: Almacen, leida?: FilaDeWaba | null): Promise<ResultadoDeApp> {
  return sinTirar<ResultadoDeApp>("continuar", "meta", async () => {
    const listo = paraSeguir(leida === undefined ? await almacen.leer() : leida);
    if (!listo.ok) return listo.resultado;
    const { fila, cred, id, app } = listo;
    const { accessToken: token, wabaId } = cred;
    // Si Meta informó otro número que el tipeado, no se sigue sin que la persona lo acepte.
    if (numeroPorAceptar(fila)) return "numero_distinto";
    const entorno = entornoDelCliente(cred, app);
    if (!entorno) return revisar("sin_credencial", tenantId);

    const suscripta = await suscribirApp(token, wabaId, ...conPrueba(cred));
    if (!suscripta.ok) return fallaDeGraph(almacen, tenantId, suscripta, "suscripcion", "suscripcion", enAppDe(listo, "waba"));

    const datos = await datosDelNumero(token, id, ...conPrueba(cred));
    if (!datos.ok) return fallaDeGraph(almacen, tenantId, datos, "registro", "registro", enAppDe(listo, "numero"));
    if (datos.valor.enLaApp) {
      await fallar(almacen, "coexistencia");
      return "coexistencia";
    }
    const nombreEstado = datos.valor.nombreEstado && NOMBRE_ESTADO.test(datos.valor.nombreEstado) ? datos.valor.nombreEstado : null;
    if (nombreEstado === "DECLINED") {
      await fallar(almacen, "nombre_rechazado", { nombre_estado: nombreEstado });
      return revisar("nombre_rechazado", tenantId);
    }

    // `register` pone un PIN nuevo cada vez y Meta rechaza un segundo con otro: si ya está, no se llama.
    // Y un número ya registrado no necesita código: la verificación vence aunque el registro siga activo.
    const registrado = await numeroYaRegistrado(cred, id);
    if (!registrado.ok) return fallaDeGraph(almacen, tenantId, registrado, "registro", "registro", enAppDe(listo, "numero"));
    const faltaCodigo = !registrado.valor && !datos.valor.verificado;

    // Un solo asiento del estado en el que queda esta vuelta; si la base no lo deja (se desconectó o se canceló mientras tanto) no se sigue con Graph.
    const destino = faltaCodigo ? "falta_codigo" : fila.estado === "falta_pin" ? "falta_pin" : "suscripta";
    if (fila.estado !== destino || (nombreEstado && nombreEstado !== fila.nombreEstado)) {
      const anotado = await almacen.guardar("estado", { estado: destino, ...(nombreEstado ? { nombre_estado: nombreEstado } : {}) });
      if (anotado !== "ok") return resultadoDe(anotado, tenantId);
    }
    if (faltaCodigo) return "falta_codigo";

    if (!registrado.valor) {
      // Meta ya rechazó el PIN al azar: volver a mandarlo es otro intento fallido contra el bloqueo del número. Sólo `pinWaba` registra, con el de la persona.
      if (fila.estado === "falta_pin") return "falta_pin";
      if (!fila.pin) return "vencido";
      const toma = await tomar(cuposDeRegistrar(tenantId));
      if (!toma.ok) return "esperar";
      const registro = await registrarNumero(cred, id, fila.pin);
      if (!registro.ok) {
        // El número ya tenía verificación en dos pasos propia: el PIN que sirve lo sabe sólo la persona.
        if (registro.codigo === PIN_NO_COINCIDE) {
          const anotado = await almacen.guardar("estado", { estado: "falta_pin" });
          return anotado === "ok" ? "falta_pin" : resultadoDe(anotado, tenantId);
        }
        return fallaDeGraph(almacen, tenantId, registro, "registro", "registro", enAppDe(listo, "registrar"));
      }
    }

    // La compuerta del webhook de la app propia: sin la verificación de Meta, o con el callback de la app apuntando a otro lado, el número no se conecta.
    if (app) {
      if (!fila.webhookAppVerificadoEn) return "webhook_pendiente";
      const nuestra = fila.ruta ? urlDelWebhookDeApp(fila.ruta) : null;
      if (nuestra) {
        const callback = await leerApp(app, nuestra);
        if (callback.ok && callback.valor === "ajeno") return "webhook_pendiente";
      }
    }

    // Sin webhook propio, lo que le escriban cae en el de la WABA del cliente, que no es éste. (Con la app propia no hay: el callback de la app ya apunta acá.)
    const sinWebhook = await fijarElWebhook(tenantId, id, entorno);
    if (sinWebhook) {
      if (sinWebhook === "revision") await fallar(almacen, "webhook");
      return aResultado(sinWebhook);
    }

    const guardado = await almacen.guardar("conectar", { phone_number_id: id });
    if (guardado !== "ok") return resultadoDe(guardado, tenantId);

    if (app || !fila.plantillaEnviadaEn) {
      after(async () => {
        if (app) await completarElPerfil(fila, cred, id);
        if (!fila.plantillaEnviadaEn) await crearLaPlantilla(tenantId, almacen, cred);
      });
    }
    return "conectado";
  });
}

/* ── Lo que la persona hace entre medio ───────────────────────────────────── */

/** ¿Queda lugar en el cupo de seguir de este espacio? Gasta un intento. */
export async function cupoDeSeguir(tenantId: string): Promise<boolean> {
  const toma = await tomar([{ cual: "seguir", clave: claveDeCupo("wa:es:seguir", tenantId), limit: SEGUIDAS_POR_HORA, windowMs: HORA_MS }]);
  return toma.ok;
}

/** La persona confirma que el número que Meta informó es el suyo, aunque no sea el que tipeó. */
export async function aceptarNumero(quien: QuienPide): Promise<ResultadoDeApp> {
  return sinTirar<ResultadoDeApp>("aceptar", "meta", async () => {
    if (!(await cupoDeSeguir(quien.tenantId))) return "esperar";
    const almacen = almacenDelInquilino(quien);
    if (!activaPara(await almacen.leer(), wabaPropia())) return "apagado";
    const guardado = await almacen.guardar("aceptar_numero", {});
    // «transicion» es que ya había avanzado (otra pestaña, un doble clic): se sigue desde donde quedó.
    if (guardado === "ok" || guardado === "transicion") return continuarWaba(quien.tenantId, almacen);
    return resultadoDe(guardado, quien.tenantId);
  });
}

/**
 * «Reintentar» de la persona: retoma como `continuarWaba`, con el cupo de seguir del espacio. La fila se lee una
 * sola vez y sigue a `continuarWaba`; `leida` es la que quien llama ya trajo.
 */
export async function reintentarWaba(quien: QuienPide, leida?: FilaDeWaba | null): Promise<ResultadoDeApp> {
  return sinTirar<ResultadoDeApp>("reintentar", "meta", async () => {
    if (!(await cupoDeSeguir(quien.tenantId))) return "esperar";
    const almacen = almacenDelInquilino(quien);
    const fila = leida === undefined ? await almacen.leer() : leida;
    if (!activaPara(fila, wabaPropia())) return "apagado";
    return continuarWaba(quien.tenantId, almacen, fila);
  });
}

/**
 * El código del número: pedirlo por SMS o llamada, o entregarlo. Los cupos del pedido
 * son los del número por código, que cuestan lo mismo contra los topes de Meta, y se
 * devuelven sólo si Graph no se tocó. El código de seis dígitos vive en esta llamada.
 */
export async function codigoWaba(
  quien: QuienPide,
  accion: { accion: MetodoDeCodigo } | { accion: "verificar"; codigo: string }
): Promise<ResultadoDeApp> {
  const { tenantId } = quien;
  const verificar = accion.accion === "verificar";
  if (verificar && !CODIGO_DE_SEIS.test(accion.codigo)) return "codigo_incorrecto";

  const topes = topesDelNumero();
  const toma = await tomar(verificar ? cuposDeVerificar(tenantId, topes) : cuposDePedirCodigo(tenantId, quien.ip, topes));
  if (!toma.ok) return "esperar";

  let salio = false;
  try {
    const almacen = almacenDelInquilino(quien);
    const leida = await almacen.leer();
    if (!activaPara(leida, wabaPropia())) return "apagado";
    const listo = paraSeguir(leida);
    if (!listo.ok) return listo.resultado;
    const { cred, id } = listo;

    salio = true;
    if (!verificar) {
      const pedido = await pedirCodigoAMeta(cred, id, accion.accion, quien.idioma);
      return pedido.ok
        ? "codigo_enviado"
        : await fallaDeGraph(almacen, tenantId, pedido, "registro", "registro", enAppDe(listo, "numero"));
    }

    const verificado = await verificarCodigoEnMeta(cred, id, accion.codigo);
    if (!verificado.ok) {
      if (verificado.falla !== "rechazo") return verificado.falla;
      // Meta rechaza un código que ya aceptó (un intento anterior que se cortó): si figura verificado, se sigue.
      const yaVerificado = await codigoYaVerificado(cred, id);
      if (!yaVerificado.ok) {
        return await fallaDeGraph(almacen, tenantId, yaVerificado, "registro", "registro", enAppDe(listo, "numero"));
      }
      if (!yaVerificado.valor) return "codigo_incorrecto";
    }
    return await continuarWaba(tenantId, almacen);
  } catch (e) {
    logger.error({ error: nombreDelError(e) }, "alta.waba_codigo_fallo");
    return "meta";
  } finally {
    if (!salio) await soltar(toma.tomados);
  }
}

/**
 * El PIN del segundo factor que el número ya tenía. Se prueba contra `register`; si
 * Meta lo acepta se guarda cifrado (es el que sirve de ahora en más) y se sigue. Ni el
 * PIN que escribió la persona ni el generado llegan a un resultado o a un registro.
 */
export async function pinWaba(quien: QuienPide, pin: string): Promise<ResultadoDeApp> {
  if (!CODIGO_DE_SEIS.test(pin)) return "pin_incorrecto";
  return sinTirar<ResultadoDeApp>("pin", "meta", async () => {
    const { tenantId } = quien;
    const almacen = almacenDelInquilino(quien);
    const leida = await almacen.leer();
    if (!activaPara(leida, wabaPropia())) return "apagado";
    const listo = paraSeguir(leida);
    if (!listo.ok) return listo.resultado;
    const { fila, cred, id } = listo;
    if (fila.estado !== "falta_pin") return "esperar";

    const toma = await tomar(cuposDeRegistrar(tenantId));
    if (!toma.ok) return "esperar";

    const registro = await registrarNumero(cred, id, pin);
    if (!registro.ok) {
      if (registro.codigo === PIN_NO_COINCIDE) return "pin_incorrecto";
      return fallaDeGraph(almacen, tenantId, registro, "registro", "registro", enAppDe(listo, "pin"));
    }
    const anotado = await almacen.guardar("estado", { estado: "suscripta", pin_cifrado: cifrar(pin, aadDelPin(tenantId, cred.wabaId)) });
    if (anotado !== "ok") return resultadoDe(anotado, tenantId);
    return continuarWaba(tenantId, almacen);
  });
}

/**
 * La persona cerró el popup. Se anota en qué paso, sólo de una lista: el nombre del
 * paso y el código de error vienen de un evento que escribe el navegador y no entran
 * al registro ni a la base como llegaron.
 */
export async function cancelarWaba(quien: QuienPide, paso: unknown, codigo?: number): Promise<"cancelado"> {
  const cancelado = pasoCancelado(paso);
  await sinTirar("cancelar", null, async () => {
    logger.info(
      { tenantId: quien.tenantId, paso: cancelado, codigo: typeof codigo === "number" && Number.isInteger(codigo) ? codigo : null },
      "alta.waba_cancelada"
    );
    return almacenDelInquilino(quien).guardar("cancelar", { paso: cancelado });
  });
  return "cancelado";
}

/* ── Desconectar ──────────────────────────────────────────────────────────── */

/**
 * Suelta la WABA del cliente en Meta: da de baja el número y saca nuestra app. Corre
 * después de contestar, con el token que `desconectarWaba` leyó antes de que la base lo
 * borrara. Si algo no sale queda una WABA vinculada que la base ya no tiene: se avisa,
 * salvo cuando el token ya estaba muerto (el cliente sacó la app él mismo).
 */
export async function soltarEnMeta(
  tenantId: string,
  token: string,
  wabaId: string,
  phoneNumberId: string | null,
  app?: { prueba?: string }
): Promise<void> {
  try {
    const cred: CredencialDeAlta = { accessToken: token, wabaId, ...(app?.prueba ? { prueba: app.prueba } : {}) };
    // El número se registra antes de pasar a conectado: uno que la base tiene como «pedido» puede estar registrado en Meta
    // o no. Sólo se da de baja el que Meta tiene registrado; si no lo dice se intenta igual, que dejarlo registrado cuesta más.
    const registrado = phoneNumberId ? await numeroYaRegistrado(cred, phoneNumberId) : null;
    const sinRegistro = registrado?.ok === true && !registrado.valor;
    const baja = phoneNumberId && !sinRegistro ? await bajaDelNumero(token, phoneNumberId, ...conPrueba(cred)) : null;
    const desuscripta = await desuscribirApp(token, wabaId, ...conPrueba(cred));
    const fallas = [registrado, baja, desuscripta].flatMap((r) => (r && !r.ok ? [r] : []));
    if (fallas.length === 0) return;
    logger.warn({ tenantId, fallas: fallas.map((f) => f.falla) }, "alta.waba_desvinculacion_incompleta");
    // Con la app propia, un número que sigue registrado en la API de WhatsApp tiene su propio aviso: el cliente no puede usarlo en la app del celular.
    const bajaFallida = app !== undefined && baja?.ok === false;
    if (bajaFallida) await avisarNumeroEnRevision("baja_fallida", tenantId);
    // El token ya estaba muerto (el cliente sacó la app): desvincular no puede, y no es una WABA huérfana.
    if (fallas.some((f) => !(bajaFallida && f === baja) && efectoDeError(f.codigo) !== "token_vencido")) {
      await avisarNumeroEnRevision("waba_huerfana", tenantId);
    }
  } catch (e) {
    logger.error({ error: nombreDelError(e) }, "alta.waba_desvinculacion_fallo");
    await avisarNumeroEnRevision("waba_huerfana", tenantId);
  }
}

/**
 * El cliente se va. La base borra el token y el PIN, deja el número en baja y la WABA
 * revocada; después, en Meta, se da de baja el número y se saca la app. Repetirlo con
 * todo ya desconectado vuelve «desconectado».
 */
export async function desconectarWaba(quien: QuienPide): Promise<"desconectado" | "meta"> {
  return sinTirar<"desconectado" | "meta">("desconectar", "meta", async () => {
    const { tenantId } = quien;
    const almacen = almacenDelInquilino(quien);
    const fila = await almacen.leer();
    if (!fila) return "meta";

    const guardado = await almacen.guardar("desconectar", {});
    if (guardado === "ok") {
      const { token, wabaId, phoneNumberId } = fila;
      if (token && wabaId) {
        // La baja de la app propia lleva su `appsecret_proof`; con Embedded Signup la llamada es la de siempre.
        const app = fila.origen === "app_propia" ? { prueba: fila.secreto ? pruebaDelSecreto(token, fila.secreto) : undefined } : undefined;
        after(() => soltarEnMeta(tenantId, token, wabaId, phoneNumberId, app));
      }
      return "desconectado";
    }
    return guardado === "transicion" && (fila.estado === null || fila.estado === "revocada") ? "desconectado" : "meta";
  });
}

/* ── El nombre visible aprobado (M5) ──────────────────────────────────────── */

/**
 * Meta aprobó el nombre visible del número: hasta 14 días después hay que volver a registrarlo o el nombre no
 * rige, y registrar antes de la aprobación no hace nada. Registra con el PIN guardado, gastando el cupo de
 * `wa:registrar` (el límite de 72 h de Meta es por número), aunque Graph diga que el número ya está registrado.
 * No escribe `conectada`: quien llama decide qué hacer con una fila que había caído por el nombre. Sólo actúa sobre
 * una fila conectada o caída por `nombre_rechazado`; cualquier otra no tiene nada que registrar.
 * `leida` es la fila que quien llama ya leyó en esta misma llamada, para no pedirla otra vez.
 */
export async function registrarConNombreAprobado(
  tenantId: string,
  almacen: Almacen,
  leida?: FilaDeWaba | null
): Promise<ResultadoDeApp | "registrado"> {
  return sinTirar<ResultadoDeApp | "registrado">("nombre_aprobado", "meta", async () => {
    const listo = paraSeguir(leida === undefined ? await almacen.leer() : leida, true);
    if (!listo.ok) return listo.resultado;
    const { fila, cred, id } = listo;
    if (!(fila.estado === "conectada" || (fila.estado === "falla" && fila.falla === "nombre_rechazado"))) return "transicion";
    if (!fila.pin) return "vencido";
    const toma = await tomar(cuposDeRegistrar(tenantId));
    if (!toma.ok) return "esperar";
    const registro = await registrarNumero(cred, id, fila.pin);
    if (registro.ok) return "registrado";
    if (registro.codigo === PIN_NO_COINCIDE) {
      const anotado = await almacen.guardar("estado", { estado: "falta_pin" });
      return anotado === "ok" ? "falta_pin" : resultadoDe(anotado, tenantId);
    }
    return fallaDeGraph(almacen, tenantId, registro, "registro", "registro", enAppDe(listo, "registrar"));
  });
}
