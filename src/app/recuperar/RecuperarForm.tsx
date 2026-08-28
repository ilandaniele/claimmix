"use client";

import { useActionState } from "react";
import Link from "next/link";

import { pedirEnlace, SIEMPRE_LO_MISMO, type EstadoRecuperar } from "./actions";

const inicial: EstadoRecuperar = {};

export function RecuperarForm() {
  const [state, formAction, isPending] = useActionState<EstadoRecuperar, FormData>(
    pedirEnlace,
    inicial
  );

  /*
   * Cuando salió bien no se vuelve a mostrar el formulario.
   *
   * Dejarlo puesto invita a reintentar, y reintentar no hace nada útil: el
   * enlace anterior sigue vivo una hora. Peor, gasta el techo de tres por hora
   * y termina en «Demasiados intentos» sobre alguien que no hizo nada mal.
   */
  if (state.listo) {
    return (
      <div>
        <p role="status" className="text-sm text-zinc-700">
          {SIEMPRE_LO_MISMO}
        </p>
        <p className="mt-4 text-sm text-zinc-500">
          El enlace vence en una hora y sirve una sola vez.
        </p>
        <Link
          href="/login"
          className="mt-6 inline-block text-sm font-medium text-zinc-800 underline-offset-2 hover:underline"
        >
          Volver a iniciar sesión
        </Link>
      </div>
    );
  }

  return (
    <form action={formAction} noValidate aria-label="Formulario de recuperación">
      {state.error && (
        <div
          role="alert"
          aria-live="assertive"
          className="mb-4 rounded-lg border border-red-200 bg-red-50 px-4 py-3 text-sm text-red-700"
        >
          {state.error}
        </div>
      )}

      <p className="mb-4 text-sm text-zinc-600">
        Decinos con qué correo entrás y te mandamos un enlace para poner una
        contraseña nueva.
      </p>

      <div className="mb-6">
        <label htmlFor="email" className="mb-1.5 block text-sm font-medium text-zinc-700">
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

      <button
        type="submit"
        disabled={isPending}
        className="w-full rounded-lg bg-zinc-900 px-4 py-2.5 text-sm font-medium text-white transition hover:bg-zinc-800 disabled:cursor-not-allowed disabled:opacity-50"
      >
        {isPending ? "Enviando…" : "Enviarme el enlace"}
      </button>
    </form>
  );
}
