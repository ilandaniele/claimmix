/**
 * El vocabulario visual del tablero.
 *
 * Cinco piezas, y con eso se arma todo: la tarjeta de sección, su encabezado con
 * acciones a la derecha, la baldosa de indicador, la píldora de estado y el
 * campo con la etiqueta arriba del valor.
 *
 * ── Dos reglas que no son de estilo ─────────────────────────────────────────
 *
 * 1. NADA de `style=`. La CSP de este producto no lleva `unsafe-inline` en
 *    `style-src` desde que se sacaron las barras de progreso, así que un
 *    atributo `style` queda en el DOM y NO se aplica: silencioso y equivocado.
 *    Todo sale de clases literales de Tailwind o de `globals.css`.
 *
 * 2. Las clases se escriben ENTERAS, nunca armadas con plantilla. Tailwind
 *    compila lo que encuentra escrito en el código; un `text-${tono}-600` no
 *    existiría en la hoja de estilos y el color no se aplicaría.
 *
 * ── Por qué el modo oscuro casi no aparece acá ──────────────────────────────
 *
 * Porque `globals.css` lo resuelve pisando las utilidades de Tailwind
 * (`bg-white`, `border-slate-200`, `shadow-sm`) con `!important`. Usando esas
 * mismas utilidades, el modo oscuro sale gratis. Lo que cambia el aspecto —el
 * radio, el aire, el degradado del fondo— es justamente lo que no necesita
 * variante oscura.
 */

import type { ReactNode } from "react";

/**
 * La tarjeta de sección: el bloque que se repite en todo el tablero.
 *
 * Radio grande y sombra apenas perceptible. La sombra hace el trabajo que antes
 * hacía el borde: separar del fondo sin dibujar una línea.
 */
export function Card({
  children,
  className = "",
}: {
  children: ReactNode;
  className?: string;
}) {
  return (
    <section
      className={`rounded-2xl border border-slate-200 bg-white shadow-sm ${className}`}
    >
      {children}
    </section>
  );
}

/**
 * El encabezado de una sección: título a la izquierda, acciones a la derecha.
 *
 * Es la forma que más se repite en el diseño de referencia, y no es
 * decorativa: pone la acción al lado de lo que modifica, en vez de mandarla a
 * una barra de herramientas lejos del contenido.
 */
export function CardHeader({
  title,
  children,
}: {
  title: ReactNode;
  /** Los botones de la derecha. Se pasan tal cual: acá no se decide cuáles. */
  children?: ReactNode;
}) {
  return (
    <div className="flex flex-wrap items-center justify-between gap-3 px-5 pt-4 pb-3">
      {/*
        * `min-w-0` + `truncate`: sin eso, un título largo empuja los botones
        * fuera de la tarjeta. Un hijo de flex no se encoge por debajo de su
        * contenido salvo que se le diga.
        *
        * `flex-wrap` en los dos niveles: con tres botones y una ventana
        * angosta, la fila no daba y los botones se salían de la tarjeta o se
        * amontonaban desparejos. Ahora bajan a una segunda línea, alineados a
        * la derecha.
        *
        * `text-balance` reparte el título en líneas parejas en vez de dejar una
        * palabra huérfana abajo.
        */}
      <h2 className="min-w-0 truncate text-balance text-[15px] font-semibold tracking-tight text-slate-900">
        {title}
      </h2>
      {children ? (
        <div className="flex flex-wrap items-center justify-end gap-2">{children}</div>
      ) : null}
    </div>
  );
}

/**
 * Una baldosa de indicador: rótulo chico, número grande, y una línea de abajo
 * opcional para el contexto.
 *
 * El número va con `cifra`, que fija ancho tabular: en un tablero de siniestros
 * los números están para compararse entre sí, y con cifras de ancho variable las
 * columnas bailan.
 */
