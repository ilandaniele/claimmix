/**
 * Server Actions de /alta: crear el espacio de quien eligió «dar de alta mi empresa»
 * y pedir acceso al de su empresa.
 *
 * Acá se mira lo que no gasta cupos (sesión, correo verificado, que no sea de
 * operación, que el alta esté abierta para esa dirección, que no tenga ya
 * espacio); quien ya tiene espacio vuelve a /bandeja sin tocar ningún contador.
 * El resto (datos, cupo por IP, la función de la base) está en `crearEspacio`, un
 * módulo de servidor: un archivo con "use server" publica todos sus exports.
 *
 * `pedirAcceso` responde igual a todo el mundo: no lee el formulario, no toca la base
 * ni ningún contador antes de contestar, deja la cookie de 2 minutos con que /alta
 * muestra el estado y vuelve siempre a /alta. El trabajo (`pedirAccesoAlEspacio`)
 * corre en `after()`.
 *
 * NOTE: redirect() must NOT be wrapped in try/catch — it throws a special
 * Next.js internal error to trigger the redirect.
 */

"use server";

import { headers } from "next/headers";
import { redirect } from "next/navigation";
import { after } from "next/server";

import { altaAbierta } from "@/lib/auth/registro-permitido";
import { isOperatorEmail } from "@/lib/auth/require-operator";
import { getSessionContext, type SessionContext } from "@/lib/auth/session";
import { getUserRowOrThrow } from "@/lib/auth/user-row";
import { logger } from "@/lib/observability/logger";
import { clientIpFromHeaders } from "@/lib/rate-limit/index";
import { avisarAlOperador, llegoAlAviso } from "@/server/alta/aviso-operador";
import { conError, crearEspacio } from "@/server/alta/crear-espacio";
import type { AltaCreada } from "@/server/alta/crear-inquilino";
import { numeroAutomatico } from "@/server/alta/numero-automatico-activo";
import { pedirAccesoAlEspacio, ponerCookieDePedido } from "@/server/alta/pedir-acceso";

type Usuario = NonNullable<SessionContext>["user"];

/** La guarda de las dos acciones: sesión con correo verificado que no sea de operación, o la ruta a la que volver. Nunca redirige. */
async function personaDelAlta(): Promise<{ usuario: Usuario } | { destino: string }> {
  const usuario = (await getSessionContext())?.user;
  if (!usuario) return { destino: "/login" };

  // La pantalla dice por qué no; acá sólo se vuelve a ella.
  if (usuario.emailVerified !== true || isOperatorEmail(usuario.email)) return { destino: "/alta" };
  return { usuario };
}

/** Avisa al operador, ya con la respuesta enviada, si con este espacio el día llega al aviso. No se exporta: todo export de este archivo es un endpoint. */
function avisarSiLlegoAlTope({ creadas24h, tope }: AltaCreada): void {
  if (creadas24h !== null && tope !== null && llegoAlAviso(creadas24h, tope)) {
    after(() => avisarAlOperador(creadas24h, tope));
  }
}

/** La ruta a la que sigue el pedido. Nunca redirige: de eso se ocupa quien la llama, fuera de todo try/catch. */
async function destinoDelAlta(formData: FormData): Promise<string> {
  const persona = await personaDelAlta();
  if ("destino" in persona) return persona.destino;
  const { usuario } = persona;
  if (!altaAbierta(usuario.email)) return "/alta";

  let tienePerfil: boolean;
  try {
    tienePerfil = (await getUserRowOrThrow(usuario.id)) !== null;
  } catch (e) {
    logger.error({ error: e instanceof Error ? e.name : "UnknownError" }, "alta.perfil_no_leido");
    return conError("falla");
  }
  if (tienePerfil) return "/bandeja";

  const { destino, alta } = await crearEspacio({
    userId: usuario.id,
    empresa: formData.get("empresa"),
    whatsapp: formData.get("whatsapp"),
    terminos: formData.get("terminos") === "on",
    numeroAutomatico: numeroAutomatico(),
    ip: clientIpFromHeaders(await headers()),
  });
  if (alta) avisarSiLlegoAlTope(alta);
  return destino;
}

export async function crearMiEspacio(formData: FormData): Promise<void> {
  redirect(await destinoDelAlta(formData));
}

/** Sin argumentos a propósito: ni el correo ni el id salen de lo que mande el navegador, sino de la sesión. */
export async function pedirAcceso(): Promise<void> {
  const persona = await personaDelAlta();
  if ("destino" in persona) redirect(persona.destino);

  const { id: userId, email } = persona.usuario;
  after(() => pedirAccesoAlEspacio({ userId, email }));
  await ponerCookieDePedido(userId);
  redirect("/alta");
}
