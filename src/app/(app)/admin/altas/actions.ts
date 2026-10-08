/**
 * Server Actions de /admin/altas: lo que el operador hace sobre cada alta.
 *
 * Una action es un POST que cualquiera puede armar a mano, así que cada una
 * vuelve a pedir `requireOperator` por su cuenta: que la pantalla no muestre el
 * botón no es una guarda. Quien no es operador va a /bandeja sin enterarse de
 * que esto existe, y sin sesión a /login.
 *
 * Todas terminan en un `redirect` a la misma pantalla con el resultado en
 * `?r=` (una lista cerrada, ver `RESULTADOS_DEL_PANEL`): nunca texto que venga
 * del pedido ni del error. `redirect()` tira un error interno de Next, así que
 * va afuera de todo try/catch.
 */

"use server";

import { headers } from "next/headers";
import { redirect } from "next/navigation";

import { ipValida } from "@/lib/audit/log";
import { requireOperator } from "@/lib/auth/require-operator";
import { AppError } from "@/lib/errors";
import { logger } from "@/lib/observability/logger";
import { clientIpFromHeaders } from "@/lib/rate-limit/index";
import {
  activarInquilino,
  conectarNumero,
  darDeBajaNumero,
  extenderPrueba,
  reactivarInquilino,
  reactivarNumero,
  suspenderInquilino,
  suspenderNumero,
  terminosDeActivacion,
  type Operador,
  type ResultadoDelPanel,
} from "@/server/alta/panel-operador";

const RUTA = "/admin/altas";

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

const texto = (form: FormData, campo: string): string => String(form.get(campo) ?? "").trim();

/** Un id de la base tal como lo manda el formulario; null si no tiene forma de uuid. */
function uuid(form: FormData, campo: string): string | null {
  const v = texto(form, campo);
  return UUID.test(v) ? v : null;
}

type Hacer = (op: Operador, form: FormData) => Promise<ResultadoDelPanel>;

/** A dónde sigue el pedido. No redirige: de eso se ocupa `correr`, afuera de todo try/catch. */
async function destino(hacer: Hacer, form: FormData): Promise<string> {
  let op: Operador;
  try {
    const { userRow } = await requireOperator();
    op = { userId: userRow.id, ip: ipValida(clientIpFromHeaders(await headers())) };
  } catch (e) {
    return e instanceof AppError && e.code === "MISSING_SESSION" ? "/login" : "/bandeja";
  }
  try {
    return `${RUTA}?r=${await hacer(op, form)}`;
  } catch (e) {
    logger.error({ error: e instanceof Error ? e.name : "UnknownError" }, "altas.accion_fallo");
    return `${RUTA}?r=falla`;
  }
}

async function correr(hacer: Hacer, form: FormData): Promise<void> {
  redirect(await destino(hacer, form));
}

export async function conectar(form: FormData): Promise<void> {
  await correr(async (op) => {
    const numeroId = uuid(form, "numero_id");
    if (!numeroId) return "datos_invalidos";
    // El código de Meta sólo vale si lo pasó la persona del mail de contacto (H20): sin esa constancia no se conecta.
    if (form.get("prueba_de_control") !== "on") return "no_confirmado";
    return conectarNumero(
      {
        numeroId,
        phoneNumberId: texto(form, "phone_number_id"),
        wabaId: texto(form, "waba_id"),
        pruebaDeControl: true,
      },
      op
    );
  }, form);
}

export async function suspenderElNumero(form: FormData): Promise<void> {
  await correr(async (op) => {
    const id = uuid(form, "numero_id");
    return id ? suspenderNumero(id, op) : "datos_invalidos";
  }, form);
}

export async function reactivarElNumero(form: FormData): Promise<void> {
  await correr(async (op) => {
    const id = uuid(form, "numero_id");
    return id ? reactivarNumero(id, op) : "datos_invalidos";
  }, form);
}

export async function darDeBajaElNumero(form: FormData): Promise<void> {
  await correr(async (op) => {
    const id = uuid(form, "numero_id");
    return id ? darDeBajaNumero(id, op) : "datos_invalidos";
  }, form);
}

export async function suspenderElInquilino(form: FormData): Promise<void> {
  await correr(async (op) => {
    const id = uuid(form, "tenant_id");
    return id ? suspenderInquilino(id, op) : "datos_invalidos";
  }, form);
}

export async function reactivarElInquilino(form: FormData): Promise<void> {
  await correr(async (op) => {
    const id = uuid(form, "tenant_id");
    return id ? reactivarInquilino(id, op) : "datos_invalidos";
  }, form);
}

export async function extenderLaPrueba(form: FormData): Promise<void> {
  await correr(async (op) => {
    const id = uuid(form, "tenant_id");
    const dias = Number(texto(form, "dias"));
    return id && Number.isInteger(dias) ? extenderPrueba(id, dias, op) : "datos_invalidos";
  }, form);
}

export async function activarElInquilino(form: FormData): Promise<void> {
  await correr(async (op) => {
    const id = uuid(form, "tenant_id");
    const terminos = terminosDeActivacion(texto(form, "plan"), {
      cuota: texto(form, "cuota"),
      incluidas: texto(form, "incluidas"),
      excedente: texto(form, "excedente"),
    });
    return id && terminos ? activarInquilino(id, terminos, op) : "datos_invalidos";
  }, form);
}
