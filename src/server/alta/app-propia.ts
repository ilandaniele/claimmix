/**
 * El alta con la app de Meta que crea el propio cliente: lo que cada ventana del asistente
 * de /conectar-whatsapp/app le pide al servidor.
 *
 * Es el orden de los pasos y nada más. Graph lo hablan `app-del-cliente.ts` y
 * `embedded-signup.ts`; lo que se escribe en la fila pasa por la función de la 0051
 * (`claimmix_waba_propia`) a través del almacén de `waba-propia.ts`, y el final del
 * camino (suscribir, registrar, conectar) es el mismo `continuarWaba` de Embedded Signup:
 * la fila de `app_propia` sólo cambia qué se pide, con qué firma y qué se espera.
 *
 *   P0  `iniciarApp`: el acuerdo, la razón social y el CUIT.
 *   P1  `credencialesDeApp`: el App ID y el App Secret de la app.
 *   P1B los datos legales de la app que se completan a mano si no se cargaron solos (sólo el navegador).
 *   E14 `webhookDeApp`: la dirección y la marca que el cliente pega en su app.
 *   P2  sumar el número a la cuenta de WhatsApp y elegir su categoría (sólo el navegador).
 *   P3  `tokenDeApp`: el token del usuario del sistema; de él salen la WABA y el número.
 *   E10 `nombreDeApp`, `reintentarDeApp` y `nombreAprobado`: el nombre visible del número.
 *   `estadoDeApp` dice en qué ventana está el cliente; no habla con Graph.
 *
 * Nada acá tira: lo inesperado vuelve como `meta` y se anota. El secreto de la app, el
 * token, el PIN y la prueba de la firma no salen de este archivo hacia un resultado, un
 * registro ni el navegador; la marca del webhook (`verifyToken`) sí vuelve, porque es lo
 * que el cliente pega en su app y Meta la manda en cada verificación.
 */

import "server-only";

import { createHash, randomBytes, randomInt, timingSafeEqual } from "node:crypto";

import { getT } from "@/lib/i18n";
import { ID_DE_META } from "@/lib/meta-ids";
import { logger } from "@/lib/observability/logger";
import { cifrar } from "@/lib/security/cifrado";
import type { CategoriaDePerfil } from "@/lib/whatsapp-categorias";
import { almacenDelDueno, nombreRehabilitado, recordatorioEnviado } from "@/server/alta/panel-operador";
import { derivar } from "@/server/alta/sellado";
import type { QuienPide } from "@/server/alta/pasos-del-numero";
import { mismoNumero, normalizarE164 } from "@/server/alta/validar";
import {
  almacenDelInquilino,
  causaDeRechazo,
  continuarWaba,
  cupoDeSeguir,
  enAppDe,
  esDeApp,
  numeroPorAceptar,
  paraSeguir,
  registrarConNombreAprobado,
  reintentarWaba,
  resultadoDe,
  revisar,
  sinTirar,
  yaConectada,
  type EnApp,
  type FilaDeWaba,
  type GuardadoDeWaba,
  type RechazoDeGraph,
} from "@/server/alta/waba-propia";
import { activaPara, appPropia, urlDelWebhookDeApp } from "@/server/alta/waba-propia-activa";
import { VERSION_DEL_ANEXO, type ResultadoDeApp } from "@/server/alta/waba-resultados";
import { leerAltasAMedias } from "@/server/alta/wabas-del-cliente";
import { esNumeroDeOtroAmbiente } from "@/server/ambiente/de-otro-ambiente";
import type { CredencialDeAlta, FallaDeGraph } from "@/server/whatsapp/alta-de-numero";
import {
  CAMPOS_DEL_WEBHOOK,
  FORMATO_SECRETO,
  FORMATO_TOKEN,
  fijarDatosDeLaApp,
  leerApp,
  leerDatosDeLaApp,
  leerEstadoDelNombre,
  pareceToken,
  pedirNombreNuevo,
  pruebaDelSecreto,
  recortar,
  revisarTokenDeApp,
  suscribirWebhookDeApp,
  type AppDelCliente,
  type RevisionDeToken,
} from "@/server/whatsapp/app-del-cliente";
import { datosDelNumero } from "@/server/whatsapp/embedded-signup";
import type { PasoDeAlta } from "@/server/whatsapp/errores-de-graph";
import { idDeLaPlataforma, wabaDeLaPlataforma } from "@/server/whatsapp/numeros";
import { aadDelPin, aadDelToken, cerrarSecreto } from "@/server/whatsapp/sobres-del-cliente";
import { estaEnLaWaba, recorrerLaWabaOFalla, type FilaDeLaWaba } from "@/server/whatsapp/verificar-en-meta";
import { enviarCorreoDelSistema, remitenteDelSistema } from "@/server/notify/remitente-sistema";

export { urlDelWebhookDeApp };

/** En qué ventana del asistente está el cliente. Las de la lista corta (P1 a P4) son pasos; E* son ventanas de lo que pasa en el medio; G es la pantalla de gestión. */
export type PasoDelAsistente = "P0" | "P1" | "P1B" | "E14" | "P2" | "P4" | "E3" | "E4" | "E5" | "seguir" | "G";

/** Lo que el cliente pega en su app de Meta para que el webhook quede verificado. `aviso` dice si algo del callback actual pide mirarlo. */
export interface DatosDelWebhook {
  url: string;
  verifyToken: string;
  aviso: "ajeno" | "revisar" | null;
}

