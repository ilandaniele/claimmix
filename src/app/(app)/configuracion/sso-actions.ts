"use server";

/**
 * Las acciones del panel de SSO (B19): el mismo trabajo que /api/admin/sso, sin
 * JavaScript de cliente.
 *
 * Cada una llama al manejador de la ruta con un pedido armado acá, así que la
 * puerta (sesión, rol admin, cupo) y las reglas son las de la API y hay un solo
 * lugar donde cambiarlas. Después redirige a /configuracion con el resultado
 * (ver `sso-resultados.ts`). `redirect()` va siempre afuera de los try: tira un
 * error interno de Next y el catch se lo comería.
 */

import { redirect } from "next/navigation";
import { NextRequest } from "next/server";

import { PATCH, POST, PUT } from "@/app/api/admin/sso/route";
import { logger } from "@/lib/observability/logger";
import { urlDelSso } from "@/server/sso/ingreso";

import {
  resultadoDeLaVerificacion,
  resultadoDeRechazo,
  type ResultadoSso,
} from "./sso-resultados";

type Manejador = (request: NextRequest) => Promise<Response>;

const RUTA = "/configuracion";
const URL_DE_LA_API = "http://interno.local/api/admin/sso";

const volver = (resultado: ResultadoSso): never => redirect(`${RUTA}?sso=${resultado}`);

/** Llama a la ruta y devuelve su respuesta ya leída; un fallo inesperado es `{ ok: false, cuerpo: null }`. */
async function llamar(
  manejador: Manejador,
  method: "PUT" | "POST" | "PATCH",
  cuerpo: object
): Promise<{ ok: boolean; cuerpo: unknown }> {
  try {
    const respuesta = await manejador(
      new NextRequest(URL_DE_LA_API, {
        method,
        headers: { "content-type": "application/json" },
        body: JSON.stringify(cuerpo),
      })
    );
    return { ok: respuesta.ok, cuerpo: await respuesta.json().catch(() => null) };
  } catch (e) {
    logger.error({ detalle: e instanceof Error ? e.message : String(e) }, "configuracion.sso_accion_fallo");
    return { ok: false, cuerpo: null };
  }
}

const texto = (form: FormData, campo: string): string => String(form.get(campo) ?? "").trim();

export async function guardarSso(form: FormData): Promise<void> {
  const secreto = texto(form, "client_secret");
  const r = await llamar(PUT, "PUT", {
    issuer: texto(form, "issuer"),
    client_id: texto(form, "client_id"),
    dominio: texto(form, "dominio"),
    // Vacío = conservar el que está: el campo nunca viene con el secreto cargado.
    ...(secreto ? { client_secret: secreto } : {}),
  });
  volver(r.ok ? "guardado" : resultadoDeRechazo(r.cuerpo));
}

export async function verificarSso(): Promise<void> {
  const r = await llamar(POST, "POST", { accion: "verificar" });
  volver(r.ok ? resultadoDeLaVerificacion(r.cuerpo) : resultadoDeRechazo(r.cuerpo));
}

/** Prender, apagar, exigir y dejar de exigir: un campo y un valor, del botón que se apretó. */
export async function cambiarSso(form: FormData): Promise<void> {
  const campo = texto(form, "campo");
  if (campo !== "activo" && campo !== "exigir") return volver("fallo");
  const valor = texto(form, "valor") === "1";

  const r = await llamar(PATCH, "PATCH", { [campo]: valor });
  if (!r.ok) return volver(resultadoDeRechazo(r.cuerpo));

  if (campo === "activo") return volver(valor ? "activado" : "apagado");
  if (!valor) return volver("noExigido");
  const { sesiones_cerradas } = (r.cuerpo ?? {}) as { sesiones_cerradas?: unknown };
  return volver(sesiones_cerradas === null ? "exigidoSinCerrar" : "exigido");
}

/**
 * Entrar una vez con el SSO desde acá: exigirlo pide la prueba de que el camino
 * le anda a quien lo exige, y esta es la forma de dejarla. Vuelve al panel, no a la bandeja.
 */
export async function probarSso(form: FormData): Promise<void> {
  const url = await urlDelSso(texto(form, "email"), `${RUTA}?sso=probado`, `${RUTA}?sso=pruebaFallo`);
  if (!url) return volver("pruebaFallo");
  redirect(url);
}
