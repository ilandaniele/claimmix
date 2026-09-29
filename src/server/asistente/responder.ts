/**
 * `POST /api/asistente` — el flujo entero de una pregunta.
 *
 * El modelo nunca decide qué corre: elige una de tres herramientas fijas
 * (`IntencionSchema`), y esa elección ya validada es lo único que llega a las
 * consultas de `herramientas.ts`. Un conteo se responde con texto
 * determinístico, sin segunda llamada. Un resumen de UN caso sí llama de
 * nuevo al modelo, y sólo ve los datos de ESE caso, ya enmascarados por rol y
 * con los centinelas propios rotos antes de entrar al prompt.
 *
 * Lo único que se audita es `{ herramienta, casos }`. La pregunta y la
 * respuesta son texto libre de una persona y del modelo: no van a
 * `audit_log`.
 */

import "server-only";

import { AppError } from "@/lib/errors";
import type { RoleContext } from "@/lib/auth/require-role";
import { checkBudget, registrarConsumoDelModelo } from "@/server/ai/budget";
import { callGemini } from "@/server/ai/gemini-extractor";
import { sinCentinelas } from "@/core/ai/sin-centinelas";
import { resumenValido } from "@/core/ai/resumen-seguro";
import { IntencionSchema, textoDelConteo, type Intencion } from "@/core/asistente/intencion";
import { promptIntencion, PROMPT_RESUMEN } from "@/server/asistente/prompts";
import {
  buscarCaso,
  contarCasos,
  TOPE_COINCIDENCIAS,
  type CasoEncontrado,
  type DetalleDelCaso,
} from "@/server/asistente/herramientas";
import type { TenantContext } from "@/data/scope";
import { AuditEvent, writeAuditLog } from "@/lib/audit/log";
import { getT, type TranslationKey } from "@/lib/i18n";
import { etiquetaDeCampo } from "@/lib/labels/etiqueta-de-campo";

export interface RespuestaDelAsistente {
  /** Texto plano, sin HTML ni markdown. <= 1500 caracteres. */
  texto: string;
  herramienta: "contar_casos" | "buscar_caso" | "ninguna";
  /** <= 5. */
  casos: CasoEncontrado[];
}

const TEXTO_AYUDA =
  "No entendí la pregunta. Puedo contar casos (\"¿cuántos casos hubo este mes?\") " +
  "o buscar un caso puntual por nombre, número de póliza o número de caso (SIN-XXXX-XXXX) " +
  "(\"qué pasó con el caso de Roberto Paz\").";

/** Tope de la respuesta entera — ver el `.slice` final en `responderPregunta`. */
const TOPE_TEXTO_RESPUESTA = 1500;
/** Entre el prefijo determinístico y el resumen del modelo, en `resumenDelCaso`. */
const SEPARADOR_RESUMEN = "\n\n";

/** Los textos determinísticos de acá van siempre en castellano, como el resto del módulo. */
const t = getT("es-AR");

function textoDeBusqueda(cantidad: number, hayMas: boolean): string {
  if (cantidad === 0) return "No encontré ningún caso con esos datos.";
  const cuantos = hayMas ? `más de ${TOPE_COINCIDENCIAS}` : String(cantidad);
  return `Encontré ${cuantos} casos parecidos. Elegí uno de la lista para verlo.`;
}

/**
 * El resumen sin modelo: estado y documentos faltantes, con las etiquetas que
 * ya usa el resto de la app (nunca la clave cruda). Es también el PREFIJO fijo
 * de todo resumen con modelo —ver `resumenDelCaso`—: lo único de la respuesta
 * que no puede mentir es lo que arma el código a partir de la base, así que va
 * siempre primero, la haya escrito el modelo o no.
 */
function resumenDeterministico(d: DetalleDelCaso): string {
  const estado = t(`status.${d.estado}` as TranslationKey);
  // Misma conversión que `valorParaMostrar` para `claim_type`: la clave cruda
  // ("choque") nunca se le muestra a una persona.
  const tipo = d.tipo ? t(`type.${d.tipo}` as TranslationKey) : "sin especificar";
  const faltantes =
    d.documentos_faltantes.length > 0
      ? `Falta: ${d.documentos_faltantes.map((clave) => etiquetaDeCampo(clave, t)).join(", ")}.`
      : "No hay documentación pendiente.";
  return `Caso de tipo ${tipo}, en estado "${estado}". ${faltantes}`.slice(0, 1200);
}

/**
 * Recorta `texto` a `tope` caracteres sin cortar una palabra al medio:
 * retrocede hasta el último espacio adentro del límite. Con `tope` demasiado
 * chico para ni una palabra entera, devuelve "": mejor sin resumen del modelo
 * que uno mutilado.
 */
function recortarAPalabra(texto: string, tope: number): string {
  if (texto.length <= tope) return texto;
  if (tope <= 0) return "";
  const cortado = texto.slice(0, tope);
  const ultimoEspacio = cortado.lastIndexOf(" ");
  return ultimoEspacio > 0 ? cortado.slice(0, ultimoEspacio) : "";
}

