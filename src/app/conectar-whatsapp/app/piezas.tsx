/**
 * Las piezas que repiten los pasos y las ventanas del asistente de «app propia»: copiar un
 * dato, pegar un secreto, un cartel, el encabezado con «Paso n de 4», la ayuda y el pie.
 *
 * Los textos salen del diccionario y los colores que `globals.css` no remapea al modo
 * oscuro (los carteles) llevan su variante `dark:` a mano.
 */

"use client";

import { useEffect, useId, useRef, useState, type ReactNode } from "react";

import { useT } from "@/lib/i18n/LocaleContext";
import type { ResultadoDeApp } from "@/server/alta/waba-resultados";

import { BOTON_SUAVE, CAMPO, ENLACE, SIGUE_EN } from "../WabaPropiaPanel";
import { claveDelResultado, correoDeAyuda, NUMERO_DE_PASO, rellenar, type Aviso, type Extras, type Pantalla, type Ventana } from "./vista";

export const META_APPS = "https://developers.facebook.com/apps/";
export const META_GUIA = "https://developers.facebook.com/docs/whatsapp/cloud-api/get-started";
// El enlace profundo a «System users» no está verificado (I32): se abre la configuración del negocio.
export const META_USUARIOS = "https://business.facebook.com/latest/settings";
export const META_GUIA_NUMEROS = "https://developers.facebook.com/documentation/business-messaging/whatsapp/business-phone-numbers/phone-numbers";
export const META_GUIA_USUARIO = "https://developers.facebook.com/docs/business-management-apis/system-users/install-apps-and-generate-tokens";
export const META_GUIA_WEBHOOK = "https://developers.facebook.com/documentation/business-messaging/whatsapp/webhooks/create-webhook-endpoint";

const TONOS = {
  aviso: "bg-amber-50 text-amber-900 dark:bg-amber-950/40 dark:text-amber-300",
  error: "bg-red-50 text-red-800 dark:bg-red-950/40 dark:text-red-300",
  ok: "bg-green-50 text-green-800 dark:bg-green-950/40 dark:text-green-300",
} as const;

export function Banner({ tono = "aviso", rol = "alert", children }: { tono?: keyof typeof TONOS; rol?: "alert" | "status"; children: ReactNode }) {
  return (
    <div role={rol} className={`mt-4 rounded-lg px-3 py-2 text-sm ${TONOS[tono]}`}>
      {children}
    </div>
  );
}

/** Lo que el servidor contestó, con su texto del diccionario. Un resultado informativo (no una falla) va como estado. */
export function AvisoDeResultado({ aviso, appId }: { aviso: Aviso | null; appId?: string | null }) {
  const t = useT();
  if (!aviso) return null;
  const texto = rellenar(t(claveDelResultado(aviso.resultado)), {
    appId: appId ?? "",
    permiso: aviso.permiso ?? "",
    permisos: aviso.permisos?.join(", ") ?? "",
  });
  const informativo = aviso.resultado === "codigo_enviado" || aviso.resultado === "nombre_pendiente";
  return (
    <Banner tono={informativo ? "ok" : "aviso"} rol={informativo ? "status" : "alert"}>
      {texto}
    </Banner>
  );
}

/** «Paso n de 4» y la barra de avance. Las pantallas que no son un paso (P0, G) no llevan nada. */
export function Encabezado({ pantalla, titulo }: { pantalla: Pantalla; titulo: string }) {
  const t = useT();
  const n = NUMERO_DE_PASO[pantalla];
  return (
    <header className="mb-4">
      {n && (
        <>
          <p className="text-xs font-semibold uppercase tracking-wide text-violet-600">{t("appPropia.paso").replace("{n}", String(n))}</p>
          <div className="mt-2 flex gap-1" aria-hidden="true">
            {[1, 2, 3, 4].map((i) => (
              <span key={i} className={`h-1 flex-1 rounded-full ${i <= n ? "bg-violet-600" : "bg-slate-200"}`} />
            ))}
          </div>
        </>
      )}
      <h2 className="mt-3 text-lg font-semibold text-slate-900">{titulo}</h2>
    </header>
  );
}

export function Bloque({ titulo, children }: { titulo: string; children: ReactNode }) {
  return (
    <section className="mt-5">
      <h3 className="text-sm font-semibold text-slate-900">{titulo}</h3>
      {children}
    </section>
  );
}

/** Los pasos de una tarea (numerados) o los puntos de una lista; un ítem puede llevar un campo para copiar adentro. */
export function Lista({ items, numerada = true }: { items: ReactNode[]; numerada?: boolean }) {
  const Etiqueta = numerada ? "ol" : "ul";
  return (
    <Etiqueta className={`mt-2 space-y-1.5 pl-5 text-sm text-slate-600 ${numerada ? "list-decimal" : "list-disc"}`}>
      {items.map((item, i) => (
        <li key={i}>{item}</li>
      ))}
    </Etiqueta>
  );
}

