/**
 * Registration page — self-service account creation.
 *
 * New accounts are created in the default tenant with the "analyst" role
 * (same provisioning rule as Google sign-in). Admins can change roles later
 * from /admin/users.
 */

import Link from "next/link";
import { SignUpForm } from "./SignUpForm";

export const metadata = {
  title: "Crear cuenta — ClaimMix",
};

export default function RegistroPage() {
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

        {/* Sign-up card */}
        <div className="rounded-xl border border-zinc-200 bg-white p-8 shadow-sm">
          <h2 className="mb-6 text-lg font-medium text-zinc-800">
            Crear cuenta
          </h2>
          <SignUpForm />
        </div>

        <p className="mt-4 text-center text-sm text-zinc-500">
          ¿Ya tenés cuenta?{" "}
          <Link href="/login" className="font-medium text-zinc-800 underline-offset-2 hover:underline">
            Iniciar sesión
          </Link>
        </p>
      </div>
    </main>
  );
}
