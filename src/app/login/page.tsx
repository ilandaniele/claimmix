/**
 * Login page — placeholder.
 * Full sign-in form is implemented in W2.
 *
 * This placeholder ensures the route exists so proxy.ts can redirect
 * unauthenticated users here without a 404.
 */

export default function LoginPage() {
  return (
    <main className="flex min-h-screen items-center justify-center bg-zinc-50">
      <div className="w-full max-w-sm rounded-xl border border-zinc-200 bg-white p-8 shadow-sm">
        <h1 className="mb-6 text-center text-2xl font-semibold text-zinc-900">
          ClaimMix
        </h1>
        <p className="text-center text-sm text-zinc-500">
          Autenticación — implementada en W2.
        </p>
      </div>
    </main>
  );
}
