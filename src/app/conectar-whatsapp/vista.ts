/**
 * Qué muestra /conectar-whatsapp en cada momento, como funciones puras.
 *
 * La página arranca desde lo que dice la base (`vistaInicial`) y el panel avanza con
 * lo que contesta cada acción (`despuesDe`). Sin imports de servidor a propósito: las
 * usan la página, el panel de cliente y los tests sin arrastrar la base.
 */

import {
  FALLAS_DEL_POPUP,
  RESULTADOS_DE_WABA,
  pasoCancelado,
  reconectando,
  type FallaDelPopup,
  type PasoCancelado,
  type ResultadoDeApp,
  type ResultadoDeWaba,
} from "@/server/alta/waba-resultados";

export type NombreDeVista =
  | "inicio" // la lista de antes de empezar
  | "abrir" // el SDK cargó: falta el clic que abre el popup
  | "esperando" // el popup está abierto o se está terminando la conexión
  | "continuar" // vinculada pero sin terminar: se retoma sin popup
  | "numero_distinto"
  | "codigo"
  | "pin"
  | "conectado"
  | "cancelada"
  | "falla";

/** Lo que se le cuenta a la persona además de la vista: una clave del diccionario, nunca texto de Graph. */
export type Aviso =
  | Exclude<
      ResultadoDeWaba,
      "listo" | "conectado" | "falta_codigo" | "falta_pin" | "numero_distinto" | "cancelado" | "desconectado"
    >
  | FallaDelPopup;

export interface EstadoDeVista {
  vista: NombreDeVista;
  aviso: Aviso | null;
  /** Sólo en `cancelada`: el paso del popup en el que se cerró. */
  paso: PasoCancelado | null;
  /** Sólo en `numero_distinto`: el número que informó Meta. */
  numeroMeta: string | null;
}

const sinAviso = (vista: NombreDeVista): EstadoDeVista => ({ vista, aviso: null, paso: null, numeroMeta: null });

/** Lo que la lectura pública sabe de la WABA, en lo que importa a la vista. */
export interface DatosDeVista {
  estado: string | null;
  falla: string | null;
  paso: string | null;
  numero: "pedido" | "conectado" | "suspendido" | null;
  numeroDistinto: boolean;
  numeroMeta: string | null;
  conToken: boolean;
}

const ES_FALLA: readonly string[] = FALLAS_DEL_POPUP;

const NO_ES_AVISO: readonly string[] = ["listo", "conectado", "falta_codigo", "falta_pin", "numero_distinto", "cancelado", "desconectado"];

/** Lo que el panel del popup sabe contar; cualquier otra respuesta (las de la vía «app propia») se muestra como «Meta no pudo». */
const esAviso = (r: string): r is Aviso =>
  ((RESULTADOS_DE_WABA as readonly string[]).includes(r) && !NO_ES_AVISO.includes(r)) || ES_FALLA.includes(r);

/** Por dónde arranca la pantalla. Sin fila (o sin la 0051) es la lista de antes de empezar. */
export function vistaInicial(w: DatosDeVista | null): EstadoDeVista {
  if (!w) return sinAviso("inicio");
  // Un número conectado cuya WABA cayó o se está reconectando no es «conectado»: tiene que ver la falla o el paso que sigue.
  if (!reconectando(w) && (w.estado === "conectada" || w.numero === "conectado" || w.numero === "suspendido")) {
    return sinAviso("conectado");
  }
  switch (w.estado) {
    case "falta_codigo":
    case "falta_pin":
    case "vinculada":
    case "suscripta":
      // Sin token no hay con qué seguir: se abre el popup de nuevo.
      if (!w.conToken) return { ...sinAviso("inicio"), aviso: "vencido" };
      if (w.estado === "falta_codigo") return sinAviso("codigo");
      if (w.estado === "falta_pin") return sinAviso("pin");
      return w.numeroDistinto ? { ...sinAviso("numero_distinto"), numeroMeta: w.numeroMeta } : sinAviso("continuar");
    case "cancelada":
      return { ...sinAviso("cancelada"), paso: pasoCancelado(w.paso) };
    case "revocada":
      // Sólo Meta deja la causa (sacó la app). Quien se desconectó a propósito vuelve a la lista sin que se le diga que algo venció.
      return w.falla === "token_vencido" ? { ...sinAviso("falla"), aviso: "token_vencido" } : sinAviso("inicio");
    case "falla":
      return { ...sinAviso("falla"), aviso: w.falla !== null && ES_FALLA.includes(w.falla) ? (w.falla as FallaDelPopup) : "meta" };
    default:
      return sinAviso("inicio");
  }
}

