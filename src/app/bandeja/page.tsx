/**
 * Bandeja (inbox) page — placeholder.
 * Full implementation is in W5.
 *
 * This placeholder ensures the route exists so proxy.ts redirects work correctly.
 * Protected by proxy.ts — unauthenticated access redirects to /login.
 */

export default function BandejaPage() {
  return (
    <main className="flex min-h-screen items-center justify-center bg-zinc-50">
      <div className="text-center">
        <h1 className="text-2xl font-semibold text-zinc-900">Bandeja</h1>
        <p className="mt-2 text-sm text-zinc-500">
          Dashboard de casos — implementado en W5.
        </p>
      </div>
    </main>
  );
}
