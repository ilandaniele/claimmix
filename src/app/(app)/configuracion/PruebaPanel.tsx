import type { TranslationKey } from "@/lib/i18n";

import type { PruebaDelEspacio } from "./para-admin";

type Traducir = (clave: TranslationKey) => string;

interface Props {
  prueba: PruebaDelEspacio;
  t: Traducir;
  /** El número por código está prendido y puede andar en este espacio (`prueba.porCodigo`): lo conecta solo, desde `NumeroPanel`. */
  automatico?: boolean;
  /** Le toca la WABA propia (`metodoDelEspacio`): lo conecta solo, con su cuenta de Meta, desde `WabaPropiaEnlace`. */
  propia?: boolean;
}

function Fila({ etiqueta, children }: { etiqueta: string; children: React.ReactNode }) {
  return (
    <div className="flex items-center gap-4 py-1.5">
      <span className="w-44 flex-none text-xs text-slate-500">{etiqueta}</span>
      <div className="text-sm text-slate-800">{children}</div>
    </div>
  );
}

/**
 * Cuánto le queda a la prueba y cómo anda el número de WhatsApp, de un espacio
 * del alta automática. Es de servidor y es sólo para leer: no hay nada que
 * editar, el número lo conecta el operador, o el propio admin desde
 * `NumeroPanel` si el número por código está prendido, o desde `WabaPropiaEnlace`
 * si le toca la WABA propia.
 *
 * Un espacio sin fila de número dice lo mismo que uno con el número pedido, así
 * nadie se entera de si el que pidió ya lo tenía otro espacio (H3).
 */
export function PruebaPanel({ prueba, t, automatico, propia }: Props) {
  const { dias, numero } = prueba;
  const ayudaDelPedido = propia
    ? "configuracion.prueba.ayuda.pedidoPropia"
    : automatico
      ? "configuracion.prueba.ayuda.pedidoAutomatico"
      : null;
  const ayuda =
    numero === "conectado"
      ? null
      : t(
          numero === "pedido" && ayudaDelPedido && dias !== 0
            ? ayudaDelPedido
            : `configuracion.prueba.ayuda.${numero}`
        );
  return (
    <div className="divide-y divide-slate-50">
      {dias !== null && (
        <Fila etiqueta={t("configuracion.prueba.etiqueta")}>
          {dias === 0
            ? t("configuracion.prueba.vencida")
            : dias === 1
              ? t("configuracion.prueba.dia")
              : t("configuracion.prueba.dias").replace("{n}", String(dias))}
        </Fila>
      )}
      <Fila etiqueta={t("configuracion.prueba.whatsapp")}>
        <span className="font-medium">{t(`configuracion.prueba.numero.${numero}`)}</span>
        {ayuda && <span className="ml-2 text-xs text-slate-500">{ayuda}</span>}
      </Fila>
    </div>
  );
}
