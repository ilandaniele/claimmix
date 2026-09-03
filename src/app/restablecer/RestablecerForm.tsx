"use client";

import { useActionState, useEffect } from "react";
import Link from "next/link";

import { restablecer, type EstadoRestablecer } from "./actions";

const inicial: EstadoRestablecer = {};

export function RestablecerForm({ token }: { token: string }) {
  const [state, formAction, isPending] = useActionState<EstadoRestablecer, FormData>(
    restablecer,
    inicial
  );

  /*
   * El token sale de la URL apenas se lee.
   *
   * Llega como `?token=…` porque así funciona un enlace por correo, y eso no se
   * puede cambiar. Lo que sí se puede es que no se quede ahí: mientras está en
   * la barra de direcciones queda en el historial del navegador, en el
   * `Referer` de cualquier pedido que salga de esta página, y a la vista de
   * quien mire la pantalla. Un token de recuperación es la credencial mientras
   * dura.
   *
   * El valor ya está en `token`, así que el formulario sigue funcionando: lo
   * único que se pierde es la copia de la URL.
   *
   * El costo, dicho: si alguien recarga la página después de esto, el token ya
   * no está y tiene que pedir otro enlace. Se decidió pagarlo en vez de
   * guardarlo en `sessionStorage`, que sería sumar un lugar más donde vive una
   * credencial para ahorrar un caso poco frecuente.
   */
  useEffect(() => {
    if (typeof window === "undefined") return;
    const url = new URL(window.location.href);
    if (!url.searchParams.has("token")) return;
    url.searchParams.delete("token");
    window.history.replaceState(null, "", url.pathname + url.search + url.hash);
  }, []);

  if (state.listo) {
    return (
      <div>
        <p role="status" className="text-sm text-slate-700">
          Listo, tu contraseña quedó cambiada.
        </p>
        <Link
          href="/login"
          className="mt-6 inline-block w-full rounded-lg bg-slate-900 px-4 py-2.5 text-center text-sm font-medium text-white transition hover:bg-slate-800"
        >
          Iniciar sesión
        </Link>
      </div>
    );
  }

  return (
    <form action={formAction} noValidate aria-label="Formulario de contraseña nueva">
      {/*
        El token viaja escondido porque no es algo que la persona elija ni
        deba editar. Que esté en un input y no en el action de la URL evita
        además que se copie con el enlace si alguien comparte la pantalla.
      */}
      <input type="hidden" name="token" value={token} />

      {state.error && (
        <div
          role="alert"
          aria-live="assertive"
          className="mb-4 rounded-xl border border-red-200 bg-red-50 px-4 py-3 text-sm text-red-700"
        >
          {state.error}{" "}
          <Link href="/recuperar" className="font-medium underline underline-offset-2">
            Pedir otro
          </Link>
        </div>
      )}

      <div className="mb-4">
        <label htmlFor="password" className="mb-1.5 block text-sm font-medium text-slate-700">
          Contraseña nueva
        </label>
        <input
          id="password"
          name="password"
          type="password"
          autoComplete="new-password"
          required
          aria-required="true"
          aria-describedby="password-ayuda"
          aria-invalid={!!state.fieldErrors?.password}
          className="w-full rounded-xl border border-slate-300 bg-white dark:border-slate-600 px-3 py-2 text-sm text-slate-900 outline-none transition focus:border-slate-500 focus:ring-2 focus:ring-slate-500/20 disabled:cursor-not-allowed disabled:opacity-50"
          disabled={isPending}
        />
        <p id="password-ayuda" className="mt-1 text-xs text-slate-500">
          Al menos 8 caracteres.
        </p>
        {state.fieldErrors?.password && (
          <p role="alert" className="mt-1 text-xs text-red-600">
            {state.fieldErrors.password[0]}
          </p>
        )}
      </div>

      <div className="mb-6">
        <label htmlFor="repetir" className="mb-1.5 block text-sm font-medium text-slate-700">
          Repetila
        </label>
        <input
          id="repetir"
          name="repetir"
          type="password"
          autoComplete="new-password"
          required
          aria-required="true"
          aria-invalid={!!state.fieldErrors?.repetir}
          className="w-full rounded-xl border border-slate-300 bg-white dark:border-slate-600 px-3 py-2 text-sm text-slate-900 outline-none transition focus:border-slate-500 focus:ring-2 focus:ring-slate-500/20 disabled:cursor-not-allowed disabled:opacity-50"
          disabled={isPending}
        />
        {state.fieldErrors?.repetir && (
          <p role="alert" className="mt-1 text-xs text-red-600">
            {state.fieldErrors.repetir[0]}
          </p>
        )}
      </div>

      <button
        type="submit"
        disabled={isPending}
        className="w-full rounded-lg bg-slate-900 px-4 py-2.5 text-sm font-medium text-white transition hover:bg-slate-800 disabled:cursor-not-allowed disabled:opacity-50"
      >
        {isPending ? "Guardando…" : "Cambiar la contraseña"}
      </button>
    </form>
  );
}
