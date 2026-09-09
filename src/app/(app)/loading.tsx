/**
 * El esqueleto de cualquier pantalla del turno que no tenga el suyo.
 *
 * ── Por qué existe, que no es «para que se vea lindo» ───────────────────────
 *
 * Todas las pantallas de `(app)` son dinámicas: el layout lee cookies para
 * resolver la sesión y el idioma. Y en Next 16 una ruta dinámica **no se
 * precarga** salvo que tenga una frontera `loading`. La tabla de
 * `docs/01-app/02-guides/prefetching.md` lo dice con esas palabras:
 * «Dynamic page → Prefetched: No, unless loading.js» y «Server roundtrip on
 * click: Yes».
 *
 * O sea que sin este archivo pasaban dos cosas, las dos invisibles en el
 * código:
 *
 *   1. El `<Link>` de la barra lateral no adelantaba NADA. El trabajo de
 *      precarga que Next hace solo estaba apagado de hecho para las once
 *      pantallas que un analista usa todo el día.
 *
 *   2. Al hacer clic, el navegador se quedaba en la pantalla VIEJA —sin
 *      esqueleto, sin barra, sin ninguna señal— hasta que el servidor
 *      terminaba el render completo. Medido en producción, eso es entre un
 *      cuarto y medio segundo mirando algo que ya no es lo que se pidió.
 *
 * Es la traducción más directa de «la aplicación se siente lenta»: no hay
 * consulta que arregle la sensación de que el click no hizo nada.
 *
 * ── Por qué es genérico ─────────────────────────────────────────────────────
 *
 * La bandeja tiene el suyo, con la forma de su tabla. El resto de las pantallas
 * comparte la misma cáscara —un título, una bajada y una tarjeta— así que un
 * solo esqueleto las cubre a todas. Uno por pantalla sería diez archivos casi
 * iguales para ganar unos píxeles de fidelidad.
 */
export default function CargandoPantalla() {
  return (
    <div className="flex h-full flex-col" aria-hidden="true">
      <div className="px-6 pb-5 pt-1">
        <div className="h-8 w-56 animate-pulse rounded-lg bg-slate-200" />
        <div className="mt-2 h-4 w-72 animate-pulse rounded bg-slate-100" />
      </div>
      <div className="flex-1 overflow-hidden px-6 pb-6">
        <div className="h-full rounded-2xl border border-slate-200 bg-white p-5">
          <div className="h-5 w-40 animate-pulse rounded bg-slate-100" />
          <div className="mt-6 space-y-3">
            {[...Array(6)].map((_, i) => (
              <div key={i} className="h-11 animate-pulse rounded-lg bg-slate-50" />
            ))}
          </div>
        </div>
      </div>
    </div>
  );
}
