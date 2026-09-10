/**
 * Qué filtros existen en la bandeja, en un solo lugar.
 *
 * Estaban repartidos en dos archivos y cuatro componentes —`TypeFilterChips` y
 * los tres de `EmailFilterChips`— que hacían exactamente lo mismo con distinta
 * lista adentro: armar botones, comparar contra el valor activo, y empujar el
 * parámetro a la URL. Cuatro copias del mismo bucle.
 *
 * El costo no era el código repetido sino que **nadie podía contestar «qué
 * filtros hay puestos»** sin volver a enumerar los cuatro grupos a mano. Eso es
 * justo lo que necesita el panel: un botón que diga cuántos hay, y una marca por
 * cada uno que se pueda sacar. Con la lista acá, las dos cosas salen de
 * recorrerla.
 *
 * ── Dos cosas que estaban mal y se arreglan al juntarlas ────────────────────
 *
 * **Faltaban los dos canales de WhatsApp.** El grupo ofrecía tres opciones
 * —todos, email, simulación— mientras que `CaseQuerySchema`, `VALID_CHANNELS`
 * de `page.tsx` y los dos diccionarios ya aceptaban `whatsapp` y
 * `whatsapp_sim` desde siempre. O sea que con WhatsApp andando en producción,
 * los siniestros que entran por ahí no se podían filtrar desde la pantalla, y
 * no fallaba nada: simplemente no estaba el chip.
 *
 * **Faltaba «Otro».** `ClaimTypeSchema` lo tiene y la tabla lo muestra en la
 * columna de tipo, así que se podía ver un caso «Otro» en la lista y no había
 * forma de pedir los otros.
 *
 * Las etiquetas son CLAVES de i18n, no texto: el texto lo resuelve quien
 * renderiza, que es el único que tiene el `useT()`.
 */

import type { TranslationKey } from "@/lib/i18n";

export interface OpcionDeFiltro {
  /** Lo que va al parámetro de la URL. */
  clave: string;
  /** Clave de i18n de lo que se lee en el chip. */
  etiqueta: TranslationKey;
  /**
   * Sólo la severidad lo usa: el color de su nivel. Pinta el chip cuando está
   * elegido y el puntito de la marca cuando está puesto, porque el color ES lo
   * que se está filtrando y perderlo al mudar la severidad adentro del panel
   * sería perder información, no decoración.
   */
  color?: string;
}

export interface GrupoDeFiltro {
  /** El parámetro de búsqueda que este grupo escribe. */
  param: string;
  /** Clave de i18n del título del grupo. */
  rotulo: TranslationKey;
  opciones: OpcionDeFiltro[];
}

/*
 * ── Por qué no hay un chip «Todos» en ningún grupo ──────────────────────────
 *
 * Lo había, uno por grupo, y estaba encendido siempre que ese grupo no
 * filtrara: cuatro chips violetas permanentes compitiendo con el único que de
 * verdad estaba filtrando algo. Con las marcas afuera del panel, **la ausencia
 * de marca ya significa «todos»**, así que el chip no agrega un estado: agrega
 * ruido.
 *
 * Se saca un filtro apretando de nuevo el chip encendido, o la marca de afuera.
 *
 * El orden es el de la pantalla, y no es alfabético: arriba lo que un analista
 * toca todos los días, abajo lo que toca cuando busca algo puntual.
 */