export const Parrafo = ({ children }: { children: ReactNode }) => <p className="mt-2 text-sm text-slate-600">{children}</p>;

/** Un enlace que sale de ClaimMix (a Meta): pestaña nueva y sin que la otra página sepa de dónde vino. */
export function EnlaceMeta({ href, children }: { href: string; children: ReactNode }) {
  return (
    <a href={href} target="_blank" rel="noopener noreferrer" className={`${BOTON_SUAVE} mt-3 block`}>
      {children}
    </a>
  );
}

/** El enlace a la guía de Meta de un paso. */
export function Guia({ href }: { href: string }) {
  const t = useT();
  return (
    <a href={href} target="_blank" rel="noopener noreferrer" className={`${ENLACE} mt-2 inline-block`}>
      {t("appPropia.verGuia")}
    </a>
  );
}

/** Copia al portapapeles y avisa dos segundos. Sin permiso del navegador no pasa nada: el dato sigue a la vista. */
function BotonCopiar({ valor, descripcion }: { valor: string; descripcion: string }) {
  const t = useT();
  const [copiado, setCopiado] = useState(false);
  const reloj = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
  useEffect(() => () => clearTimeout(reloj.current), []);

  async function copiar() {
    try {
      await navigator.clipboard.writeText(valor);
    } catch {
      return;
    }
    setCopiado(true);
    clearTimeout(reloj.current);
    reloj.current = setTimeout(() => setCopiado(false), 2000);
  }

  return (
    <button
      type="button"
      onClick={() => void copiar()}
      aria-label={`${t("appPropia.copiar")}: ${descripcion}`}
      className="shrink-0 rounded-lg border border-slate-300 bg-white px-3 py-2 text-sm font-medium text-slate-700 transition hover:bg-slate-50 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-violet-500 dark:border-slate-600"
    >
      {copiado ? t("appPropia.copiado") : t("appPropia.copiar")}
    </button>
  );
}

/** Un dato para pegar en Meta: se ve entero y se copia con un toque. */
export function Copiable({ etiqueta, valor }: { etiqueta: string; valor: string }) {
  const id = useId();
  return (
    <div className="mt-3">
      <label htmlFor={id} className="mb-1 block text-xs font-medium text-slate-600">
        {etiqueta}
      </label>
      <div className="flex gap-2">
        <input
          id={id}
          readOnly
          value={valor}
          onFocus={(e) => e.currentTarget.select()}
          className={`${CAMPO} min-w-0 font-mono text-xs`}
        />
        <BotonCopiar valor={valor} descripcion={etiqueta} />
      </div>
    </div>
  );
}

/** Un campo para pegar un secreto: no se muestra, no se autocompleta ni se corrige, y el navegador no lo recuerda. */
export function CampoSecreto({
  etiqueta,
  valor,
  alCambiar,
  maxLength,
  invalido,
}: {
  etiqueta: string;
  valor: string;
  alCambiar: (valor: string) => void;
  maxLength: number;
  invalido?: boolean;
}) {
  const id = useId();
  return (
    <div className="mt-3">
      <label htmlFor={id} className="mb-1.5 block text-sm font-medium text-slate-700">
        {etiqueta}
      </label>
      <input
        id={id}
        type="password"
        autoComplete="off"
        spellCheck={false}
        autoCapitalize="none"
        maxLength={maxLength}
        value={valor}
        aria-invalid={invalido || undefined}
        onChange={(e) => alCambiar(e.target.value)}
        className={CAMPO}
      />
    </div>
  );
}

/** Un campo de texto común del asistente. */
export function CampoDeTexto({
  etiqueta,
  valor,
  alCambiar,
  maxLength,
  inputMode,
  autoComplete,
  invalido,
  ayuda,
}: {
  etiqueta: string;
  valor: string;
  alCambiar: (valor: string) => void;
  maxLength: number;
  inputMode?: "numeric" | "tel" | "text";
  autoComplete?: string;
  invalido?: boolean;
  ayuda?: string;
}) {
  const id = useId();
  const idAyuda = useId();
  return (
    <div className="mt-3">
      <label htmlFor={id} className="mb-1.5 block text-sm font-medium text-slate-700">
        {etiqueta}
      </label>
      <input
        id={id}
        type="text"
        inputMode={inputMode}
        autoComplete={autoComplete ?? "off"}
        maxLength={maxLength}
        value={valor}
        aria-invalid={invalido || undefined}
        aria-describedby={ayuda ? idAyuda : undefined}
        onChange={(e) => alCambiar(e.target.value)}
        className={CAMPO}
      />
      {ayuda && (
        <p id={idAyuda} className="mt-1.5 text-xs text-slate-500">
          {ayuda}
        </p>
      )}
    </div>
  );
}

