/**
 * El aviso al operador cuando el uso del proyecto se acerca a un tope, o lo llena.
 *
 * Los cuatro que cuestan plata o cierran el alta: el gasto de IA del mes (`MONTHLY_BUDGET_USD`), el
 * pozo de las pruebas (`AI_PRUEBAS_MONTHLY_BUDGET_USD`), la cantidad de bases de cliente
 * (`ALTA_TOPE_BASES`) y el peso del proyecto en Neon (`ALTA_TOPE_MB`). Con cada uno se avisa al
 * pasar el 80 % y al llegar al 100 %, una sola vez por umbral, tope y mes: sin la marca, cada
 * barrido (cada 15 minutos en dev) repetiría el mail mientras el uso siga arriba.
 *
 * La marca lleva el valor del tope: si el operador lo sube después del aviso, el tope nuevo tiene sus
 * propios avisos y el uso que lo llene en el mismo mes no queda mudo. Al llegar al 100 % se marca
 * también el 80: si el uso baja y vuelve a ese tramo, no avisa «pasó el 80 %» después de «llegó al tope».
 *
 * Se mide con la misma cuenta con la que el sistema decide: el gasto es el de `checkBudget` y el
 * catálogo y sus topes son los del alta (`catalogo.ts`), así que el aviso llega antes de que algo se
 * cierre y no contradice a quien se cierra. Una consulta trae las cuatro medidas, y del catálogo sólo
 * se mide lo que tiene tope (con 0 el tope no existe, o la IA está parada a propósito, y avisar sería
 * ruido). Las marcas ya puestas se leen en una sentencia y las de todos los topes avisados se ponen
 * en otra.
 *
 * La marca se pone después del mail, no antes: una puesta antes y huérfana (la corrida murió en el
 * envío, o la base perdió la respuesta del insert) dejaría ese umbral mudo todo el mes, incluso el
 * 100 % con la IA ya cortada. Lo que se acepta a cambio es que dos corridas simultáneas, o una que
 * mandó y no llegó a marcar, repitan el mail una vez; `reap-stuck` serializa las corridas y el cupo
 * global del tipo `topes` acota el resto.
 *
 * Sale por el remitente del sistema, en un solo mail por barrido a cada dirección de `ADMIN_EMAILS`.
 * El mail lleva números y nombres de tope, nada de nadie. Nunca lanza: va en el barrido de
 * `reap-stuck` y no puede frenar lo demás.
 */

import "server-only";

import { sql } from "drizzle-orm";

import { inicioDelMes } from "@/core/fecha/inicio-del-mes";
import { getT } from "@/lib/i18n";
import { logger } from "@/lib/observability/logger";
import { claveDeCupo } from "@/lib/rate-limit/clave";
import { marcasPuestas, ponerMarcas } from "@/lib/rate-limit/postgres";
import { topeEntero, topeMensualDelProyecto } from "@/lib/topes";
import { getDemoTenantId, sumaMensualDelProyecto } from "@/server/ai/budget";
import {
  destinatariosDeOperacion,
  mandarAlOperador,
  umbralDelTope,
  type UmbralDeAviso,
} from "@/server/alta/aviso-operador";
import { BASES_DE_CLIENTE, MB_DEL_PROYECTO, topeDeBases, topeDeMb } from "@/server/alta/catalogo";

const NOMBRES = ["presupuesto", "pruebas", "bases", "mb"] as const;
type NombreDeTope = (typeof NOMBRES)[number];

/** Lo usado nunca se muestra por encima de lo real: redondeado hacia arriba, el aviso del 80 % diría «350 de 350». */
function sinPasarse(n: number, decimales: number): string {
  const cerca = Number(n.toFixed(decimales));
  return (cerca > n ? cerca - 10 ** -decimales : cerca).toFixed(decimales);
}
const dolares = (n: number) => sinPasarse(n, 2);
const enteros = (n: number) => sinPasarse(n, 0);
const FORMATO: Record<NombreDeTope, (n: number) => string> = {
  presupuesto: dolares,
  pruebas: dolares,
  bases: enteros,
  mb: enteros,
};

