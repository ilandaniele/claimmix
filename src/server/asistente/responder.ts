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
import { RE_CENTINELA, sinCentinelas } from "@/core/ai/sin-centinelas";
import { IntencionSchema, textoDelConteo, type Intencion } from "@/core/asistente/intencion";
import { promptIntencion, PROMPT_RESUMEN } from "@/server/asistente/prompts";
import {
  buscarCaso,
  contarCasos,
  type CasoEncontrado,
  type DetalleDelCaso,
} from "@/server/asistente/herramientas";
import type { TenantContext } from "@/data/scope";
import { AuditEvent, writeAuditLog } from "@/lib/audit/log";

export interface RespuestaDelAsistente {
  /** Texto plano, sin HTML ni markdown. <= 1500 caracteres. */
  texto: string;
  herramienta: "contar_casos" | "buscar_caso" | "ninguna";
  /** <= 5. */
  casos: CasoEncontrado[];
}

const TEXTO_AYUDA =
  "No entendí la pregunta. Puedo contar casos (\"¿cuántos casos hubo este mes?\") " +
  "o buscar un caso puntual por nombre o número de póliza (\"qué pasó con el caso de Roberto Paz\").";

function textoDeBusqueda(cantidad: number): string {
  if (cantidad === 0) return "No encontré ningún caso con esos datos.";
  return `Encontré ${cantidad} casos parecidos. Elegí uno de la lista para verlo.`;
}

/** El resumen sin modelo, para cuando la llamada falla o su salida no pasa la guarda. */
function resumenDeterministico(d: DetalleDelCaso): string {
  const estado = `Caso de tipo ${d.tipo ?? "sin especificar"}, en estado "${d.estado}".`;
  const faltantes =
    d.documentos_faltantes.length > 0
      ? `Falta: ${d.documentos_faltantes.join(", ")}.`
      : "No hay documentación pendiente.";
  return `${estado} ${faltantes}`.slice(0, 1200);
}

/** Clasifica la intención con Gemini. Cualquier falla —de red, de parseo, de forma— cae en "ninguna". */
async function clasificarIntencion(tenantId: string, pregunta: string): Promise<Intencion> {
  try {
    const mensaje = `<pregunta_del_usuario>${sinCentinelas(pregunta)}</pregunta_del_usuario>`;
    const { text, usage, model } = await callGemini(promptIntencion(), mensaje);
    await registrarConsumoDelModelo(tenantId, model, usage);
    if (!text) return { herramienta: "ninguna" };

    const parsed = IntencionSchema.safeParse(JSON.parse(text));
    return parsed.success ? parsed.data : { herramienta: "ninguna" };
  } catch {
    return { herramienta: "ninguna" };
  }
}

/** El resumen de un único caso. Valida la salida del modelo antes de confiar en ella. */
async function resumenDelCaso(tenantId: string, detalle: DetalleDelCaso): Promise<string> {
  try {
    const datos = `<datos_del_caso>${sinCentinelas(JSON.stringify(detalle))}</datos_del_caso>`;
    const { text, usage, model } = await callGemini(PROMPT_RESUMEN, datos);
    await registrarConsumoDelModelo(tenantId, model, usage);

    if (text) {
      const parsed = JSON.parse(text) as { resumen?: unknown };
      const resumen = typeof parsed.resumen === "string" ? parsed.resumen.trim() : "";
      const valido =
        resumen.length > 0 &&
        resumen.length <= 1200 &&
        !RE_CENTINELA.test(resumen) &&
        !/https?:\/\//i.test(resumen);
      if (valido) return resumen;
    }
  } catch {
    // sigue al resumen determinístico.
  }
  return resumenDeterministico(detalle);
}

export async function responderPregunta(
  ctx: RoleContext,
  pregunta: string
): Promise<RespuestaDelAsistente> {
  const tenantId = ctx.userRow.tenant_id;
  const tenantCtx: TenantContext = { tenantId };

  const presupuesto = await checkBudget(tenantId, ctx.user.id);
  if (presupuesto.exceeded) throw new AppError("AI_BUDGET_EXCEEDED", presupuesto.reason);

  const intencion = await clasificarIntencion(tenantId, pregunta);

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
          ? await resumenDelCaso(tenantId, resultado.detalle!)
          : textoDeBusqueda(resultado.coincidencias.length),
        herramienta: "buscar_caso",
        casos: resultado.coincidencias,
      };
      break;
    }
    default:
      respuesta = { texto: TEXTO_AYUDA, herramienta: "ninguna", casos: [] };
  }

  respuesta.texto = respuesta.texto.slice(0, 1500);

  await writeAuditLog({
    tenant_id: tenantId,
    actor_id: ctx.user.id,
    event_type: AuditEvent.ASSISTANT_QUERY,
    payload: { herramienta: respuesta.herramienta, casos: respuesta.casos.length },
  });

  return respuesta;
}