/** Lo que la pantalla necesita saber para elegir ventana; sale de una sola lectura y nunca lleva secretos. */
export interface EstadoDeApp {
  paso: PasoDelAsistente;
  estado: string | null;
  falla: string | null;
  appId: string | null;
  webhookVerificado: boolean;
  datosApp: boolean;
  numero: string | null;
  nombreEstado: string | null;
  plantilla: boolean;
  primerMensaje: boolean;
  primeraRespuesta: boolean;
  puedeEnviar: string | null;
}

export interface RespuestaDeToken {
  resultado: ResultadoDeApp;
  /** El número que Meta informó, cuando no es el tipeado (E5). */
  numeroMeta?: string;
  /** Los números de la WABA entre los que elegir (`elegir_numero`). */
  numeros?: { id: string; display: string }[];
  /** El permiso que falta (`falta_permiso`) o el que sobra (`permisos_de_mas`). */
  permiso?: string;
  permisos?: string[];
}

const NUMEROS_MAXIMOS = 20;
const PERMISOS_MAXIMOS = 20;
const NOMBRE_MAXIMO = 60;
const RAZON_MAXIMA = 120;
const NOMBRE_DE_PERMISO = /^[a-z_]{1,64}$/;
const CASILLAS_DEL_SLUG = "abcdefghijklmnopqrstuvwxyz0123456789";
const PESOS_DEL_CUIT = [5, 4, 3, 2, 7, 6, 5, 4, 3, 2] as const;
/** Cuántas veces se intenta dejar el webhook configurado por API, y cuánto se espera entre una y otra. */
const ESPERAS_DEL_WEBHOOK_MS = [1_000, 3_000] as const;
/** Un alta de la app propia que lleva tantas horas a medias recibe un recordatorio. */
const HORAS_DEL_RECORDATORIO = 24;
/** Cuántos recordatorios se mandan por vuelta. */
const RECORDATORIOS_POR_VUELTA = 50;
/** Tres mails seguidos que no salen son el remitente caído, no tres direcciones malas: se corta para no marcar de más. */
const SIN_SALIR_SEGUIDOS = 3;

/* ── Piezas ───────────────────────────────────────────────────────────────── */

const nuevaRuta = () => randomBytes(16).toString("base64url");
const nuevoSlug = () => Array.from({ length: 16 }, () => CASILLAS_DEL_SLUG[randomInt(CASILLAS_DEL_SLUG.length)]).join("");
const espera = (ms: number) => new Promise<void>((seguir) => setTimeout(seguir, ms));

/** El CUIT con sus once dígitos y el dígito verificador bien; guiones y espacios se aceptan y no se guardan. Null si no cumple. */
function cuitValido(crudo: string): string | null {
  const digitos = crudo.replace(/[\s-]/g, "");
  if (!/^\d{11}$/.test(digitos)) return null;
  const suma = PESOS_DEL_CUIT.reduce((total, peso, i) => total + peso * Number(digitos[i]), 0);
  const resto = suma % 11;
  const verificador = resto === 0 ? 0 : 11 - resto;
  return verificador !== 10 && verificador === Number(digitos[10]) ? digitos : null;
}

/** La razón social, recortada, de 1 a 120 caracteres y sin caracteres de control. Null si no cumple. */
function razonValida(crudo: string): string | null {
  const razon = crudo.trim();
  return razon.length >= 1 && razon.length <= RAZON_MAXIMA && !/\p{Cc}/u.test(razon) ? razon : null;
}

function mismoValor(a: string, b: string): boolean {
  if (!b) return false;
  return timingSafeEqual(createHash("sha256").update(a).digest(), createHash("sha256").update(b).digest());
}

/** ¿Es la app o el secreto de la plataforma? Se compara en tiempo constante y sin cortar en el primero (R23). */
function esDeLaPlataforma(appId: string, secreto: string): boolean {
  const mismaApp = mismoValor(appId, process.env.META_APP_ID?.trim() ?? "");
  const mismoSecreto = mismoValor(secreto, process.env.WHATSAPP_APP_SECRET?.trim() ?? "");
  return mismaApp || mismoSecreto;
}

/** Lo que la base contesta a un paso que no salió, con las palabras de esta vía. */
function resultadoDeGuardado(guardado: Exclude<GuardadoDeWaba, "ok">, tenantId: string): ResultadoDeApp {
  if (guardado === "transicion" || guardado === "ya_conectado") return guardado;
  return resultadoDe(guardado, tenantId);
}

/**
 * Un rechazo de Graph con el token del cliente, en las palabras de esta vía. Lo que no se reconoce es `meta`.
 * `causaDeRechazo` confirma con Meta lo que el código solo no dice (secreto rotado, cuenta bloqueada); sin app no hay con qué confirmar.
 */
async function resultadoDeGraph(g: RechazoDeGraph, ctx: EnApp | undefined): Promise<ResultadoDeApp> {
  if (g.falla === "esperar") return "esperar";
  if (!ctx) return "app_invalida";
  const causa = await causaDeRechazo(g, ctx);
  switch (causa) {
    case "secreto_invalido":
      return "app_invalida";
    case "token_vencido":
    case "waba_no_asignada":
    case "waba_invalida":
    case "esperar":
    case "pago_pendiente":
    case "waba_restringida":
    case "waba_bloqueada":
      return causa;
    default:
      return "meta";
  }
}