interface Cruzado {
  nombre: NombreDeTope;
  umbral: UmbralDeAviso;
  usado: number;
  tope: number;
}

/**
 * Avisa de los topes que llegaron a un umbral nuevo en el mes de `ahora`. Devuelve cuántos umbrales
 * avisó (0 si no había nada nuevo, no hay remitente o destinatarios, o el mail no salió).
 */
export async function avisarTopes(ahora: Date = new Date()): Promise<number> {
  const inicio = inicioDelMes(ahora);
  // La marca dura hasta que empieza el mes siguiente: ahí la purga del limitador la lleva.
  const vence = new Date(inicio.getFullYear(), inicio.getMonth() + 1, 1);
  const periodo = `${inicio.getFullYear()}-${String(inicio.getMonth() + 1).padStart(2, "0")}`;
  const clave = (c: Cruzado, umbral: UmbralDeAviso) =>
    claveDeCupo("aviso-tope", c.nombre, String(c.tope), String(umbral), periodo);
  try {
    const destinatarios = destinatariosDeOperacion();
    if (destinatarios.length === 0) return 0;

    const topes: Record<NombreDeTope, number> = {
      presupuesto: topeMensualDelProyecto(),
      pruebas: topeEntero("AI_PRUEBAS_MONTHLY_BUDGET_USD"),
      bases: topeDeBases(),
      mb: topeDeMb(),
    };
    const medido = await sumaMensualDelProyecto(
      inicio,
      getDemoTenantId(),
      {
        ...(topes.bases > 0 ? { bases: sql<number>`${BASES_DE_CLIENTE}::int` } : {}),
        ...(topes.mb > 0 ? { mb: sql<number>`(${MB_DEL_PROYECTO})::float8` } : {}),
      },
      "alta.aviso_topes_medicion_fallo"
    );
    // Si no se pudo medir no se avisa nada: el error ya quedó en el registro y el barrido siguiente lo vuelve a intentar.
    if (!medido.ok) return 0;
    const usados: Record<NombreDeTope, number> = {
      presupuesto: medido.total,
      pruebas: medido.pruebas,
      bases: medido.extras.bases ?? 0,
      mb: medido.extras.mb ?? 0,
    };

    const cruzados = NOMBRES.flatMap((nombre): Cruzado[] => {
      const umbral = umbralDelTope(usados[nombre], topes[nombre]);
      return umbral ? [{ nombre, umbral, usado: usados[nombre], tope: topes[nombre] }] : [];
    });
    if (cruzados.length === 0) return 0;

    const puestas = await marcasPuestas(
      cruzados.map((c) => clave(c, c.umbral)),
      vence
    );
    const nuevos = cruzados.filter((c) => !puestas.has(clave(c, c.umbral)));
    if (nuevos.length === 0) return 0;

    const t = getT("es-AR");
    const lineas = nuevos.map((c) =>
      t(c.umbral === 100 ? "alta.avisoTope.linea100" : "alta.avisoTope.linea80")
        .replace("{nombre}", t(`alta.avisoTope.${c.nombre}.nombre`))
        .replace("{usado}", FORMATO[c.nombre](c.usado))
        .replace("{tope}", FORMATO[c.nombre](c.tope))
        .replace("{llena}", t(`alta.avisoTope.${c.nombre}.llena`))
    );
    const texto = [t("alta.avisoTope.intro"), ...lineas, "", t("alta.avisoTope.cierre")].join("\n");
    // Si no salió a ninguno el aviso no se dio: sin marca, el barrido siguiente lo intenta de nuevo.
    if (!(await mandarAlOperador(destinatarios, t("alta.avisoTope.asunto"), texto, "topes"))) return 0;
    await ponerMarcas(
      nuevos.flatMap((c) => (c.umbral === 100 ? [clave(c, 80), clave(c, 100)] : [clave(c, 80)])),
      vence
    );
    for (const c of nuevos) logger.warn({ tope: c.nombre, umbral: c.umbral }, "alta.tope_avisado");
    return nuevos.length;
  } catch (e) {
    logger.error({ error: e instanceof Error ? e.name : "UnknownError" }, "alta.aviso_topes_fallo");
    return 0;
  }
}
