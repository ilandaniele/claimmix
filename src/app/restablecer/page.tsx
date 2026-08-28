/**
 * Poner la contraseña nueva.
 *
 * Se llega desde el mail. Better Auth valida el token en `/reset-password/:token`
 * y redirige acá con `?token=`; si alguien abre esta página a mano no hay token
 * y se le dice qué hacer en vez de mostrarle un formulario que no va a andar.
 */

import Link from "next/link";

import { RestablecerForm } from "./RestablecerForm";

export const metadata = {
  title: "Contraseña nueva — ClaimMix",
};

export default async function RestablecerPage({
  searchParams,
}: {
  searchParams: Promise<{ token?: string; error?: string }>;
}) {
  const { token, error } = await searchParams;

  return (
    <main className="flex min-h-screen items-center justify-center bg-zinc-50 px-4">
      <div className="w-full max-w-sm">
        <div className="mb-8 text-center">
          <h1 className="text-2xl font-semibold tracking-tight text-zinc-900">ClaimMix</h1>
          <p className="mt-1 text-sm text-zinc-500">Gestión de siniestros asistida por IA</p>
        </div>

        <div className="rounded-xl border border-zinc-200 bg-white p-8 shadow-sm">
          <h2 className="mb-6 text-lg font-medium text-zinc-800">Contraseña nueva</h2>

          {token && !error ? (
            <RestablecerForm token={token} />
          ) : (
            <div>
              <p role="alert" className="text-sm text-zinc-700">
                {error
                  ? "Ese enlace ya no sirve: pudo haber vencido o haberse usado."
                  : "Entrá desde el enlace que te llegó por correo."}
              </p>
              <Link
                href="/recuperar"
                className="mt-6 inline-block w-full rounded-lg bg-zinc-900 px-4 py-2.5 text-center text-sm font-medium text-white transition hover:bg-zinc-800"
              >
                Pedir un enlace
              </Link>
            </div>
          )}
        </div>
      </div>
    </main>
  );
}