/** Un rechazo de `leerApp`: el 4xx es el secreto mal puesto, lo demás se reintenta o se mira. */
const deLaApp = (g: { falla: FallaDeGraph }): ResultadoDeApp => (g.falla === "rechazo" ? "app_invalida" : g.falla);

/** Lo que el token del cliente dijo de sí mismo, como respuesta. El nombre de un permiso viene de Meta: sólo pasa si tiene forma de nombre. */
function deLaRevision(r: Extract<RevisionDeToken, { ok: false }>): RespuestaDeToken {
  switch (r.motivo) {
    case "falta_permiso":
      return { resultado: "falta_permiso", ...(NOMBRE_DE_PERMISO.test(r.permiso) ? { permiso: r.permiso } : {}) };
    case "permisos_de_mas":
      return { resultado: "permisos_de_mas", permisos: r.permisos.filter((p) => NOMBRE_DE_PERMISO.test(p)).slice(0, PERMISOS_MAXIMOS) };
    case "rechazo":
      return { resultado: "app_invalida" };
    default:
      return { resultado: r.motivo };
  }
}

const sitio = () => process.env.NEXT_PUBLIC_SITE_URL?.trim().replace(/\/+$/, "") ?? "";

/** La dirección de una página legal del cliente. Null si el sitio no es https o la fila no tiene su slug. */
export function urlLegal(slug: string | null, pagina: "terminos" | "privacidad" | "borrado"): string | null {
  const base = sitio();
  if (!slug || !/^https:\/\/[^/\s]/i.test(base)) return null;
  return `${base}/legal/${slug}/${pagina}`;
}

/** Lo que P1B muestra para completar a mano los datos legales de la app; `listos` es que ya se cargaron solos. */
export interface LegalesDeApp {
  terminos: string | null;
  privacidad: string | null;
  borrado: string | null;
  contacto: string | null;
  listos: boolean;
}

export function legalesDeApp(fila: FilaDeWaba): LegalesDeApp {
  return {
    terminos: urlLegal(fila.slugLegal, "terminos"),
    privacidad: urlLegal(fila.slugLegal, "privacidad"),
    borrado: urlLegal(fila.slugLegal, "borrado"),
    contacto: fila.emailDeContacto ?? null,
    listos: fila.datosAppEn !== null,
  };
}

/** La dirección y la marca del webhook de la fila, para pintarlas sin ir a Meta. Null si falta la ruta, el sitio https o la clave. */
export function webhookDeLaFila(fila: FilaDeWaba): { url: string; verifyToken: string } | null {
  const url = fila.ruta ? urlDelWebhookDeApp(fila.ruta) : null;
  if (!fila.ruta || !url) return null;
  try {
    return { url, verifyToken: derivar("wa-verify-app", fila.ruta) };
  } catch {
    return null;
  }
}

/** La WABA y el número del cliente, entre los que se puede leer con su token: las del espacio y no las de la plataforma. */
const esDeLaPlataformaLaWaba = (wabaId: string) => wabaId === wabaDeLaPlataforma();

/* ── En qué ventana está ──────────────────────────────────────────────────── */

/**
 * La ventana del asistente que le toca a esta fila. Una fila que no es de la app propia (o ninguna, cancelada
 * o revocada) empieza de cero: P0, donde se firma el acuerdo.
 */
export function pasoDelAsistente(fila: FilaDeWaba | null): PasoDelAsistente {
  if (!fila || !esDeApp(fila)) return "P0";
  switch (fila.estado) {
    case "armando":
      if (!fila.appId) return "P1";
      return fila.webhookAppVerificadoEn ? "P2" : "P1B";
    case "suscripta":
      return fila.webhookAppVerificadoEn ? "seguir" : "E14";
    case "vinculada":
      return numeroPorAceptar(fila) ? "E5" : "seguir";
    case "falta_codigo":
      return "E3";
    case "falta_pin":
      return "E4";
    case "conectada":
      return fila.primeraRespuestaEn ? "G" : "P4";
    case "falla":
      return fila.falla === "pago_pendiente" && !fila.primeraRespuestaEn ? "P4" : "G";
    default:
      return "G";
  }
}

const ESTADO_VACIO: EstadoDeApp = {
  paso: "P0",
  estado: null,
  falla: null,
  appId: null,
  webhookVerificado: false,
  datosApp: false,
  numero: null,
  nombreEstado: null,
  plantilla: false,
  primerMensaje: false,
  primeraRespuesta: false,
  puedeEnviar: null,
};

/** Lo que la pantalla sabe de la fila, sin secretos: la usan la acción de estado y la página, con la misma lectura. */
export function estadoPublico(fila: FilaDeWaba | null): EstadoDeApp {
  if (!fila) return ESTADO_VACIO;
  const deApp = esDeApp(fila);
  return {
    paso: pasoDelAsistente(fila),
    estado: fila.estado,
    falla: fila.falla,
    appId: deApp ? fila.appId : null,
    webhookVerificado: deApp && fila.webhookAppVerificadoEn !== null,
    datosApp: deApp && fila.datosAppEn !== null,
    numero: fila.numeroMeta ?? fila.numeroTipeado,
    nombreEstado: fila.nombreEstado,
    plantilla: fila.plantillaEnviadaEn !== null,
    primerMensaje: fila.primerMensajeEn !== null,
    primeraRespuesta: fila.primeraRespuestaEn !== null,
    puedeEnviar: fila.puedeEnviar,
  };
}