export const GRUPOS_DE_FILTRO: GrupoDeFiltro[] = [
  /*
   * El estado, que hasta hoy vivía afuera en seis pestañas.
   *
   * Estaba afuera con un argumento que era cierto —llevan el contador, así
   * que informan sin que las toquen— y que dejó de serlo cuando se midió:
   * las pestañas contaban un estado SUELTO y las baldosas de arriba
   * agrupaban, así que «Escalado» decía 1 mientras la baldosa decía 43.
   * Tres de las cinco decían 0 sobre 483 casos.
   *
   * Adentro del panel, y con el contador puesto en el chip, informan igual y
   * dejan la franja de arriba para lo que se mira todo el día. El grupo que
   * cubre cada opción está en `@/core/case/filtro-de-estado`.
   */
  {
    param: "status",
    rotulo: "filter.estado",
    opciones: [
      { clave: "procesando", etiqueta: "tabs.procesando" },
      { clave: "esperando", etiqueta: "tabs.esperando" },
      { clave: "confirmacion_pendiente", etiqueta: "status.confirmacion_pendiente" },
      { clave: "escalado", etiqueta: "tabs.escalado" },
      { clave: "listo", etiqueta: "tabs.listo" },
      { clave: "cerrado", etiqueta: "tabs.cerrado" },
    ],
  },
  {
    param: "type",
    rotulo: "filter.tipo",
    opciones: [
      { clave: "choque", etiqueta: "type.choque" },
      { clave: "robo", etiqueta: "type.robo" },
      { clave: "granizo", etiqueta: "type.granizo" },
      { clave: "incendio", etiqueta: "type.incendio" },
      { clave: "cristales", etiqueta: "type.cristales" },
      { clave: "rc", etiqueta: "type.rc" },
      { clave: "robo_contenido", etiqueta: "type.robo_contenido" },
      { clave: "accidente_personal", etiqueta: "type.accidente_personal" },
      { clave: "other", etiqueta: "type.other" },
    ],
  },
  {
    param: "severity",
    rotulo: "filter.severity",
    opciones: [
      { clave: "low", etiqueta: "severity.low", color: "bg-slate-400" },
      { clave: "medium", etiqueta: "severity.medium", color: "bg-yellow-500" },
      { clave: "high", etiqueta: "severity.high", color: "bg-orange-500" },
      { clave: "critical", etiqueta: "severity.critical", color: "bg-red-600" },
    ],
  },
  {
    param: "channel",
    rotulo: "filter.channel",
    opciones: [
      { clave: "email", etiqueta: "channel.email" },
      { clave: "whatsapp", etiqueta: "channel.whatsapp" },
      { clave: "email_sim", etiqueta: "channel.email_sim" },
      { clave: "whatsapp_sim", etiqueta: "channel.whatsapp_sim" },
    ],
  },
  {
    param: "is_claim",
    rotulo: "filter.isClaim",
    opciones: [
      { clave: "true", etiqueta: "filter.reclamos" },
      { clave: "false", etiqueta: "filter.no_relevantes" },
    ],
  },
];

/** Los parámetros que maneja el panel. Los usa «Limpiar» para borrarlos todos. */
export const PARAMS_DE_FILTRO = GRUPOS_DE_FILTRO.map((g) => g.param);

export interface FiltroPuesto {
  param: string;
  /** Clave de i18n del grupo, para leer «Severidad: Crítico» y no sólo «Crítico». */
  rotulo: TranslationKey;
  etiqueta: TranslationKey;
  color?: string;
}

/**
 * Qué filtros están puestos ahora, para mostrarlos afuera del panel.
 *
 * Es la parte que casi todos los paneles de filtro hacen mal: esconden los
 * chips detrás del ícono y con eso esconden también **el estado**. Alguien deja
 * puesto «Severidad: Crítico», vuelve al día siguiente, ve cuarenta casos en vez
 * de cuatrocientos y no tiene forma de saber por qué sin abrir el panel.
 *
 * Un valor que no está en la lista del grupo se ignora: la URL la escribe
 * cualquiera a mano, y una marca que dijera «Tipo: meteorito» no se podría
 * sacar con un chip que no existe. Es la misma decisión que toma `page.tsx`
 * al validar contra sus listas antes de consultar.
 */
export function filtrosPuestos(
  leer: (param: string) => string | null
): FiltroPuesto[] {
  const puestos: FiltroPuesto[] = [];

  for (const grupo of GRUPOS_DE_FILTRO) {
    const valor = leer(grupo.param);
    if (!valor) continue;

    const opcion = grupo.opciones.find((o) => o.clave === valor);
    if (!opcion) continue;

    puestos.push({
      param: grupo.param,
      rotulo: grupo.rotulo,
      etiqueta: opcion.etiqueta,
      color: opcion.color,
    });
  }

  return puestos;
}