/**
 * Clasifica la intención con Gemini.
 *
 * Una falla TÉCNICA de la llamada (timeout de Vertex, 429, sin red) se
 * relanza como `IA_NO_DISPONIBLE`: antes caía acá mismo en "ninguna" y la
 * persona leía "no entendí la pregunta" ante una IA caída, que es el mensaje
 * equivocado para el problema que hubo. Sólo una salida que no es JSON o no
 * respeta `IntencionSchema` —la letra del modelo, no la infraestructura— cae
 * en "ninguna".
 */
async function clasificarIntencion(tenantId: string, userId: string, pregunta: string): Promise<Intencion> {
  const mensaje = `<pregunta_del_usuario>${sinCentinelas(pregunta)}</pregunta_del_usuario>`;

  let text: string | null;
  let usage: Parameters<typeof registrarConsumoDelModelo>[2];
  let model: string;
  try {
    ({ text, usage, model } = await callGemini(promptIntencion(), mensaje));
  } catch {
    throw new AppError("IA_NO_DISPONIBLE");
  }

  await registrarConsumoDelModelo(tenantId, model, usage, userId);
  if (!text) return { herramienta: "ninguna" };

  try {
    const parsed = IntencionSchema.safeParse(JSON.parse(text));
    return parsed.success ? parsed.data : { herramienta: "ninguna" };
  } catch {
    return { herramienta: "ninguna" };
  }
}

/** El resumen de un único caso. Valida la salida del modelo antes de confiar en ella. */
async function resumenDelCaso(tenantId: string, userId: string, detalle: DetalleDelCaso): Promise<string> {
  const prefijo = resumenDeterministico(detalle);
  try {
    const datos = `<datos_del_caso>${sinCentinelas(JSON.stringify(detalle))}</datos_del_caso>`;
    const { text, usage, model } = await callGemini(PROMPT_RESUMEN, datos);
    await registrarConsumoDelModelo(tenantId, model, usage, userId);

    if (text) {
      const parsed = JSON.parse(text) as { resumen?: unknown };
      const resumen = typeof parsed.resumen === "string" ? parsed.resumen.trim() : "";
      // Lo único que el resumen puede repetir son los números de la póliza y
      // de los campos extraídos (G12).
      if (resumenValido(resumen, [detalle.poliza, ...detalle.campos.map((c) => c.valor)])) {
        // El prefijo nunca se recorta acá: es lo único que no puede mentir
        // (ver comentario de `resumenDeterministico`). Lo que cede es el
        // resumen del modelo, y en un borde de palabra — nunca a la mitad.
        const espacio = TOPE_TEXTO_RESPUESTA - prefijo.length - SEPARADOR_RESUMEN.length;
        const acortado = recortarAPalabra(resumen, espacio);
        return acortado ? `${prefijo}${SEPARADOR_RESUMEN}${acortado}` : prefijo;
      }
    }
  } catch {
    // sigue al resumen determinístico: acá una falla técnica no se relanza,
    // porque ya hay una respuesta útil (el prefijo) para devolver.
  }
  return prefijo;
}

export async function responderPregunta(
  ctx: RoleContext,
  pregunta: string
): Promise<RespuestaDelAsistente> {
  const tenantId = ctx.userRow.tenant_id;
  const tenantCtx: TenantContext = { tenantId };

  const presupuesto = await checkBudget(tenantId, ctx.user.id);
  if (presupuesto.exceeded) throw new AppError("AI_BUDGET_EXCEEDED", presupuesto.reason);

  const intencion = await clasificarIntencion(tenantId, ctx.user.id, pregunta);

  let respuesta: RespuestaDelAsistente;

  switch (intencion.herramienta) {
    case "contar_casos": {
      const resultado = await contarCasos(tenantCtx, intencion);
      respuesta = {
        texto: textoDelConteo(resultado, intencion),
        herramienta: "contar_casos",
        casos: [],
      };
      break;
    }
    case "buscar_caso": {
      const resultado = await buscarCaso(tenantCtx, intencion, ctx.userRow.role);
      const unSoloCaso = resultado.coincidencias.length === 1 && resultado.detalle;
      respuesta = {
        texto: unSoloCaso
          ? await resumenDelCaso(tenantId, ctx.user.id, resultado.detalle!)
          : textoDeBusqueda(resultado.coincidencias.length, resultado.hayMas),
        herramienta: "buscar_caso",
        casos: resultado.coincidencias,
      };
      break;
    }
    default:
      respuesta = { texto: TEXTO_AYUDA, herramienta: "ninguna", casos: [] };
  }

  respuesta.texto = respuesta.texto.slice(0, TOPE_TEXTO_RESPUESTA);

  await writeAuditLog({
    tenant_id: tenantId,
    actor_id: ctx.user.id,
    event_type: AuditEvent.ASSISTANT_QUERY,
    payload: { herramienta: respuesta.herramienta, casos: respuesta.casos.length },
  });

  return respuesta;
}
