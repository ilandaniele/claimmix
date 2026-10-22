/**
 * El texto de los mails de autenticación que salen por el remitente del sistema.
 *
 * Vive aparte de `password-reset.ts` y de /registro para que los dos armen el
 * mismo mail con el mismo texto: el enlace de activación sale de /registro (sin
 * cuenta todavía) y el de recuperación sale de Better Auth.
 *
 * **El saludo no lleva nombre.** El nombre lo escribe quien pide el alta, y un
 * mail de la plataforma con texto de un tercero es un mail de phishing con
 * nuestro remitente.
 */

import "server-only";

import type { getT } from "@/lib/i18n";
import type { CorreoDelSistema } from "./remitente-sistema";

type Traductor = ReturnType<typeof getT>;

/**
 * Un enlace de un solo uso: el de activar una cuenta nueva o el de recuperar el acceso.
 * `sinPerfil` es la recuperación de una cuenta del paso 1 del alta: puede ser sólo de
 * Google, sin contraseña, así que no se le dice que «la actual sigue funcionando».
 */
export function correoDeEnlace(
  t: Traductor,
  caso: "activar" | "recuperar",
  url: string,
  duraMinutos: number,
  sinPerfil = false
): Omit<CorreoDelSistema, "to"> {
  const noFuiste =
    caso === "recuperar" && sinPerfil ? "correo.recuperar.noFuisteSinPerfil" : (`correo.${caso}.noFuiste` as const);
  return {
    asunto: t(`correo.${caso}.asunto`),
    texto: [
      t("correo.saludo"),
      "",
      t(`correo.${caso}.intro`),
      "",
      url,
      "",
      t("correo.enlace.vence").replace("{minutos}", String(duraMinutos)),
      "",
      t(noFuiste),
    ].join("\n"),
  };
}

/** Alguien pidió el alta con una dirección que ya tiene cuenta: se le dice a la dueña, con los dos caminos para entrar. */
export function correoYaTenesCuenta(
  t: Traductor,
  urlDeLogin: string,
  urlDeRecuperar: string
): Omit<CorreoDelSistema, "to"> {
  return {
    asunto: t("correo.yaTenes.asunto"),
    texto: [
      t("correo.saludo"),
      "",
      t("correo.yaTenes.intro"),
      "",
      urlDeLogin,
      "",
      t("correo.yaTenes.recuperar"),
      "",
      urlDeRecuperar,
      "",
      t("correo.yaTenes.noFuiste"),
    ].join("\n"),
  };
}

/**
 * La invitación de un admin. Texto fijo: ni el espacio ni quien invita aparecen
 * en el mail, porque los escribe un tercero y el mail sale con nuestro remitente.
 * De quién es lo ve la persona en la pantalla del enlace, antes de decidir.
 */
export function correoDeInvitacion(t: Traductor, url: string, duraHoras: number): Omit<CorreoDelSistema, "to"> {
  return {
    asunto: t("correo.invitacion.asunto"),
    texto: [
      t("correo.saludo"),
      "",
      t("correo.invitacion.intro"),
      "",
      url,
      "",
      t("correo.invitacion.vence").replace("{horas}", String(duraHoras)),
      "",
      t("correo.invitacion.noFuiste"),
    ].join("\n"),
  };
}
