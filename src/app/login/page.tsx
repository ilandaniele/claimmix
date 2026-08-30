/**
 * Login page — AC4 (analyst authentication flow).
 *
 * Spanish-language sign-in form matching the reference UI aesthetic.
 * Calls POST /api/auth/sign-in via the SignInForm client component.
 */

import Link from "next/link";
import { SignInForm } from "./SignInForm";

export const metadata = {
  title: "Iniciar sesión — ClaimMix",
};

export default async function LoginPage({
  searchParams,
}: {
  searchParams: Promise<{ aviso?: string }>;
}) {
  const { aviso } = await searchParams;

  return (
    <main className="flex min-h-screen items-center justify-center bg-zinc-50 px-4">
      <div className="w-full max-w-sm">
        {/* Logo / Brand */}
        <div className="mb-8 text-center">
          <h1 className="text-2xl font-semibold tracking-tight text-zinc-900">
            ClaimMix
          </h1>
          <p className="mt-1 text-sm text-zinc-500">
            Gestión de siniestros asistida por IA
          </p>
        </div>

        {/* Sign-in card */}
        <div className="rounded-xl border border-zinc-200 bg-white p-8 shadow-sm">
          <h2 className="mb-6 text-lg font-medium text-zinc-800">
            Iniciar sesión
          </h2>

          {/*
            El aviso que deja el alta.
            
            Dice lo mismo para una cuenta recién creada que para una dirección
            que ya tenía una. Es a propósito: si el alta contestara distinto en
            cada caso, alcanzaría con probar direcciones para averiguar quién
            trabaja acá.
          */}
          {aviso === "usa_tu_cuenta" && (
            <p
              role="status"
              className="mb-4 rounded-md bg-zinc-50 px-3 py-2 text-sm text-zinc-600"
            >
              Si la dirección es válida, ya podés entrar con tu contraseña. Si no
              la recordás, pedí un enlace abajo.
            </p>
          )}

          <SignInForm />
        </div>

        {/*
          Antes no había ningún enlace acá, porque no había flujo: recuperar la
          contraseña pedía escribirle a un admin. Eso empuja a mandarlas por chat.
        */}
        <p className="mt-4 text-center text-sm text-zinc-500">
          <Link
            href="/recuperar"
            className="font-medium text-zinc-700 underline-offset-2 hover:underline"
          >
            ¿Olvidaste tu contraseña?
          </Link>
        </p>

        <p className="mt-4 text-center text-sm text-zinc-500">
          ¿No tenés cuenta?{" "}
          <Link
            href="/registro"
            className="font-medium text-zinc-800 underline-offset-2 hover:underline"
          >
            Crear cuenta
          </Link>
        </p>
      </div>
    </main>
  );
}