/** El estado para pintar la pantalla: una sola lectura de la base y ninguna llamada a Meta. */
export async function estadoDeApp(quien: QuienPide): Promise<EstadoDeApp> {
  return sinTirar<EstadoDeApp>("app_estado", ESTADO_VACIO, async () => estadoPublico(await almacenDelInquilino(quien).leer()));
}

/* ── P0: el acuerdo y los datos del cliente ───────────────────────────────── */

/**
 * Abre el alta: guarda quién es el cliente (razón social y CUIT), qué acuerdo aceptó, y la ruta
 * del webhook y el slug de sus páginas legales, que se generan acá y no se cambian. Repetirla con
 * el alta en `armando` la retoma sin cambiar ni la ruta ni el slug.
 */
export async function iniciarApp(
  quien: QuienPide,
  datos: { acuerdo: string; razonSocial: string; cuit: string; numero?: string }
): Promise<{ resultado: ResultadoDeApp }> {
  return sinTirar<{ resultado: ResultadoDeApp }>("app_iniciar", { resultado: "meta" }, async () => {
    const { tenantId } = quien;
    if (datos.acuerdo !== VERSION_DEL_ANEXO) return { resultado: "formato" };
    const razonSocial = razonValida(datos.razonSocial);
    if (!razonSocial) return { resultado: "razon_invalida" };
    const cuit = cuitValido(datos.cuit);
    if (!cuit) return { resultado: "cuit_invalido" };
    const tipeado = datos.numero?.trim();
    const numero = tipeado ? normalizarE164(tipeado) : undefined;
    if (numero === null) return { resultado: "numero_invalido" };

    const almacen = almacenDelInquilino(quien);
    const fila = await almacen.leer();
    if (!fila) return { resultado: "apagado" };
    const viva = fila.estado !== null && fila.estado !== "cancelada" && fila.estado !== "revocada";
    // Una alta viva por el popup de Meta no se pisa desde acá.
    if (viva && fila.origen !== "app_propia") return { resultado: yaConectada(fila) ? "ya_conectado" : "transicion" };
    if (!activaPara(fila, appPropia())) return { resultado: "apagado" };
    if (yaConectada(fila)) return { resultado: "ya_conectado" };

    const guardado = await almacen.guardar("app_iniciar", {
      ruta: nuevaRuta(),
      slug: nuevoSlug(),
      razon_social: razonSocial,
      cuit,
      acuerdo: datos.acuerdo,
      ...(numero ? { numero } : {}),
    });
    if (guardado !== "ok") return { resultado: resultadoDeGuardado(guardado, tenantId) };
    return { resultado: "listo" };
  });
}

/* ── P1: la app del cliente ───────────────────────────────────────────────── */

/**
 * Los datos legales de la app (términos, privacidad y contacto): sólo se completan los que Meta tiene
 * vacíos, y `true` es que los tres quedaron con valor, por lectura o por escritura (R15). Si no se puede
 * leer no se escribe nada y se devuelve `undefined`: Meta no dijo cómo están, y un `false` pisaría un éxito
 * anterior (la base deja la columna como estaba si la clave no viene). Nunca tira ni frena el alta: el
 * cliente los copia a mano en su app si hace falta.
 */
async function completarLosDatosDeLaApp(fila: FilaDeWaba, app: AppDelCliente): Promise<boolean | undefined> {
  try {
    const leidos = await leerDatosDeLaApp(app);
    if (!leidos.ok) return undefined;
    const { terminos, privacidad, contacto } = leidos.valor;
    const faltan: { terminos?: string; privacidad?: string; contacto?: string } = {};
    const urlTerminos = urlLegal(fila.slugLegal, "terminos");
    const urlPrivacidad = urlLegal(fila.slugLegal, "privacidad");
    if (!terminos && urlTerminos) faltan.terminos = urlTerminos;
    if (!privacidad && urlPrivacidad) faltan.privacidad = urlPrivacidad;
    if (!contacto && fila.emailDeContacto) faltan.contacto = fila.emailDeContacto;

    const quedanVacios = [!terminos && !faltan.terminos, !privacidad && !faltan.privacidad, !contacto && !faltan.contacto];
    if (Object.keys(faltan).length === 0) return !quedanVacios.some(Boolean);
    const escritos = await fijarDatosDeLaApp(app, faltan);
    if (!escritos.ok) {
      logger.warn({ falla: escritos.falla, codigo: escritos.codigo }, "alta.app_datos_no_se_cargaron");
      return false;
    }
    return !quedanVacios.some(Boolean);
  } catch (e) {
    logger.warn({ error: e instanceof Error ? e.name : "UnknownError" }, "alta.app_datos_fallo");
    return undefined;
  }
}

/**
 * Deja el callback de la app apuntando a este espacio por API, si Meta no tiene ninguno. Hasta tres
 * intentos, esperando sólo cuando Meta pide esperar. No frena nada: si no sale, el cliente lo pega a mano en P1B.
 */
async function dejarElWebhook(app: AppDelCliente, url: string, ruta: string): Promise<void> {
  const verifyToken = derivar("wa-verify-app", ruta);
  for (let intento = 0; intento <= ESPERAS_DEL_WEBHOOK_MS.length; intento++) {
    const r = await suscribirWebhookDeApp(app, url, verifyToken, CAMPOS_DEL_WEBHOOK);
    if (r.ok) return;
    if (r.falla !== "esperar" || intento === ESPERAS_DEL_WEBHOOK_MS.length) {
      logger.warn({ falla: r.falla, codigo: r.codigo }, "alta.app_webhook_no_se_dejo");
      return;
    }
    await espera(ESPERAS_DEL_WEBHOOK_MS[intento]);
  }
}

