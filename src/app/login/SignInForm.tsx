"use client";

import { useActionState } from "react";
import { signIn, signInWithGoogle } from "./actions";

type FormState = {
  error?: string;
  fieldErrors?: Record<string, string[]>;
};

const initialState: FormState = {};

export function SignInForm() {
  const [state, formAction, isPending] = useActionState<FormState, FormData>(
    signIn,
    initialState
  );

  return (
    <>
      <form action={formAction} noValidate aria-label="Formulario de inicio de sesión">
        {state.error && (
          <div
            role="alert"
            aria-live="assertive"
            className="mb-4 rounded-xl border border-red-200 bg-red-50 px-4 py-3 text-sm text-red-700 dark:border-red-500/30 dark:bg-red-500/10 dark:text-red-200"
          >
            {state.error}
          </div>
        )}

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
            className="w-full rounded-xl border border-slate-300 bg-white px-3.5 py-2.5 text-sm text-slate-900 placeholder-slate-400 outline-none transition focus:border-violet-500 focus:ring-4 focus:ring-violet-500/15 disabled:cursor-not-allowed disabled:opacity-50 dark:border-slate-600 dark:placeholder-slate-500"
            placeholder="analista@aseguradora.com"
            disabled={isPending}
          />
          {state.fieldErrors?.email && (
            <p id="email-error" role="alert" className="mt-1 text-xs text-red-600 dark:text-red-300">
              {state.fieldErrors.email[0]}
            </p>
          )}
        </div>

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
            autoComplete="current-password"
            required
            aria-required="true"
            aria-describedby={state.fieldErrors?.password ? "password-error" : undefined}
            aria-invalid={!!state.fieldErrors?.password}
            className="w-full rounded-xl border border-slate-300 bg-white px-3.5 py-2.5 text-sm text-slate-900 placeholder-slate-400 outline-none transition focus:border-violet-500 focus:ring-4 focus:ring-violet-500/15 disabled:cursor-not-allowed disabled:opacity-50 dark:border-slate-600 dark:placeholder-slate-500"
            placeholder="••••••••"
            disabled={isPending}
          />
          {state.fieldErrors?.password && (
            <p id="password-error" role="alert" className="mt-1 text-xs text-red-600 dark:text-red-300">
              {state.fieldErrors.password[0]}
            </p>
          )}
        </div>

        <button
          type="submit"
          disabled={isPending}
          aria-busy={isPending}
          className="w-full rounded-full bg-violet-600 px-4 py-2.5 text-sm font-semibold text-white shadow-sm transition hover:bg-violet-700 focus-visible:outline-none focus-visible:ring-4 focus-visible:ring-violet-500/30 disabled:cursor-not-allowed disabled:opacity-60"
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

      <div className="my-5 flex items-center gap-3 text-xs text-slate-400">
        <span className="h-px flex-1 bg-slate-200" />
        <span className="uppercase tracking-[0.08em]">o</span>
        <span className="h-px flex-1 bg-slate-200" />
      </div>

      <form action={signInWithGoogle}>
        <button
          type="submit"
          className="flex w-full items-center justify-center gap-2.5 rounded-full border border-slate-300 bg-white px-4 py-2.5 text-sm font-semibold text-slate-800 transition hover:bg-slate-50 focus-visible:outline-none focus-visible:ring-4 focus-visible:ring-violet-500/25 dark:border-slate-600"
        >
          <GoogleIcon />
          Continuar con Google
        </button>
      </form>
    </>
  );
}

function GoogleIcon() {
  return (
    <svg viewBox="0 0 48 48" className="h-4 w-4 shrink-0" aria-hidden="true">
      <path fill="#EA4335" d="M24 9.5c3.54 0 6.71 1.22 9.21 3.6l6.85-6.85C35.9 2.38 30.47 0 24 0 14.62 0 6.51 5.38 2.56 13.22l7.98 6.19C12.43 13.72 17.74 9.5 24 9.5z" />
      <path fill="#4285F4" d="M46.98 24.55c0-1.57-.15-3.09-.38-4.55H24v9.02h12.94c-.58 2.96-2.26 5.48-4.78 7.18l7.73 6c4.51-4.18 7.09-10.36 7.09-17.65z" />
      <path fill="#FBBC05" d="M10.53 28.59c-.48-1.45-.76-2.99-.76-4.59s.27-3.14.76-4.59l-7.98-6.19C.92 16.46 0 20.12 0 24c0 3.88.92 7.54 2.56 10.78l7.97-6.19z" />
      <path fill="#34A853" d="M24 48c6.48 0 11.93-2.13 15.89-5.81l-7.73-6c-2.15 1.45-4.92 2.3-8.16 2.3-6.26 0-11.57-4.22-13.47-9.91l-7.98 6.19C6.51 42.62 14.62 48 24 48z" />
    </svg>
  );
}
