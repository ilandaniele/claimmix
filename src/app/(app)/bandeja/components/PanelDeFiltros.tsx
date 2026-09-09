/**
 * Los filtros de la bandeja: un botón, y afuera lo que está puesto.
 *
 * ── Qué había antes ─────────────────────────────────────────────────────────
 *
 * Veinte chips, siempre, en dos filas: nueve tipos de siniestro, tres canales,
 * cinco severidades y tres de relevancia. Más las seis pestañas de estado son
 * veintiséis controles en pantalla antes de mirar un solo siniestro.
 *
 * El problema no es que ocupen lugar. Es que veinte chips apagados y uno
 * encendido se leen igual de lejos, así que la única pregunta que un filtro
 * tiene que contestar sin que lo lean —qué está puesto— había que contestarla
 * recorriendo la fila con la vista. Y como cada grupo traía su chip «Todos»
 * encendido cuando no filtraba, la fila se veía casi igual con filtros puestos
 * y sin ellos.
 *
 * ── Qué hay ahora ───────────────────────────────────────────────────────────
 *
 * Un botón «Filtros» con su ícono, y al lado UNA marca por cada filtro puesto.
 * Sin nada puesto, la franja es una línea con un botón. Con tres puestos, se
 * leen los tres sin abrir nada.
 *
 * Que las marcas vivan AFUERA del panel es lo que hace que esto no sea sólo
 * esconder controles. Un panel que se traga el estado es peor que veinte chips:
 * alguien deja «Severidad: Crítico» puesto, vuelve al otro día, ve cuarenta
 * casos en vez de cuatrocientos y no tiene de dónde agarrarse.
 *
 * ── Lo que NO entró al panel ────────────────────────────────────────────────
 *
 * Las pestañas de estado se quedan afuera y visibles. No son un filtro más:
 * llevan el contador de cada estado, así que informan sin que las toquen —
 * «Escalados 43» es trabajo pendiente— y son por donde se navega la bandeja
 * todo el día. Un filtro escondido no puede informar.
 *
 * ── El botón lleva la palabra, no sólo el ícono ─────────────────────────────
 *
 * En escritorio ninguna de las referencias usa el ícono pelado: Linear, Stripe,
 * Notion y Airtable ponen ícono MÁS palabra, y Binance colapsa a ícono solo en
 * el celular. El ícono solo es un patrón de pantalla chica; ésta es una
 * herramienta de ocho horas por día, y un ícono sin etiqueta se paga con un
 * hover para descubrirlo y con un blanco de click más chico.
 */

"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { ListFilter, X } from "lucide-react";
import { useT } from "@/lib/i18n/LocaleContext";
import { useNavegacion } from "./navegacion-pendiente";
import { useFilterParam, useLimpiarFiltros } from "./useFilterParam";
import { CHIP_BASE, claseChip } from "./chip";
import {
  GRUPOS_DE_FILTRO,
  PARAMS_DE_FILTRO,
  filtrosPuestos,
} from "./grupos-de-filtro";
import { useDialogoModal } from "../../_components/dialogo-modal";

const ID_PANEL = "panel-de-filtros";

// ── El panel que se abre ──────────────────────────────────────────────────────

/**
 * Vive en su propio componente y no en un `{abierto && (...)}` adentro del de
 * abajo porque `useDialogoModal` es un hook: tiene que correr al montarse el
 * panel y limpiar al desmontarse. Metido en el componente de afuera correría
 * siempre, incluso con el panel cerrado, y le devolvería el foco a cualquiera.
 *
 * De paso, que el manejo de Escape viva en el hook y no acá es lo que pide
 * `tests/unit/el-dialogo-y-la-fila.test.ts`: prohíbe que `e.key === "Escape"`
 * vuelva a aparecer escrito a mano en esta parte de la bandeja.
 */
