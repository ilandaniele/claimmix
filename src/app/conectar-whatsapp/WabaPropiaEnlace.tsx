import type { TranslationKey } from "@/lib/i18n";
import { appPropia } from "@/server/alta/waba-propia-activa";
import { enlaceDeAyuda, leerWabaPublica, type WabaPublica } from "@/server/alta/waba-publica";

import { resumenDeVista, vistaInicial, type ResumenDeVista } from "./vista";

const APP = "/conectar-whatsapp/app";

/**
 * Cómo viene la conexión con la app propia. Su fila no pasa por el popup: `armando` y `suscripta`
 * son pasos de la persona (crear la app, pegar el token), así que `vistaInicial` los leería como «nada empezado».
 */
function resumenDeApp(w: WabaPublica | null): ResumenDeVista {
  if (w?.origen !== "app_propia") return "nuevo";
  if (w.estado === "falla") return "falla";
  return w.estado === "conectada" || w.numero === "conectado" || w.numero === "suspendido" ? "conectado" : "enCurso";
}

/**
 * El camino a /conectar-whatsapp (o a /conectar-whatsapp/app) desde /preparando y /configuracion, para el
 * espacio al que le toca la WABA propia o la app propia (`metodoDelEspacio`). Dice en una línea cómo viene
 * la conexión y lleva a la pantalla que la termina; el popup de Meta no se abre desde acá porque esa ruta
 * es la única donde la CSP deja cargar el SDK.
 *
 * Los enlaces son `<a>` y no `<Link>`: la CSP que deja cargar el SDK de Meta se arma por pedido y sólo
 * para esa ruta (`proxy.ts`), y una navegación del lado del cliente conserva la del documento anterior,
 * que no lo permite. Hace falta una carga completa.
 *
 * Con el popup, y si la app propia está prendida y todavía no empezó nada, suma el enlace avanzado a
 * la app propia: es la salida de quien no puede usar Facebook Login.
 *
 * La lectura (`leerWabaPublica`, sin secretos) la trae quien ya la hizo para elegir el
 * camino; sin ella, la hace acá. Si no contesta, el enlace sigue siendo el de empezar.
 */
export async function WabaPropiaEnlace({
  tenantId,
  t,
  waba,
  metodo = "propia",
}: {
  tenantId: string;
  t: (clave: TranslationKey) => string;
  waba?: WabaPublica | null;
  metodo?: "propia" | "app";
}) {
  const w = waba === undefined ? await leerWabaPublica(tenantId) : waba;
  const deApp = metodo === "app";
  const resumen = deApp ? resumenDeApp(w) : resumenDeVista(vistaInicial(w).vista);
  const ayuda =
    resumen === "falla"
      ? enlaceDeAyuda(t, {
          tenantId,
          wabaId: w?.wabaId ?? null,
          ...(deApp ? { asunto: t("waba.ayuda.asuntoApp").replace("{empresa}", w?.nombre ?? "") } : {}),
        })
      : null;
  const avanzado = !deApp && !w?.origen && appPropia();
  return (
    <div className="mt-4 space-y-3 border-t border-slate-100 pt-4">
      <p role="status" className="text-xs text-slate-600">
        {deApp ? t(`enlaceWaba.app.estado.${resumen}`) : t(`enlaceWaba.estado.${resumen}`)}
      </p>
      <a
        href={deApp ? APP : "/conectar-whatsapp"}
        className="inline-block rounded-full bg-violet-600 px-4 py-2 text-xs font-semibold text-white shadow-sm transition hover:bg-violet-700 focus-visible:outline-none focus-visible:ring-4 focus-visible:ring-violet-500/30"
      >
        {deApp ? t(`enlaceWaba.app.boton.${resumen}`) : t(`enlaceWaba.boton.${resumen}`)}
      </a>
      {avanzado && (
        <p>
          <a
            href={APP}
            className="rounded text-xs font-medium text-slate-700 underline underline-offset-4 hover:text-slate-900 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-violet-500"
          >
            {t("appPropia.enlaceAvanzado")}
          </a>
        </p>
      )}
      {ayuda && (
        <p>
          <a
            href={ayuda}
            className="rounded text-xs font-medium text-slate-700 underline underline-offset-4 hover:text-slate-900 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-violet-500"
          >
            {t("waba.ayuda")}
          </a>
        </p>
      )}
    </div>
  );
}
