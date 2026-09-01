"use client";

import type { CaseStatus } from "@/lib/schemas/cases";
import { useT } from "@/lib/i18n/LocaleContext";

interface StatusBadgeProps {
  status: CaseStatus;
}

/**
 * Trece estados, cinco colores.
 *
 * Antes cada estado tenía su propio matiz —verde, amarillo, rojo, azul, celeste,
 * ámbar, naranja, rosa, esmeralda, verde azulado— y una columna con trece
 * colores no informa nada: hay que leer la palabra igual, y mientras tanto la
 * tabla entera parece un semáforo roto.
 *
 * Ahora el color responde UNA pregunta, que es la única que se hace alguien
 * mirando la bandeja: ¿esto me está esperando a mí?
 *
 *   rojo      → alguien tiene que actuar ahora
 *   ámbar     → esperando al denunciante
 *   violeta   → el sistema está trabajando
 *   esmeralda → salió bien
 *   gris      → terminado, no requiere nada
 *
 * La palabra sigue distinguiendo los trece; el color agrupa los cinco. Y son
 * los mismos cinco tonos de `Pill`, así que el detalle del caso y la bandeja
 * dicen lo mismo con la misma pintura.
 *
 * Nota para quien toque esto: los tonos elegidos son los que `globals.css` ya
 * pisa en modo oscuro. Sumar un matiz nuevo (teal, sky, rose) obliga a sumar su
 * override o el badge queda ilegible sobre fondo oscuro — y eso no se nota
 * leyendo el diff.
 */
const STATUS_CLASSES: Record<CaseStatus, string> = {
  // Alguien tiene que actuar.
  escalado: "bg-red-50 text-red-700",
  requiere_especialista: "bg-red-50 text-red-700",
  error_core: "bg-red-50 text-red-700",
  // Esperando una respuesta de afuera.
  esperando: "bg-amber-50 text-amber-700",
  info_faltante: "bg-amber-50 text-amber-700",
  confirmacion_pendiente: "bg-amber-50 text-amber-700",
  // En vuelo: el sistema todavía está haciendo algo.
  recibido: "bg-violet-50 text-violet-700",
  procesando: "bg-violet-50 text-violet-700",
  // Salió bien.
  listo: "bg-emerald-50 text-emerald-700",
  listo_para_core: "bg-emerald-50 text-emerald-700",
  // Terminado. No hay nada que hacer.
  enviado_a_core: "bg-slate-100 text-slate-700",
  cerrado: "bg-slate-100 text-slate-700",
  no_relevante: "bg-slate-100 text-slate-700",
};

export function StatusBadge({ status }: StatusBadgeProps) {
  const t = useT();
  const classes = STATUS_CLASSES[status] ?? "bg-slate-100 text-slate-700";

  const STATUS_LABELS: Record<CaseStatus, string> = {
    listo: t("status.listo"),
    esperando: t("status.esperando"),
    escalado: t("status.escalado"),
    cerrado: t("status.cerrado"),
    procesando: t("status.procesando"),
    recibido: t("status.recibido"),
    info_faltante: t("status.info_faltante"),
    confirmacion_pendiente: t("status.confirmacion_pendiente"),
    requiere_especialista: t("status.requiere_especialista"),
    listo_para_core: t("status.listo_para_core"),
    enviado_a_core: t("status.enviado_a_core"),
    error_core: t("status.error_core"),
    no_relevante: t("status.no_relevante"),
  };

  const label = STATUS_LABELS[status] ?? status;

  return (
    <span
      /*
       * `whitespace-nowrap`: sin esto «Confirmación pendiente» se parte en dos
       * líneas dentro de la píldora y la fila de la tabla crece al doble.
       */
      className={`inline-flex items-center whitespace-nowrap rounded-full px-2.5 py-0.5 text-[12px] font-medium ${classes}`}
      data-status={status}
    >
      {label}
    </span>
  );
}