/**
 * Guarda la app del cliente (su ID y su secreto, cifrado) después de comprobar con Meta que el par es de
 * una app y no el token de otra cosa. Con el alta en `armando` la app puede cambiarse: la ruta del
 * webhook se rota y la verificación se pierde. Con el alta más avanzada (E7) sólo se admite el mismo
 * ID de app: cambia el secreto y nada más.
 */
export async function credencialesDeApp(quien: QuienPide, datos: { appId: string; secreto: string }): Promise<{ resultado: ResultadoDeApp }> {
  return sinTirar<{ resultado: ResultadoDeApp }>("app_credenciales", { resultado: "meta" }, async () => {
    const { tenantId } = quien;
    const appId = recortar(datos.appId);
    const secreto = recortar(datos.secreto);
    if (!ID_DE_META.test(appId)) return { resultado: "formato_app" };
    if (!FORMATO_SECRETO.test(secreto)) return { resultado: "formato_secreto" };
    if (pareceToken(secreto)) return { resultado: "parece_token" };
    if (esDeLaPlataforma(appId, secreto)) return { resultado: "app_de_la_plataforma" };

    const almacen = almacenDelInquilino(quien);
    const fila = await almacen.leer();
    if (!fila) return { resultado: "apagado" };
    if (!activaPara(fila, appPropia())) return { resultado: "apagado" };
    if (!esDeApp(fila) || !fila.ruta) return { resultado: "transicion" };
    const actualizando = fila.estado !== "armando";
    if (actualizando && fila.appId !== appId) return { resultado: "otra_app" };

    // Otra app en `armando` es otro webhook: la ruta se rota para que lo que quede apuntando a la anterior no llegue acá.
    const ruta = !actualizando && fila.appId !== null && fila.appId !== appId ? nuevaRuta() : fila.ruta;
    const url = urlDelWebhookDeApp(ruta);
    if (!url) {
      logger.warn({}, "alta.app_sin_sitio_https");
      return { resultado: "meta" };
    }
    const app: AppDelCliente = { appId, secreto };
    const callback = await leerApp(app, url);
    if (!callback.ok) return { resultado: deLaApp(callback) };

    // Con el callback de la app apuntando a otro lado no se escribe nada en ella (R2).
    const tocarLaApp = !actualizando && callback.valor !== "ajeno";
    const datosApp = actualizando ? undefined : tocarLaApp ? await completarLosDatosDeLaApp(fila, app) : false;

    const guardado = await almacen.guardar("app_credenciales", {
      app_id: appId,
      app_secreto_cifrado: cerrarSecreto(secreto, tenantId, appId),
      ruta,
      ...(datosApp === undefined ? {} : { datos_app: datosApp }),
    });
    if (guardado !== "ok") return { resultado: guardado === "de_la_plataforma" ? "app_de_la_plataforma" : resultadoDeGuardado(guardado, tenantId) };

    if (tocarLaApp && callback.valor === "ninguno") await dejarElWebhook(app, url, ruta);
    // Si el secreto había caído armando el alta (número aún pedido), la base devolvió la fila a «vinculada»: el alta sigue desde ahí.
    if (fila.estado === "falla" && fila.falla === "secreto_invalido" && fila.numeroEstado === "pedido") {
      return { resultado: await continuarWaba(tenantId, almacen) };
    }
    return { resultado: "listo" };
  });
}

/* ── E14: el webhook ──────────────────────────────────────────────────────── */

/**
 * La dirección y la marca que el cliente pega en su app, y un aviso si el callback actual de la app no
 * es éste. Nunca devuelve la dirección ajena: se anota que la hay y el cliente la ve en su propio panel.
 */
export async function webhookDeApp(quien: QuienPide): Promise<{ resultado: ResultadoDeApp; webhook?: DatosDelWebhook }> {
  return sinTirar<{ resultado: ResultadoDeApp; webhook?: DatosDelWebhook }>("app_webhook", { resultado: "meta" }, async () => {
    const fila = await almacenDelInquilino(quien).leer();
    if (!fila) return { resultado: "apagado" };
    if (!activaPara(fila, appPropia())) return { resultado: "apagado" };
    const app = esDeApp(fila) ? appDelCliente(fila) : null;
    if (!app || !fila.ruta) return { resultado: "transicion" };

    const url = urlDelWebhookDeApp(fila.ruta);
    if (!url) {
      logger.warn({}, "alta.app_sin_sitio_https");
      return { resultado: "meta" };
    }
    let verifyToken: string;
    try {
      verifyToken = derivar("wa-verify-app", fila.ruta);
    } catch {
      logger.error({}, "alta.app_sin_marca_de_webhook");
      return { resultado: "meta" };
    }

    const callback = await leerApp(app, url);
    if (!callback.ok && callback.falla === "rechazo") return { resultado: "app_invalida" };
    let aviso: DatosDelWebhook["aviso"] = null;
    if (!callback.ok || callback.valor === "desconocido") aviso = "revisar";
    else if (callback.valor === "ajeno") {
      aviso = "ajeno";
      logger.warn({ tenantId: quien.tenantId }, "alta.app_ajena");
    }
    return { resultado: "listo", webhook: { url, verifyToken, aviso } };
  });
}

const appDelCliente = (fila: FilaDeWaba): AppDelCliente | null => (fila.appId && fila.secreto ? { appId: fila.appId, secreto: fila.secreto } : null);

