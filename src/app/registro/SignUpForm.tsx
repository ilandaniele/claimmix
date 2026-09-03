/**
 * SignUpForm — client component for the /registro page.
 *
 * Mirrors SignInForm (React 19 useActionState + useTransition).
 * Submits to the signUp server action; on success the action redirects
 * to /bandeja with the session cookie already set.
 */

"use client";

import { useActionState, useTransition } from "react";
import { signUp } from "./actions";

type FormState = {
  error?: string;
  fieldErrors?: Record<string, string[]>;
};

const initialState: FormState = {};

const inputClass =
  "w-full rounded-xl border border-slate-300 bg-white dark:border-slate-600 px-3 py-2 text-sm text-slate-900 placeholder-slate-400 outline-none transition focus:border-slate-500 focus:ring-2 focus:ring-slate-500/20 disabled:cursor-not-allowed disabled:opacity-50";

export function SignUpForm() {
  const [state, formAction] = useActionState<FormState, FormData>(
    signUp,
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
    <form onSubmit={handleSubmit} noValidate aria-label="Formulario de registro">
      {state.error && (
        <div
          role="alert"
          aria-live="assertive"
          className="mb-4 rounded-xl border border-red-200 bg-red-50 px-4 py-3 text-sm text-red-700"
        >
          {state.error}
        </div>
      )}

      {/* Full name */}
      <div className="mb-4">
        <label
          htmlFor="full_name"
          className="mb-1.5 block text-sm font-medium text-slate-700"
        >
          Nombre completo
        </label>
        <input
          id="full_name"
          name="full_name"
          type="text"
          autoComplete="name"
          required
          aria-required="true"
          aria-describedby={state.fieldErrors?.full_name ? "full-name-error" : undefined}
          aria-invalid={!!state.fieldErrors?.full_name}
          className={inputClass}
          placeholder="Juan Pérez"
          disabled={isPending}
        />
        {state.fieldErrors?.full_name && (
          <p id="full-name-error" role="alert" className="mt-1 text-xs text-red-600">
            {state.fieldErrors.full_name[0]}
          </p>
        )}
      </div>

      {/* Email */}
      <div className="mb-4">
        <label
          htmlFor="email"
          className="mb-1.5 block text-sm font-medium text-slate-700"
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
          aria-describedby={state.fieldErrors?.email ? "email-error" : undefined}
          aria-invalid={!!state.fieldErrors?.email}
          className={inputClass}
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
          className="mb-1.5 block text-sm font-medium text-slate-700"
        >
          Contraseña
        </label>
        <input
          id="password"
          name="password"
          type="password"
          autoComplete="new-password"
          required
          aria-required="true"
          aria-describedby={state.fieldErrors?.password ? "password-error" : undefined}
          aria-invalid={!!state.fieldErrors?.password}
          className={inputClass}
          placeholder="Mínimo 8 caracteres"
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
        className="w-full rounded-full bg-violet-600 px-4 py-2.5 text-sm font-semibold text-white shadow-sm transition hover:bg-violet-700 focus:outline-none focus:ring-2 focus:ring-slate-900/50 focus:ring-offset-2 disabled:cursor-not-allowed disabled:opacity-60"
      >
        {isPending ? (
          <span className="flex items-center justify-center gap-2">
            <span
              className="h-4 w-4 animate-spin rounded-full border-2 border-white border-t-transparent"
              aria-hidden="true"
            />
            Creando cuenta…
          </span>
        ) : (
          "Crear cuenta"
        )}
      </button>
    </form>
  );
}