function Panel({ alCerrar }: { alCerrar: () => void }) {
  const t = useT();
  /*
   * `paramsVisibles` y no `useSearchParams()`: mientras la navegación está en
   * vuelo devuelve el DESTINO. Con la URL cruda, apretar un chip no lo encendía
   * hasta que el servidor contestaba, y en el medio la pantalla se veía como si
   * el click no hubiera pasado. Es la misma razón por la que los chips viejos
   * recibían lo activo por prop desde `DashboardClient`.
   */
  const { paramsVisibles } = useNavegacion();
  const setFilter = useFilterParam();
  const limpiar = useLimpiarFiltros();

  const panelRef = useDialogoModal<HTMLDivElement>(alCerrar);
  const hayAlguno = filtrosPuestos((p) => paramsVisibles.get(p)).length > 0;

  return (
    <div
      ref={panelRef}
      id={ID_PANEL}
      role="dialog"
      aria-label={t("filter.titulo")}
      className="absolute left-5 top-full z-30 mt-1 max-h-[70vh] w-[320px] overflow-y-auto rounded-xl border border-slate-200 bg-white p-4 shadow-lg"
    >
      <div className="mb-3 flex items-center justify-between">
        <h3 className="text-[13.5px] font-semibold text-slate-900">
          {t("filter.titulo")}
        </h3>
        {/*
          * «Limpiar todo» sólo existe cuando hay algo que limpiar. Un botón que
          * no hace nada igual se aprieta, y no hacer nada se lee como que la
          * pantalla se colgó.
          */}
        {hayAlguno && (
          <button
            type="button"
            onClick={() => limpiar(PARAMS_DE_FILTRO)}
            className="rounded-md px-1.5 py-1 text-[12.5px] font-medium text-slate-500 transition-colors hover:bg-slate-100 hover:text-slate-900 focus:outline-none focus-visible:ring-2 focus-visible:ring-violet-500"
          >
            {t("filter.limpiarTodo")}
          </button>
        )}
      </div>

      <div className="space-y-3">
        {GRUPOS_DE_FILTRO.map((grupo, i) => {
          const activo = paramsVisibles.get(grupo.param);

          return (
            <div
              key={grupo.param}
              // La línea separa grupos, así que no va en el primero: ahí
              // separaría el grupo del título, que no son dos grupos.
              className={i === 0 ? undefined : "border-t border-slate-100 pt-3"}
            >
              <p className="rotulo mb-1.5 text-slate-500" id={`grupo-${grupo.param}`}>
                {t(grupo.rotulo)}
              </p>
              <div
                role="group"
                aria-labelledby={`grupo-${grupo.param}`}
                className="flex flex-wrap gap-1"
              >
                {grupo.opciones.map((opcion) => {
                  const puesto = activo === opcion.clave;

                  return (
                    <button
                      key={opcion.clave}
                      type="button"
                      aria-pressed={puesto}
                      /*
                       * Apretar el que ya está encendido lo apaga. Es la única
                       * forma de sacar un filtro desde adentro del panel ahora
                       * que no hay chip «Todos», y es también por lo que estos
                       * siguen siendo botones con `aria-pressed` y no radios:
                       * un radio no se puede desmarcar.
                       */
                      onClick={() =>
                        setFilter(grupo.param, puesto ? null : opcion.clave)
                      }
                      className={
                        puesto && opcion.color
                          ? `${CHIP_BASE} ${opcion.color} text-white`
                          : claseChip(puesto)
                      }
                    >
                      {t(opcion.etiqueta)}
                    </button>
                  );
                })}
              </div>
            </div>
          );
        })}
      </div>
    </div>
  );
}

// ── La franja entera ──────────────────────────────────────────────────────────