/* ── P3: el token ─────────────────────────────────────────────────────────── */

/** Las filas de la WABA que traen su id; el resto no se puede elegir. */
const conId = (filas: FilaDeLaWaba[]) => filas.flatMap((f) => (f.id ? [{ id: f.id, display: f.display }] : []));

/**
 * El token del usuario del sistema del cliente: se revisa con Meta, se saca de él (y no del navegador) qué
 * WABA y qué número son, y recién entonces se guarda, cifrado, y se sigue con `continuarWaba`. Corta en el
 * primer fallo y no escribe nada hasta el final. Con el alta ya conectada (E6) sólo cambia el token; si cayó
 * por el token armándose (el número todavía pedido), cambia el token y el alta sigue desde donde se cortó.
 */
export async function tokenDeApp(
  quien: QuienPide,
  pedido: { token: string; wabaId: string; phoneNumberId?: string; categoria?: CategoriaDePerfil }
): Promise<RespuestaDeToken> {
  return sinTirar<RespuestaDeToken>("app_token", { resultado: "meta" }, async () => {
    const { tenantId } = quien;
    const almacen = almacenDelInquilino(quien);
    const fila = await almacen.leer();
    if (!fila) return { resultado: "apagado" };
    if (!activaPara(fila, appPropia())) return { resultado: "apagado" };
    if (!esDeApp(fila)) return { resultado: "transicion" };
    const app = appDelCliente(fila);
    const actualizando = fila.estado === "conectada" || (fila.estado === "falla" && fila.falla === "token_vencido");
    // «Elegir otro» de E5: Meta informó otro número, nada se registró, y se vuelve a pegar el token sin soltar la cuenta.
    const eligiendoOtro = fila.estado === "vinculada" && numeroPorAceptar(fila);
    if (!app || !(fila.estado === "armando" || eligiendoOtro || actualizando)) return { resultado: "transicion" };

    const token = recortar(pedido.token);
    if (!FORMATO_TOKEN.test(token)) return { resultado: "token_formato" };
    const wabaId = actualizando ? fila.wabaId : recortar(pedido.wabaId);
    if (!wabaId || !ID_DE_META.test(wabaId)) return { resultado: actualizando ? "transicion" : "waba_formato" };

    // Una caída por el token con el número aún pedido es de un alta que no llegó a conectarse: no hay nada vivo que
    // reabrir, así que el token nuevo se guarda y se retoma el camino (E6 no tendría otra salida).
    const enArmado = actualizando && fila.estado === "falla" && fila.numeroEstado === "pedido";
    if (actualizando) {
      const vivo = fila.numeroEstado === "conectado" || fila.numeroEstado === "suspendido";
      if (!fila.phoneNumberId || !(vivo || enArmado)) return { resultado: "transicion" };
    }

    const revision = await revisarTokenDeApp(token, app);
    if (!revision.ok) return deLaRevision(revision);
    if (esDeLaPlataformaLaWaba(wabaId)) return { resultado: "de_la_plataforma" };
    // Si Meta dijo a qué cuentas llega el token y ésta no está, no es la cuenta de este token. Si no lo dijo, lo confirma el recorrido.
    if (revision.wabaIds && !revision.wabaIds.includes(wabaId)) return { resultado: "waba_invalida" };

    const prueba = pruebaDelSecreto(token, app.secreto);
    const cred: CredencialDeAlta = { accessToken: token, wabaId, prueba };
    const enApp = (paso: PasoDeAlta): EnApp => ({ app, cred, ruta: fila.ruta, paso });

    if (actualizando) {
      const esta = await estaEnLaWaba(wabaId, fila.phoneNumberId as string, token, prueba);
      if (esta === null) return { resultado: "meta" };
      if (!esta) return { resultado: "waba_invalida" };
      const guardado = await almacen.guardar("app_token", { token_cifrado: cifrar(token, aadDelToken(tenantId, wabaId)) });
      if (guardado !== "ok") return { resultado: resultadoDeGuardado(guardado, tenantId) };
      return { resultado: enArmado ? await continuarWaba(tenantId, almacen) : "listo" };
    }

    // El `code` del propio recorrido dice por qué no hubo lista (un 100 es una WABA que no es de este token).
    const recorrido = await recorrerLaWabaOFalla(wabaId, "id,display_phone_number", token, undefined, prueba);
    if (!recorrido.ok) return { resultado: await resultadoDeGraph(recorrido, enApp("waba")) };
    const lista = recorrido.valor;
    const numeros = conId(lista.filas);
    const pedidoId = pedido.phoneNumberId && ID_DE_META.test(pedido.phoneNumberId) ? pedido.phoneNumberId : null;
    const coincidentes = numeros.filter((n) => n.display && fila.numeroTipeado && mismoNumero(n.display, fila.numeroTipeado));
    const elegido =
      numeros.find((n) => n.id === pedidoId) ??
      (coincidentes.length === 1 ? coincidentes[0] : undefined) ??
      (lista.completa && numeros.length === 1 ? numeros[0] : undefined);
    if (!elegido) {
      if (!lista.completa) return { resultado: "meta" };
      if (numeros.length === 0) return { resultado: "sin_numero" };
      return {
        resultado: "elegir_numero",
        numeros: numeros.flatMap((n) => (n.display ? [{ id: n.id, display: n.display }] : [])).slice(0, NUMEROS_MAXIMOS),
      };
    }
    const phoneNumberId = elegido.id;
    if (phoneNumberId === idDeLaPlataforma()) return { resultado: "de_la_plataforma" };

    const datos = await datosDelNumero(token, phoneNumberId, prueba);
    if (!datos.ok) return { resultado: await resultadoDeGraph(datos, enApp("numero")) };
    if (datos.valor.enLaApp) return { resultado: "coexistencia" };
    const numeroMeta = normalizarE164(datos.valor.display);
    if (!numeroMeta) return { resultado: "meta" };
    if (esNumeroDeOtroAmbiente(phoneNumberId, numeroMeta)) return { resultado: revisar("de_otro_ambiente", tenantId) };

    // Si la misma WABA se vuelve a vincular se conserva el PIN: el número ya registrado lo exige idéntico.
    const pin = fila.pin && fila.wabaId === wabaId ? fila.pin : String(randomInt(0, 1_000_000)).padStart(6, "0");
    const guardado = await almacen.guardar("vincular", {
      waba_id: wabaId,
      phone_number_id: phoneNumberId,
      numero_meta: numeroMeta,
      token_cifrado: cifrar(token, aadDelToken(tenantId, wabaId)),
      pin_cifrado: cifrar(pin, aadDelPin(tenantId, wabaId)),
      ...(pedido.categoria ? { categoria_perfil: pedido.categoria } : {}),
    });
    if (guardado !== "ok") return { resultado: resultadoDeGuardado(guardado, tenantId) };

    if (fila.numeroTipeado && !mismoNumero(numeroMeta, fila.numeroTipeado)) return { resultado: "numero_distinto", numeroMeta };
    return { resultado: await continuarWaba(tenantId, almacen) };
  });
}