/**
 * La vista que sigue a lo que contestó una acción. Los resultados que son un paso
 * (el código, el PIN, el número) llevan a su diálogo; el resto es un aviso: en la lista
 * del principio se queda ahí, y después del popup es una falla.
 */
export function despuesDe(resultado: ResultadoDeApp, antes: EstadoDeVista, numeroMeta?: string): EstadoDeVista {
  switch (resultado) {
    case "listo":
      return sinAviso("abrir");
    case "conectado":
      return sinAviso("conectado");
    case "desconectado":
      return sinAviso("inicio");
    case "cancelado":
      return { ...sinAviso("cancelada"), paso: antes.paso ?? "otro" };
    case "numero_distinto":
      return { ...sinAviso("numero_distinto"), numeroMeta: numeroMeta ?? antes.numeroMeta };
    case "falta_codigo":
      return sinAviso("codigo");
    case "codigo_enviado":
    case "codigo_incorrecto":
      return { ...sinAviso("codigo"), aviso: resultado };
    case "falta_pin":
      return sinAviso("pin");
    case "pin_incorrecto":
      return { ...sinAviso("pin"), aviso: resultado };
    // Un código vencido o ya usado se arregla empezando de nuevo, esté donde esté.
    case "vencido":
      return { ...sinAviso("inicio"), aviso: resultado };
    default:
      return { ...sinAviso(antes.vista === "inicio" ? "inicio" : "falla"), aviso: esAviso(resultado) ? resultado : "meta" };
  }
}

/** Qué hace «Reintentar» con cada aviso: seguir desde el servidor, abrir el popup otra vez, o nada (se resuelve por mail). */
export type Reintento = "servidor" | "popup" | null;

export function reintentoDe(aviso: Aviso): Reintento {
  switch (aviso) {
    case "meta":
    case "esperar":
    case "suscripcion":
    case "registro":
    case "webhook":
      return "servidor";
    case "canje":
    case "token_invalido":
    case "token_vencido":
    case "coexistencia":
    case "sin_numero":
    case "de_la_plataforma":
    case "vencido":
    case "sdk_bloqueado":
      return "popup";
    default:
      return null;
  }
}

/** Lo que dicen los enlaces de /preparando y /configuracion: nada empezado, a medias, caído o hecho. */
export type ResumenDeVista = "nuevo" | "enCurso" | "falla" | "conectado";

export function resumenDeVista(vista: NombreDeVista): ResumenDeVista {
  switch (vista) {
    case "conectado":
      return "conectado";
    case "falla":
      return "falla";
    case "inicio":
    case "abrir":
      return "nuevo";
    default:
      return "enCurso";
  }
}

/** Cómo le cuenta Meta el nombre visible: aprobado, en revisión, o sin aprobar. */
export function estadoDelNombre(nombreEstado: string | null): "aprobado" | "revision" | "otro" | null {
  if (!nombreEstado) return null;
  if (nombreEstado === "APPROVED" || nombreEstado === "AVAILABLE_WITHOUT_REVIEW") return "aprobado";
  return nombreEstado === "PENDING_REVIEW" ? "revision" : "otro";
}