export function KpiTile({
  label,
  value,
  hint,
  tone = "neutro",
}: {
  label: string;
  value: ReactNode;
  hint?: ReactNode;
  /** El color dice qué tan urgente es, no qué tan lindo queda. */
  tone?: "neutro" | "critico" | "espera" | "listo";
}) {
  // Escritas enteras: Tailwind no compila una clase armada con plantilla.
  const tonos = {
    neutro: "text-slate-900",
    critico: "text-red-700",
    espera: "text-amber-700",
    listo: "text-emerald-700",
  } as const;

  return (
    <div className="rounded-2xl border border-slate-200 bg-white px-5 py-4 shadow-sm">
      <p className="rotulo text-slate-500">{label}</p>
      <p className={`cifra mt-2 text-[28px] font-semibold leading-none ${tonos[tone]}`}>
        {value}
      </p>
      {hint ? <p className="mt-2 text-[12px] text-slate-500">{hint}</p> : null}
    </div>
  );
}

/**
 * La píldora de estado.
 *
 * Es la pieza que más trabaja en un producto de siniestros: lo único que una
 * persona necesita ver de un vistazo es qué casos la están esperando. Por eso el
 * color acá NO es el violeta de la marca — el acento identifica al producto, el
 * estado tiene que distinguirse de él.
 */
export function Pill({
  children,
  tone = "neutro",
}: {
  children: ReactNode;
  tone?: "neutro" | "acento" | "critico" | "espera" | "listo";
}) {
  const tonos = {
    neutro: "bg-slate-100 text-slate-700",
    acento: "bg-violet-50 text-violet-700",
    critico: "bg-red-50 text-red-700",
    espera: "bg-amber-50 text-amber-700",
    listo: "bg-emerald-50 text-emerald-700",
  } as const;

  return (
    <span
      className={`inline-flex items-center rounded-full px-2.5 py-0.5 text-[12px] font-medium ${tonos[tone]}`}
    >
      {children}
    </span>
  );
}

/**
 * Un dato, con su etiqueta arriba.
 *
 * La etiqueta va chica y en mayúsculas (`rotulo`) para que se lea como rótulo y
 * no compita con el valor, que es lo que la persona vino a leer. Es la grilla
 * que estructura toda la pantalla de detalle.
 *
 * ── Va ADENTRO de un `<dl>` ─────────────────────────────────────────────────
 *
 * Sale `<div><dt>…</dt><dd>…</dd></div>`, no tres `<div>`. El detalle de un caso
 * es literalmente una lista de pares término-descripción, y así se anuncia:
 * un lector de pantalla dice «Póliza, ABC-123» en vez de leer dos textos
 * sueltos y dejar que la persona adivine cuál describe a cuál.
 *
 * El `<div>` de envoltura entre el `<dl>` y el par es HTML5 válido, y es lo que
 * permite que cada par sea una celda de la grilla.
 *
 * Quien use esto tiene que poner un `<dl>` alrededor: un `<dt>` suelto fuera de
 * una lista de definiciones no es válido y pierde justamente la relación que es
 * la razón de existir del componente.
 */
export function Field({
  label,
  children,
}: {
  label: string;
  children: ReactNode;
}) {
  return (
    <div className="min-w-0">
      <dt className="rotulo text-slate-500">{label}</dt>
      {/*
        * `?? "—"` no alcanzaba: `null` y `undefined` los tapa, pero el caso que
        * de verdad pasa es un string vacío, y `"" ?? "—"` es `""` — o sea una
        * fila con etiqueta y nada debajo, que se lee como un error de carga.
        */}
      <dd className="mt-1 break-words text-[14px] text-slate-900">
        {children === null || children === undefined || children === "" ? (
          <span className="text-slate-300">—</span>
        ) : (
          children
        )}
      </dd>
    </div>
  );
}

/**
 * La grilla que contiene los `Field`.
 *
 * Existe para que el `<dl>` no se olvide: sin él los `<dt>`/`<dd>` quedan
 * huérfanos y el HTML es inválido. Acá está escrito una sola vez.
 */
export function FieldGrid({
  children,
  className = "sm:grid-cols-2",
}: {
  children: ReactNode;
  className?: string;
}) {
  return <dl className={`grid grid-cols-1 gap-x-6 gap-y-4 ${className}`}>{children}</dl>;
}