/* ── E10: el nombre visible ───────────────────────────────────────────────── */

/**
 * Pide a Meta un nombre visible nuevo para el número. No escribe: cómo va la revisión llega por el aviso de
 * Meta (`phone_number_name_update`), por la salud diaria o por «Reintentar».
 */
export async function nombreDeApp(quien: QuienPide, nombre: string): Promise<{ resultado: ResultadoDeApp }> {
  return sinTirar<{ resultado: ResultadoDeApp }>("app_nombre", { resultado: "meta" }, async () => {
    const limpio = recortar(nombre);
    if (limpio.length < 1 || limpio.length > NOMBRE_MAXIMO || /\p{Cc}/u.test(limpio)) return { resultado: "nombre_invalido" };
    const fila = await almacenDelInquilino(quien).leer();
    if (!fila || !activaPara(fila, appPropia())) return { resultado: "apagado" };
    if (!esDeApp(fila)) return { resultado: "transicion" };
    if (!(fila.estado === "conectada" || (fila.estado === "falla" && fila.falla === "nombre_rechazado"))) return { resultado: "transicion" };
    const listo = paraSeguir(fila, true);
    if (!listo.ok) return { resultado: listo.resultado };

    const pedido = await pedirNombreNuevo(listo.cred, listo.id, limpio);
    if (pedido.ok) return { resultado: "listo" };
    const resultado = await resultadoDeGraph(pedido, enAppDe(listo, "numero"));
    // Sólo un rechazo sin código, o el 100 (parámetro inválido) que la app no atribuyó a su secreto, es el nombre mismo (formato o política de Meta): se pide otro.
    const delNombre = pedido.falla === "rechazo" && (pedido.codigo === null || pedido.codigo === 100);
    return { resultado: resultado === "meta" && delNombre ? "nombre_invalido" : resultado };
  });
}

/**
 * Registra el número otra vez con el nombre ya aprobado (M5) y, si la fila había caído por el nombre, la
 * devuelve a `conectada`. Escribe con el almacén del sistema: a quien llama (el aviso de Meta, la salud
 * diaria o el «Reintentar» del cliente) no le toca decidir qué se escribe. `leida` es la fila que quien llama
 * ya leyó en esta misma llamada (el «Reintentar»); el aviso de Meta no trae ninguna y la lee acá.
 */
async function registrarTrasLaAprobacion(tenantId: string, wabaId: string | null, leida?: FilaDeWaba | null): Promise<ResultadoDeApp> {
  const almacen = almacenDelDueno(tenantId, "sistema");
  const fila = leida === undefined ? await almacen.leer() : leida;
  if (!fila || (wabaId !== null && fila.wabaId !== wabaId)) return "transicion";
  const caida = fila.estado === "falla" && fila.falla === "nombre_rechazado";
  const registro = await registrarConNombreAprobado(tenantId, almacen, fila);
  if (registro !== "registrado") return registro;
  if (caida && !(await nombreRehabilitado(tenantId))) return "transicion";
  return "listo";
}

/** Meta aprobó el nombre visible de la WABA: se registra el número otra vez, dentro de los 14 días. Nunca tira. */
export async function nombreAprobado(tenantId: string, wabaId: string): Promise<void> {
  await sinTirar<void>("app_nombre_aprobado", undefined, async () => {
    await registrarTrasLaAprobacion(tenantId, wabaId);
  });
}

export type VeredictoDelNombre = "aprobado" | "pendiente" | "rechazado" | "desconocido";

/** Lo que Meta dice del nombre: el pedido nuevo manda sobre el vigente si lo hay. */
export function veredictoDelNombre(estado: string | null, nuevo: string | null): VeredictoDelNombre {
  const vigente = nuevo && nuevo !== "NONE" ? nuevo : estado;
  if (!vigente) return "desconocido";
  if (vigente === "APPROVED" || vigente === "AVAILABLE_WITHOUT_REVIEW") return "aprobado";
  if (vigente === "PENDING_REVIEW") return "pendiente";
  return "rechazado";
}

