/**
 * SignInForm — client component for the login page.
 *
 * Uses React 19 useActionState (not the deprecated useFormState from react-dom).
 * Submits to POST /api/auth/sign-in via the signIn server action.
 *
 * AC4: Spanish labels ("Correo electrónico", "Contraseña", "Iniciar sesión"),
 *      clean muted design.
 * AC5: The route handler enforces rate limiting; the form shows the error message.
 */

"use client";

import { useActionState, useTransition } from "react";
import { signIn, signInWithGoogle } from "./actions";

type FormState = {
  error?: string;
  fieldErrors?: Record<string, string[]>;
};

const initialState: FormState = {};

export function SignInForm() {
  const [state, formAction] = useActionState<FormState, FormData>(
    signIn,
    initialState
  );
  const [isPending, startTransition] = useTransition();

  function handleSubmit(e: React.FormEvent<HTMLFormElement>) {
    e.preventDefault();
    const formData = new FormData(e.currentTarget);
    startTransition(() => {
      formAction(formData);
    });
  }

  return (
    <>
    <form onSubmit={handleSubmit} noValidate aria-label="Formulario de inicio de sesión">
      {/* Global error (wrong credentials, rate limit, etc.) */}
      {state.error && (
        <div
          role="alert"
          aria-live="assertive"
          className="mb-4 rounded-lg border border-red-200 bg-red-50 px-4 py-3 text-sm text-red-700"
        >
          {state.error}
        </div>
      )}

      {/* Email */}
      <div className="mb-4">
        <label
          htmlFor="email"
          className="mb-1.5 block text-sm font-medium text-zinc-700"
        >
          Correo electrónico
        </label>
        <input
          id="email"
          name="email"
          type="email"
          autoComplete="email"
          required
          aria-required="true"
          aria-describedby={
            state.fieldErrors?.email ? "email-error" : undefined
          }
          aria-invalid={!!state.fieldErrors?.email}
          className="w-full rounded-lg border border-zinc-300 bg-white px-3 py-2 text-sm text-zinc-900 placeholder-zinc-400 outline-none transition focus:border-zinc-500 focus:ring-2 focus:ring-zinc-500/20 disabled:cursor-not-allowed disabled:opacity-50"
          placeholder="analista@aseguradora.com"
          disabled={isPending}
        />
        {state.fieldErrors?.email && (
          <p id="email-error" role="alert" className="mt-1 text-xs text-red-600">
            {state.fieldErrors.email[0]}
          </p>
        )}
      </div>

      {/* Password */}
      <div className="mb-6">
        <label
          htmlFor="password"
          className="mb-1.5 block text-sm font-medium text-zinc-700"
        >
          Contraseña
        </label>
        <input
          id="password"
          name="password"
          type="password"
          autoComplete="current-password"
          required
          aria-required="true"
          aria-describedby={
            state.fieldErrors?.password ? "password-error" : undefined
          }
          aria-invalid={!!state.fieldErrors?.password}
          className="w-full rounded-lg border border-zinc-300 bg-white px-3 py-2 text-sm text-zinc-900 placeholder-zinc-400 outline-none transition focus:border-zinc-500 focus:ring-2 focus:ring-zinc-500/20 disabled:cursor-not-allowed disabled:opacity-50"
          placeholder="••••••••"
          disabled={isPending}
        />
        {state.fieldErrors?.password && (
          <p id="password-error" role="alert" className="mt-1 text-xs text-red-600">
            {state.fieldErrors.password[0]}
          </p>
        )}
      </div>

      {/* Submit */}
      <button
        type="submit"
        disabled={isPending}
        aria-busy={isPending}
        className="w-full rounded-lg bg-zinc-900 px-4 py-2.5 text-sm font-medium text-white transition hover:bg-zinc-700 focus:outline-none focus:ring-2 focus:ring-zinc-900/50 focus:ring-offset-2 disabled:cursor-not-allowed disabled:opacity-60"
      >
        {isPending ? (
          <span className="flex items-center justify-center gap-2">
            <span
              className="h-4 w-4 animate-spin rounded-full border-2 border-white border-t-transparent"
              aria-hidden="true"
            />
            Iniciando sesión…
          </span>
        ) : (
          "Iniciar sesión"
        )}
      </button>
    </form>
      <div className="my-4 flex items-center gap-3 text-xs text-zinc-400">
        <span className="h-px flex-1 bg-zinc-200" />
        <span>o</span>
        <span className="h-px flex-1 bg-zinc-200" />
      </div>

      <form action={signInWithGoogle}>
        <button
          type="submit"
          className="w-full rounded-lg border border-zinc-300 bg-white px-4 py-2.5 text-sm font-medium text-zinc-800 transition hover:bg-zinc-50 focus:outline-none focus:ring-2 focus:ring-zinc-900/20 focus:ring-offset-2"
        >
          Continuar con Google
        </button>
      </form>
    </>
  );
}
