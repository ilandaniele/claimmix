/**
 * Lo que se ve mientras la bandeja carga.
 *
 * Vivia como `<Suspense fallback>` adentro de `page.tsx`, y ahi no servia para
 * lo que importa: un Suspense interno NO es una frontera de carga para Next.
 * Sin frontera, una ruta dinamica —todas las de `(app)`, porque el layout lee
 * cookies— no se precarga, asi que el `<Link>` de la barra no adelanta nada y
 * al hacer clic la pantalla vieja se queda congelada hasta que el servidor
 * termina de renderizar.
 *
 * Como `loading.tsx` hace las dos cosas: Next precarga hasta aca en cada enlace
 * visible, y el clic pinta esto en el acto.
 */
export default function BandejaLoading() {
  return (
    <div className="flex h-full flex-col">
      <div className="px-6 pb-5 pt-1">
        <div className="h-8 w-64 animate-pulse rounded-lg bg-slate-200" />
        <div className="mt-2 h-4 w-80 animate-pulse rounded bg-slate-100" />
        <div className="mt-5 grid grid-cols-1 gap-4 sm:grid-cols-2 lg:grid-cols-4">
          {[...Array(4)].map((_, i) => (
            <div
              key={i}
              className="h-[104px] animate-pulse rounded-2xl border border-slate-200 bg-white"
            />
          ))}
        </div>
      </div>
      <div className="flex-1 overflow-hidden px-6 pb-6">
        <div className="h-full rounded-2xl border border-slate-200 bg-white p-5">
          <div className="flex gap-2">
            {[...Array(6)].map((_, i) => (
              <div key={i} className="h-8 w-24 animate-pulse rounded-lg bg-slate-100" />
            ))}
          </div>
          <div className="mt-6 space-y-3">
            {[...Array(8)].map((_, i) => (
              <div key={i} className="h-11 animate-pulse rounded-lg bg-slate-50" />
            ))}
          </div>
        </div>
      </div>
    </div>
  );
}