/**
 * «Reintentar» en la vía de la app propia. Con el nombre rechazado primero se le pregunta a Meta cómo va
 * (R31) y nunca se registra con un nombre sin aprobar; en cualquier otro caso es el reintento de siempre.
 */
export async function reintentarDeApp(quien: QuienPide): Promise<ResultadoDeApp> {
  return sinTirar<ResultadoDeApp>("app_reintentar", "meta", async () => {
    const { tenantId } = quien;
    const fila = await almacenDelInquilino(quien).leer();
    if (!fila || !esDeApp(fila) || fila.estado !== "falla" || fila.falla !== "nombre_rechazado") return reintentarWaba(quien, fila);
    if (!activaPara(fila, appPropia())) return "apagado";
    if (!(await cupoDeSeguir(tenantId))) return "esperar";
    const listo = paraSeguir(fila, true);
    if (!listo.ok) return listo.resultado;

    const nombre = await leerEstadoDelNombre(listo.cred, listo.id);
    if (!nombre.ok) return resultadoDeGraph(nombre, enAppDe(listo, "numero"));
    switch (veredictoDelNombre(nombre.valor.estado, nombre.valor.estadoNuevo)) {
      case "aprobado":
        return registrarTrasLaAprobacion(tenantId, listo.cred.wabaId, fila);
      case "pendiente":
        return "nombre_pendiente";
      case "rechazado":
        return "nombre_rechazado";
      default:
        return "meta";
    }
  });
}

/* ── Cancelar el armado ───────────────────────────────────────────────────── */

/**
 * El cliente abandona el armado de su app: la base suelta el secreto y la ruta del webhook y la fila pasa a
 * `cancelada`, desde donde empieza de cero o elige el otro camino. Sin esto una fila `armando` no sale sola
 * y, con la fila viva, `activaPara` sigue decidiendo por su origen aunque la bandera se apague. Como desconectar,
 * no mira ninguna bandera (S11). Sólo cancela mientras se arma: con la WABA ya vinculada lo que corresponde es
 * desconectar, y la base contesta `transicion`.
 */
export async function cancelarDeApp(quien: QuienPide): Promise<ResultadoDeApp> {
  return sinTirar<ResultadoDeApp>("app_cancelar", "meta", async () => {
    const guardado = await almacenDelInquilino(quien).guardar("cancelar", { paso: "otro" });
    if (guardado === "ok") return "cancelado";
    // Otro pedido ya movió la fila: la página se vuelve a leer y muestra donde quedó.
    return guardado === "transicion" ? "transicion" : resultadoDe(guardado, quien.tenantId);
  });
}

/* ── El recordatorio ──────────────────────────────────────────────────────── */

/**
 * Un mail al cliente que dejó el alta de la app propia a medias hace más de un día, con el paso en que
 * quedó, en el idioma de su cuenta. Uno solo por alta: se marca al intentarlo, salga o no (o al ver que no hay a quién:
 * sin correo, o uno inválido). Un corte del remitente (sin cupo, sin configurar, o tres mails seguidos que no salen)
 * corta la vuelta y deja el resto para la próxima. Sale por su propio tipo de correo para no gastar el cupo de los avisos al operador.
 * Con `hasta` (epoch ms) corta la vuelta al pasarse: quien la lleva tiene un plazo. Devuelve cuántos mandó; nunca tira.
 */
export async function recordarAltasAMedias(hasta = Number.POSITIVE_INFINITY): Promise<number> {
  return sinTirar<number>("app_recordatorio", 0, async () => {
    const base = sitio();
    if (!remitenteDelSistema() || !base) return 0;
    const altas = await leerAltasAMedias(HORAS_DEL_RECORDATORIO, RECORDATORIOS_POR_VUELTA);
    let enviados = 0;
    let sinSalir = 0;
    for (const alta of altas) {
      if (Date.now() >= hasta) break;
      if (!alta.correo) {
        await recordatorioEnviado(alta.tenantId);
        continue;
      }
      const t = getT(alta.locale);
      const paso = t(`alta.recordatorio.paso.${alta.appId === null ? "P1" : alta.webhookVerificado ? "P2" : "P1B"}`);
      const resultado = await enviarCorreoDelSistema(
        {
          to: alta.correo,
          asunto: t("alta.recordatorio.asunto"),
          texto: t("alta.recordatorio.cuerpo")
            .replace("{paso}", () => paso)
            .replace("{enlace}", () => `${base}/conectar-whatsapp/app`),
        },
        { tipo: "recordatorio" }
      );
      if (resultado.enviado) {
        enviados += 1;
        sinSalir = 0;
        await recordatorioEnviado(alta.tenantId);
        logger.info({ tenantId: alta.tenantId }, "alta.recordatorio_enviado");
        continue;
      }
      if (resultado.motivo === "sin_cupo" || resultado.motivo === "sin_remitente") break;
      // Una alta cuyo mail no sale (dirección que Gmail rechaza) se marca igual: sin marca, cincuenta así ocupan
      // la vuelta entera, siempre las mismas por ser las más viejas, y las altas nuevas nunca reciben el suyo.
      await recordatorioEnviado(alta.tenantId);
      if (resultado.motivo === "no_salio" && ++sinSalir >= SIN_SALIR_SEGUIDOS) break;
    }
    return enviados;
  });
}
