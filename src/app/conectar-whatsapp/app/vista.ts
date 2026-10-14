/**
 * Qué pantalla y qué ventana del asistente de «app propia» le toca al cliente, y qué
 * texto lleva cada resultado del servidor. Todo puro: lo usa el panel y lo prueba una
 * tabla.
 *
 * Los resultados llegan como nombres de una lista cerrada (`waba-resultados.ts`) y acá
 * se vuelven una clave del diccionario con un mapa estático, no con una clave armada a
 * mano: si una clave deja de existir, el tipo lo marca.
 */

import type { ClaveDePagina } from "@/lib/i18n";
import type { EstadoDeApp, PasoDelAsistente } from "@/server/alta/app-propia";
import type { ResultadoDeApp } from "@/server/alta/waba-resultados";

/** Las pantallas de fondo. E3, E4 y E5 no tienen pantalla propia: son ventanas sobre «seguir». */
export type Pantalla = "P0" | "P1" | "P1B" | "E14" | "P2" | "P3" | "P4" | "G" | "seguir";

export type Ventana =
  | { tipo: "E2"; numeros: { id: string; display: string }[] }
  | { tipo: "E5"; numeroMeta: string | null }
  | { tipo: "E12"; bloqueada: boolean }
  | { tipo: "E3" | "E4" | "E6" | "E7" | "E8" | "E9" | "E10" | "E11" };

/** «Paso n de 4»: P1, P1B y E14 son el mismo paso, el de crear y completar la app. */
export const NUMERO_DE_PASO: Partial<Record<Pantalla, 1 | 2 | 3 | 4>> = { P1: 1, P1B: 1, E14: 1, P2: 2, P3: 3, P4: 4 };

export function pantallaDe(paso: PasoDelAsistente): Pantalla {
  switch (paso) {
    case "P0":
    case "P1":
    case "P1B":
    case "E14":
    case "P2":
    case "P4":
    case "G":
      return paso;
    default:
      return "seguir";
  }
}

/** La ventana que abre una falla que quedó guardada en la fila; sin ventana propia, el cartel de la pantalla G con «Reintentar». */
export function ventanaDeFalla(falla: string | null): Ventana | null {
  switch (falla) {
    case "token_vencido":
      return { tipo: "E6" };
    case "secreto_invalido":
      return { tipo: "E7" };
    case "pago_pendiente":
      return { tipo: "E8" };
    case "coexistencia":
      return { tipo: "E9" };
    case "nombre_rechazado":
      return { tipo: "E10" };
    case "waba_restringida":
      return { tipo: "E12", bloqueada: false };
    case "waba_bloqueada":
      return { tipo: "E12", bloqueada: true };
    default:
      return null;
  }
}

/** La ventana con la que abre la página según lo que dice el servidor. */
export function ventanaDe(paso: PasoDelAsistente, estado: Pick<EstadoDeApp, "estado" | "falla" | "numero"> | null): Ventana | null {
  switch (paso) {
    case "E3":
    case "E4":
      return { tipo: paso };
    case "E5":
      return { tipo: "E5", numeroMeta: estado?.numero ?? null };
    case "P4":
    case "G":
      return estado?.estado === "falla" ? ventanaDeFalla(estado.falla) : null;
    default:
      return null;
  }
}

/** Lo que muestra un cartel: el resultado del servidor y los datos con los que se completa su texto. */
export interface Aviso {
  resultado: ResultadoDeApp;
  permiso?: string;
  permisos?: string[];
}

/** Lo que una acción devuelve además del nombre del resultado. */
export interface Extras extends Omit<Aviso, "resultado"> {
  numeros?: { id: string; display: string }[];
  numeroMeta?: string;
}

/** La ventana que pide un resultado del servidor, si pide alguna. `token_vencido` no está: depende de la pantalla. */
export function ventanaDeResultado(resultado: ResultadoDeApp, extras: Extras = {}): Ventana | null {
  switch (resultado) {
    case "elegir_numero":
      return { tipo: "E2", numeros: extras.numeros ?? [] };
    case "falta_codigo":
      return { tipo: "E3" };
    case "falta_pin":
      return { tipo: "E4" };
    case "numero_distinto":
      return { tipo: "E5", numeroMeta: extras.numeroMeta ?? null };
    case "coexistencia":
      return { tipo: "E9" };
    case "esperar":
      return { tipo: "E11" };
    case "pago_pendiente":
      return { tipo: "E8" };
    case "nombre_rechazado":
      return { tipo: "E10" };
    case "waba_restringida":
      return { tipo: "E12", bloqueada: false };
    case "waba_bloqueada":
      return { tipo: "E12", bloqueada: true };
    default:
      return null;
  }
}

/**
 * La pantalla de fondo a la que lleva un resultado, si lleva a alguna. Con `webhook_pendiente` el callback de
 * la app apunta a otro lado: la fila no cambió (el webhook ya estaba verificado), así que la página sola no
 * lo muestra y es el resultado el que vuelve a E14. El cartel no va en el resultado: lo da la propia E14, que al
 * abrirse mira el callback y avisa si es ajeno. «Meta todavía no nos llamó» (`webhook_demora`) es sólo del sondeo.
 */
export function pantallaDeResultado(resultado: ResultadoDeApp): Pantalla | null {
  return resultado === "webhook_pendiente" ? "E14" : null;
}

/** Los resultados que cambian lo que lee la página: no llevan texto, la pantalla se recalcula con `router.refresh()`. */
const SIGUE_EN_EL_SERVIDOR: ReadonlySet<ResultadoDeApp> = new Set(["listo", "conectado", "transicion", "ya_conectado", "desconectado", "cancelado"]);