export function PanelDeFiltros() {
  const t = useT();
  const { paramsVisibles } = useNavegacion();
  const setFilter = useFilterParam();
  const limpiar = useLimpiarFiltros();

  const [abierto, setAbierto] = useState(false);
  const franjaRef = useRef<HTMLDivElement>(null);
  const botonRef = useRef<HTMLButtonElement>(null);

  const cerrar = useCallback(() => setAbierto(false), []);

  const puestos = filtrosPuestos((p) => paramsVisibles.get(p));

  /*
   * ── El foco cuando se saca una marca ────────────────────────────────────
   *
   * Es el error clásico de este patrón: el botón que tenía el foco deja de
   * existir, el foco se cae al `body`, y el que navega con teclado vuelve al
   * principio del documento sin haberse movido de la pantalla.
   *
   * Se guarda la posición de la que se sacó y, cuando la lista se rehace, el
   * foco va a la que ocupó ese lugar. Si era la última, al botón «Filtros»,
   * que es lo más cercano y siempre está.
   */
  const focoPendiente = useRef<number | null>(null);

  useEffect(() => {
    const i = focoPendiente.current;
    if (i === null) return;
    focoPendiente.current = null;

    const marcas =
      franjaRef.current?.querySelectorAll<HTMLElement>("[data-marca]") ?? [];
    const destino = marcas[Math.min(i, marcas.length - 1)];
    (destino ?? botonRef.current)?.focus();
  }, [puestos.length]);

  const sacar = useCallback(
    (param: string, i: number) => {
      focoPendiente.current = i;
      setFilter(param, null);
    },
    [setFilter]
  );

  /*
   * Cerrar tocando afuera. `useDialogoModal` trae Escape, la trampa de foco y
   * la devolución del foco al botón, pero no esto: los otros cuatro diálogos
   * son modales con telón y lo resuelven con un onClick en el telón. Un panel
   * anclado no tiene telón —el resto de la pantalla sigue usable— así que la
   * escucha va en el documento.
   *
   * `mousedown` y no `click`: con `click`, apretar sobre un chip del panel que
   * en el mismo gesto desaparece deja el evento sin destino, y el filtro no se
   * aplica.
   */
  useEffect(() => {
    if (!abierto) return;

    function alApretarAfuera(e: MouseEvent) {
      if (!franjaRef.current?.contains(e.target as Node)) setAbierto(false);
    }

    document.addEventListener("mousedown", alApretarAfuera);
    return () => document.removeEventListener("mousedown", alApretarAfuera);
  }, [abierto]);

  return (
    <div
      ref={franjaRef}
      className="relative flex flex-wrap items-center gap-2 border-b border-slate-100 px-5 py-2.5"
    >
      {/*
        * El botón cambia de aspecto cuando hay filtros puestos, no sólo de
        * contador: con el borde violeta se ve de lejos que la lista está
        * recortada. Un puntito no alcanza —no dice cuántos ni cuáles— y por eso
        * la señal de verdad son las marcas de al lado; esto es el refuerzo.
        *
        * No cambia de tamaño al encenderse: si el botón creciera, las marcas se
        * correrían de lugar cada vez que se pone o se saca un filtro.
        */}
      <button
        ref={botonRef}
        type="button"
        onClick={() => setAbierto((v) => !v)}
        aria-expanded={abierto}
        aria-haspopup="dialog"
        aria-controls={ID_PANEL}
        data-testid="filtros-boton"
        className={[
          "inline-flex flex-shrink-0 items-center gap-1.5 rounded-lg border px-2.5 py-1.5 text-[13px] font-medium transition-colors focus:outline-none focus-visible:ring-2 focus-visible:ring-violet-500",
          puestos.length > 0
            ? "border-violet-200 bg-violet-50 text-violet-700 hover:bg-violet-100"
            : "border-slate-200 text-slate-600 hover:bg-slate-50 hover:text-slate-900",
        ].join(" ")}
      >
        <ListFilter size={15} aria-hidden="true" />
        {t("filter.titulo")}
        {puestos.length > 0 && (
          <>
            <span
              aria-hidden="true"
              className="cifra ml-0.5 rounded-full bg-violet-600 px-1.5 py-0.5 text-[11px] font-semibold text-white"
            >
              {puestos.length}
            </span>
            {/*
              * El número solo se lee «Filtros 3», que no dice de qué. Acá va el
              * detalle, que además evita el problema del plural en dos idiomas.
              */}
            <span className="sr-only">
              {puestos
                .map((f) => `${t(f.rotulo)}: ${t(f.etiqueta)}`)
                .join(", ")}
            </span>
          </>
        )}
      </button>

      {/*
        * Las marcas de lo que está puesto.
        *
        * Cada una es UN botón, no una marca con una cruz anidada adentro: dos
        * elementos interactivos uno dentro del otro es ambiguo para el teclado y
        * para el lector. Acá la marca entera saca ese filtro, y editar es abrir
        * el panel.
        *
        * Llevan el nombre del grupo adelante («Severidad: Crítico») y no sólo el
        * valor: sueltos, «Crítico» y «Email» son dos palabras que no dicen de
        * qué campo salieron.
        */}
      {puestos.map((f, i) => (
        <button
          key={f.param}
          type="button"
          data-marca={f.param}
          onClick={() => sacar(f.param, i)}
          aria-label={`${t("filter.quitar")} ${t(f.rotulo)}: ${t(f.etiqueta)}`}
          className="group inline-flex flex-shrink-0 items-center gap-1.5 rounded-full border border-slate-200 bg-white py-1 pl-2.5 pr-2 text-[12.5px] font-medium text-slate-700 transition-colors hover:bg-slate-50 focus:outline-none focus-visible:ring-2 focus-visible:ring-violet-500"
        >
          {/*
            * El punto de color de la severidad. Adentro del panel el nivel se ve
            * porque el chip se pinta entero; acá afuera, sin el punto, «Alto» y
            * «Crítico» son dos palabras del mismo gris.
            */}
          {f.color && (
            <span
              aria-hidden="true"
              className={`h-1.5 w-1.5 flex-shrink-0 rounded-full ${f.color}`}
            />
          )}
          <span aria-hidden="true">
            {t(f.rotulo)}: {t(f.etiqueta)}
          </span>
          <X
            size={12}
            aria-hidden="true"
            className="text-slate-400 transition-colors group-hover:text-slate-700"
          />
        </button>
      ))}

      {/*
        * Sacarlas de a una sirve para corregir; «Limpiar» sirve para volver a
        * empezar, que con tres o cuatro puestas son tres o cuatro clicks y otras
        * tantas consultas. Con una sola marca no aporta nada: la marca ya se
        * saca de un click.
        */}
      {puestos.length > 1 && (
        <button
          type="button"
          onClick={() => {
            limpiar(PARAMS_DE_FILTRO);
            // El propio «Limpiar» desaparece al usarse: sin esto el foco se cae
            // al body, igual que al sacar la última marca.
            botonRef.current?.focus();
          }}
          className="rounded-md px-2 py-1 text-[12.5px] font-medium text-slate-500 transition-colors hover:bg-slate-100 hover:text-slate-900 focus:outline-none focus-visible:ring-2 focus-visible:ring-violet-500"
        >
          {t("filter.limpiar")}
        </button>
      )}

      {abierto && <Panel alCerrar={cerrar} />}
    </div>
  );
}
