import type { TranslationKey } from "@/lib/i18n";

import type { PruebaDelEspacio } from "./para-admin";

type Traducir = (clave: TranslationKey) => string;

interface Props {
  prueba: PruebaDelEspacio;
  t: Traducir;
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
 * editar, el número lo conecta el operador.
 *
 * Un espacio sin fila de número dice lo mismo que uno con el número pedido, así
 * nadie se entera de si el que pidió ya lo tenía otro espacio (H3).
 */
export function PruebaPanel({ prueba, t }: Props) {
  const { dias, numero } = prueba;
  const ayuda = numero === "conectado" ? null : t(`configuracion.prueba.ayuda.${numero}`);
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
