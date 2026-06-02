/**
 * Login page — AC4 (analyst authentication flow).
 *
 * Spanish-language sign-in form matching the reference UI aesthetic.
 * Calls POST /api/auth/sign-in via the SignInForm client component.
 */

import { SignInForm } from "./SignInForm";

export const metadata = {
  title: "Iniciar sesión — ClaimMix",
};

export default function LoginPage() {
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
          <SignInForm />
        </div>
      </div>
    </main>
  );
}