/** La ayuda humana: el mail a la vista (por si no hay programa de correo), para copiar, y la oferta de hacerlo juntos. */
export function Ayuda({ ayuda }: { ayuda: string | null }) {
  const t = useT();
  const correo = correoDeAyuda(ayuda);
  if (!ayuda || !correo) return null;
  return (
    <div className="mt-6 rounded-lg border border-slate-200 p-3 text-sm text-slate-600">
      <p>{t("appPropia.ayuda.videollamada")}</p>
      <p className="mt-2 flex flex-wrap items-center gap-2">
        <span className="min-w-0 break-all">{t("appPropia.ayuda.mail").replace("{mail}", correo)}</span>
        <BotonCopiar valor={correo} descripcion={correo} />
      </p>
      <a href={ayuda} className={`${ENLACE} mt-2 inline-block`}>
        {t("appPropia.ayuda.escribir")}
      </a>
    </div>
  );
}

/**
 * «Lo sigo después»: sale al resto del producto; lo hecho queda guardado. Es un `<a>` y no un `<Link>` por la CSP de esta ruta.
 * Mientras la app se está armando también ofrece empezar de nuevo, que es la única salida de esta vía sin pedir soporte.
 */
export function Pie({ control }: { control: ControlDelPanel }) {
  const t = useT();
  return (
    <>
      <Ayuda ayuda={control.ayuda} />
      <div className="mt-5 flex flex-col items-center gap-1 text-center">
        <a href={SIGUE_EN} className={ENLACE}>
          {t("appPropia.despues")}
        </a>
        <p className="text-xs text-slate-500">{t("appPropia.despuesAviso")}</p>
        {control.pedirCancelar && (
          <button type="button" disabled={control.ocupado} className={`${ENLACE} mt-3`} onClick={control.pedirCancelar}>
            {t("appPropia.cancelar.boton")}
          </button>
        )}
      </div>
    </>
  );
}

/** Corre `accion` cada `ms` mientras `activo`; usa siempre la última versión de la función. */
export function useCada(accion: () => void, ms: number, activo: boolean) {
  const ultima = useRef(accion);
  useEffect(() => {
    ultima.current = accion;
  });
  useEffect(() => {
    if (!activo) return;
    const reloj = setInterval(() => ultima.current(), ms);
    return () => clearInterval(reloj);
  }, [ms, activo]);
}

/** Lo que el panel le da a cada paso y a cada ventana: el estado de la espera y las formas de hablar con el servidor. */
export interface ControlDelPanel {
  ocupado: boolean;
  aviso: Aviso | null;
  /** `mailto:` de ayuda; null si no hay dirección cargada. */
  ayuda: string | null;
  /** Corre una acción del servidor: el panel muestra lo que contestó (ventana, cartel o página nueva) y devuelve el resultado. */
  correr: (accion: () => Promise<{ resultado: ResultadoDeApp } & Extras>) => Promise<ResultadoDeApp>;
  abrir: (ventana: Ventana) => void;
  cerrar: () => void;
  /** Abre la confirmación de desconectar. */
  pedirBaja: () => void;
  /** Abre la confirmación de empezar de nuevo; sólo está mientras la fila se está armando. */
  pedirCancelar?: () => void;
}

/**
 * Consulta cada `cada` ms durante `hasta` ms desde que arranca (o desde `reiniciar`). Pasado ese tiempo
 * `agotado` es true y deja de consultar. Cuenta con el reloj y no con las vueltas: una pestaña de fondo
 * puede atrasar los intervalos.
 */
export function useSondeo(consultar: () => Promise<void>, cada: number, hasta: number, activo: boolean) {
  const [transcurrido, setTranscurrido] = useState(0);
  const inicio = useRef(0);
  const enVuelo = useRef(false);
  useEffect(() => {
    inicio.current = Date.now();
  }, []);

  async function vuelta() {
    if (enVuelo.current) return;
    enVuelo.current = true;
    try {
      await consultar();
    } catch {
      // Una consulta que falla se vuelve a intentar en la vuelta que sigue.
    } finally {
      enVuelo.current = false;
    }
    setTranscurrido(Date.now() - inicio.current);
  }

  const agotado = transcurrido >= hasta;
  useCada(() => void vuelta(), cada, activo && !agotado);
  return {
    transcurrido,
    agotado,
    reiniciar: () => {
      inicio.current = Date.now();
      setTranscurrido(0);
    },
  };
}
