/**
 * Recuperar el acceso.
 *
 * Hasta ahora no existía: recuperar una contraseña pedía que un admin la
 * cambiara a mano, y eso empuja a mandarlas por chat.
 */

import Link from "next/link";

import { RecuperarForm } from "./RecuperarForm";

export const metadata = {
  title: "Recuperar contraseña — ClaimMix",
};

export default function RecuperarPage() {
  return (
    <main className="flex min-h-screen items-center justify-center bg-zinc-50 px-4">
      <div className="w-full max-w-sm">
        <div className="mb-8 text-center">
          <h1 className="text-2xl font-semibold tracking-tight text-zinc-900">ClaimMix</h1>
          <p className="mt-1 text-sm text-zinc-500">Gestión de siniestros asistida por IA</p>
        </div>

        <div className="rounded-xl border border-zinc-200 bg-white p-8 shadow-sm">
          <h2 className="mb-6 text-lg font-medium text-zinc-800">Recuperar contraseña</h2>
          <RecuperarForm />
        </div>

        <p className="mt-4 text-center text-sm text-zinc-500">
          ¿Te acordaste?{" "}
          <Link
            href="/login"
            className="font-medium text-zinc-800 underline-offset-2 hover:underline"
          >
            Iniciar sesión
          </Link>
        </p>
      </div>
    </main>
  );
}