export const sigueEnElServidor = (resultado: ResultadoDeApp) => SIGUE_EN_EL_SERVIDOR.has(resultado);

/**
 * Si lo que contestó el servidor cambió lo que lee la página y hay que volver a pedirla. Una ventana de
 * elegir número (E2) o de espera (E11) no cambió nada; las demás vienen de una fila que ya pasó a otro estado.
 */
export function pideRefrescar(resultado: ResultadoDeApp, ventana: Ventana | null): boolean {
  return sigueEnElServidor(resultado) || (ventana !== null && ventana.tipo !== "E2" && ventana.tipo !== "E11");
}

/** Dónde se muestra el aviso de validar el token (P3): junto a lo que hay que corregir. */
export type LugarDelAviso = "bloque2" | "waba" | "bloque3";

export function lugarDelAvisoDeToken(resultado: ResultadoDeApp): LugarDelAviso {
  if (resultado === "waba_no_asignada") return "bloque2";
  return resultado === "waba_formato" || resultado === "waba_invalida" ? "waba" : "bloque3";
}

/** Los resultados con los que la persona cargó un token que el servidor ya guardó: el campo se vacía. */
export const tokenGuardado = (resultado: ResultadoDeApp) =>
  sigueEnElServidor(resultado) || resultado === "falta_codigo" || resultado === "falta_pin" || resultado === "numero_distinto";

const TEXTO_DE: Partial<Record<ResultadoDeApp, ClaveDePagina>> = {
  cuit_invalido: "appPropia.r.cuit_invalido",
  razon_invalida: "appPropia.r.razon_invalida",
  numero_invalido: "appPropia.r.numero_invalido",
  formato_app: "appPropia.r.formato_app",
  formato_secreto: "appPropia.r.formato_secreto",
  parece_token: "appPropia.r.parece_token",
  app_invalida: "appPropia.r.app_invalida",
  app_ocupada: "appPropia.r.app_ocupada",
  app_de_la_plataforma: "appPropia.r.app_de_la_plataforma",
  otra_app: "appPropia.r.otra_app",
  webhook_demora: "appPropia.r.webhook_demora",
  token_formato: "appPropia.r.token_formato",
  token_de_otra_app: "appPropia.r.token_de_otra_app",
  token_temporal: "appPropia.r.token_temporal",
  token_vencido: "appPropia.r.token_vencido",
  falta_permiso: "appPropia.r.falta_permiso",
  permisos_de_mas: "appPropia.r.permisos_de_mas",
  waba_no_asignada: "appPropia.r.waba_no_asignada",
  waba_formato: "appPropia.r.waba_formato",
  waba_invalida: "appPropia.r.waba_invalida",
  pago_pendiente: "appPropia.r.pago_pendiente",
  nombre_rechazado: "appPropia.r.nombre_rechazado",
  nombre_invalido: "appPropia.r.nombre_invalido",
  nombre_pendiente: "appPropia.r.nombre_pendiente",
  waba_restringida: "appPropia.r.waba_restringida",
  waba_bloqueada: "appPropia.r.waba_bloqueada",
  apagado: "waba.r.apagado",
  codigo_enviado: "waba.r.codigo_enviado",
  codigo_incorrecto: "waba.r.codigo_incorrecto",
  coexistencia: "waba.r.coexistencia",
  cupo: "waba.r.cupo",
  de_la_plataforma: "waba.r.de_la_plataforma",
  esperar: "waba.r.esperar",
  numero_ocupado: "waba.r.numero_ocupado",
  pin_incorrecto: "waba.r.pin_incorrecto",
  revision: "waba.r.revision",
  sdk_bloqueado: "waba.r.sdk_bloqueado",
  sin_numero: "waba.r.sin_numero",
  vencido: "waba.r.vencido",
};

/** El texto de un resultado; lo que no tiene uno propio (un formato inesperado, un resultado de otra vía) dice lo genérico de Meta. */
export const claveDelResultado = (resultado: ResultadoDeApp): ClaveDePagina => TEXTO_DE[resultado] ?? "waba.r.meta";

const TEXTO_DE_FALLA: Record<string, ClaveDePagina> = {
  canje: "waba.r.canje",
  token_invalido: "waba.r.token_invalido",
  suscripcion: "waba.r.suscripcion",
  registro: "waba.r.registro",
  webhook: "waba.r.webhook",
  coexistencia: "waba.r.coexistencia",
  sin_numero: "waba.r.sin_numero",
  token_vencido: "appPropia.r.token_vencido",
  secreto_invalido: "appPropia.claves.nuevoTexto",
  nombre_rechazado: "appPropia.estado.nombreRechazado",
  pago_pendiente: "appPropia.r.pago_pendiente",
  waba_restringida: "appPropia.r.waba_restringida",
  waba_bloqueada: "appPropia.r.waba_bloqueada",
};

/** El cartel de la pantalla G para una falla guardada. */
export const claveDeLaFalla = (falla: string | null): ClaveDePagina => (falla && TEXTO_DE_FALLA[falla]) || "waba.r.meta";

/** Rellena los `{nombre}` de un texto; un hueco sin valor queda como está. */
export function rellenar(texto: string, valores: Record<string, string>): string {
  return texto.replace(/\{(\w+)\}/g, (hueco, nombre: string) => (Object.hasOwn(valores, nombre) ? valores[nombre] : hueco));
}

/** La dirección de un `mailto:`, para mostrarla a quien no tiene un programa de correo configurado. */
export function correoDeAyuda(ayuda: string | null): string | null {
  if (!ayuda?.startsWith("mailto:")) return null;
  const direccion = ayuda.slice("mailto:".length).split("?")[0];
  try {
    return decodeURIComponent(direccion) || null;
  } catch {
    return direccion || null;
  }
}
