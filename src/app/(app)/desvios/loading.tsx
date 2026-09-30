/**
 * Lo que se ve mientras los desvíos cargan.
 *
 * Misma razón que `agenda/loading.tsx`: sin esta frontera, el `<Link>` de la
 * barra no precarga la ruta y el clic deja la pantalla vieja congelada.
 */
export default function DesviosLoading() {
  return (
    <div className="flex h-full flex-col">
      <div className="px-6 pb-5 pt-1">
        <div className="h-8 w-40 animate-pulse rounded-lg bg-slate-200" />
        <div className="mt-2 h-4 w-80 animate-pulse rounded bg-slate-100" />
      </div>
      <div className="flex-1 overflow-hidden px-6 pb-8">
        <div className="h-full rounded-2xl border border-slate-200 bg-white p-5 shadow-md">
          <div className="space-y-3">
            {[...Array(6)].map((_, i) => (
              <div key={i} className="h-11 animate-pulse rounded-lg bg-slate-50" />
            ))}
          </div>
        </div>
      </div>
    </div>
  );
}
