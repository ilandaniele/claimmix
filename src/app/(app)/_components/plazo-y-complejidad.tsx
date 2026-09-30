/**
 * Las insignias del equipo para B10 y B13: cuánto falta para el vencimiento
 * del caso, qué tan complejo es y —sólo en la ficha— si la denuncia entró en
 * término. Las usan la bandeja y la ficha, y son texto con color, no píldoras:
 * en una tabla de doce columnas otra píldora más compite con el estado, que es
 * la que tiene que leerse primero.
 *
 * Nada de esto sale al asegurado: la pantalla es del equipo y los dos datos no
 * viajan por el mensaje ni por el agente.
 */
"use client";

import {
  bandaDe,
  diasAlVencimiento,
  estadoDelVencimiento,
  type BandaDeComplejidad,
  type EstadoDelVencimiento,
} from "@/core/case/vencimiento-y-banda";
import { useLocale } from "@/lib/i18n/LocaleContext";
import { formatDate } from "@/lib/utils";
import { Vacio } from "../bandeja/components/Vacio";

const COLOR_DEL_VENCIMIENTO: Record<EstadoDelVencimiento, string> = {
  vencido: "text-red-600 font-medium",
  por_vencer: "text-amber-600 font-medium",
  en_plazo: "text-slate-500",
};

const COLOR_DE_LA_BANDA: Record<BandaDeComplejidad, string> = {
  baja: "text-slate-500",
  media: "text-amber-600",
  alta: "text-red-600 font-medium",
};

/** `ahora` sólo se pasa en las pruebas: la pantalla mide contra el reloj del navegador. */
export function InsigniaDeVencimiento({ vence, ahora }: { vence: string | null; ahora?: Date }) {
  const { t, locale } = useLocale();
  const instante = ahora ?? new Date();
  const estado = estadoDelVencimiento(vence, instante);
  const dias = diasAlVencimiento(vence, instante);
  if (vence === null || estado === null || dias === null) return <Vacio />;

  // El `{n}` va por reemplazo y no concatenado: el orden de la frase cambia entre idiomas.
  const texto =
    dias < 0
      ? t("vencimiento.hace").replace("{n}", String(-dias))
      : dias === 0
        ? t("vencimiento.hoy")
        : t("vencimiento.en").replace("{n}", String(dias));

  return (
    <span
      className={`text-xs whitespace-nowrap ${COLOR_DEL_VENCIMIENTO[estado]}`}
      title={formatDate(vence, locale, { hour: undefined, minute: undefined })}
    >
      {texto}
    </span>
  );
}

export function InsigniaDeComplejidad({ puntaje }: { puntaje: number | null }) {
  const { t } = useLocale();
  const banda = bandaDe(puntaje);
  if (puntaje === null || banda === null) return <Vacio />;
  return (
    <span
      className={`text-xs whitespace-nowrap ${COLOR_DE_LA_BANDA[banda]}`}
      title={t("complejidad.puntaje").replace("{n}", String(puntaje))}
    >
      {t(`complejidad.${banda}`)} {puntaje}
    </span>
  );
}

/**
 * Si el asegurado denunció dentro de los 3 días del art. 46 (B10). Sin una
 * fecha del hecho que sirva no hay opinión: `resultado` llega `null` y no se
 * pinta nada, en vez de un «en término» que nadie comprobó.
 */
export function InsigniaDeDenuncia({ resultado }: { resultado: { enTermino: boolean; dias: number } | null }) {
  const { t } = useLocale();
  if (resultado === null) return null;
  return (
    <span
      className={`text-xs whitespace-nowrap ${resultado.enTermino ? "text-slate-500" : "text-red-600 font-medium"}`}
      title={t("denuncia.ayuda")}
    >
      {t(resultado.enTermino ? "denuncia.enTermino" : "denuncia.fueraDeTermino").replace("{n}", String(resultado.dias))}
    </span>
  );
}
