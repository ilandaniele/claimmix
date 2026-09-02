/**
 * ConfiguracionClient — password change form.
 *
 * Uses Better Auth's changePassword which requires the current password.
 */

"use client";

import { useState } from "react";
import { authClient } from "@/lib/auth/client";
import { useT } from "@/lib/i18n/LocaleContext";

type FormState = "idle" | "loading" | "success" | "error";

export function ConfiguracionClient() {
  const [currentPassword, setCurrentPassword] = useState("");
  const [newPassword, setNewPassword] = useState("");
  const [confirmPassword, setConfirmPassword] = useState("");
  const [state, setState] = useState<FormState>("idle");
  const [errorMsg, setErrorMsg] = useState("");
  const t = useT();

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    setErrorMsg("");

    if (newPassword.length < 8) {
      setErrorMsg(t("password.corta"));
      return;
    }
    if (newPassword !== confirmPassword) {
      setErrorMsg(t("password.noCoinciden"));
      return;
    }

    setState("loading");

    try {
      /*
       * Cambiar la contraseña cierra las otras sesiones.
       *
       * Decía `false`, y eso es pedirle explícitamente a Better Auth que las
       * deje abiertas. Alguien que cambia la contraseña porque sospecha que le
       * entraron dejaba viva la sesión del que entró —hasta treinta días, que
       * es lo que duran—: el gesto no hacía lo que la persona cree que hace.
       *
       * `true` cierra las demás y conserva ésta, así que quien lo hace no se
       * queda afuera de la pantalla donde está parado.
       *
       * El mismo criterio en `onPasswordReset`, para el camino de recuperación.
       */
      const { error } = await authClient.changePassword({
        currentPassword,
        newPassword,
        revokeOtherSessions: true,
      });

      if (error) {
        setErrorMsg(t("password.errorCambio"));
        setState("error");
        return;
      }

      setState("success");
      setCurrentPassword("");
      setNewPassword("");
      setConfirmPassword("");
      setTimeout(() => setState("idle"), 4000);
    } catch {
      setErrorMsg(t("password.errorInesperado"));
      setState("error");
    }
  }

  return (
    <form onSubmit={handleSubmit} className="space-y-4">
      <div>
        <label
          htmlFor="current_password"
          className="mb-1 block text-xs font-medium text-slate-600"
        >
          {t("password.actual")}
        </label>
        <input
          id="current_password"
          type="password"
          required
          value={currentPassword}
          onChange={(e) => setCurrentPassword(e.target.value)}
          className="w-full rounded-md border border-slate-200 px-3 py-2 text-sm text-slate-900 focus:border-slate-400 focus:outline-none"
          placeholder={t("password.actualPlaceholder")}
          autoComplete="current-password"
        />
      </div>

      <div>
        <label
          htmlFor="new_password"
          className="mb-1 block text-xs font-medium text-slate-600"
        >
          {t("password.nueva")}
        </label>
        <input
          id="new_password"
          type="password"
          required
          minLength={8}
          value={newPassword}
          onChange={(e) => setNewPassword(e.target.value)}
          className="w-full rounded-md border border-slate-200 px-3 py-2 text-sm text-slate-900 focus:border-slate-400 focus:outline-none"
          placeholder={t("password.nuevaPlaceholder")}
          autoComplete="new-password"
        />
      </div>

      <div>
        <label
          htmlFor="confirm_password"
          className="mb-1 block text-xs font-medium text-slate-600"
        >
          {t("password.confirmar")}
        </label>
        <input
          id="confirm_password"
          type="password"
          required
          minLength={8}
          value={confirmPassword}
          onChange={(e) => setConfirmPassword(e.target.value)}
          className="w-full rounded-md border border-slate-200 px-3 py-2 text-sm text-slate-900 focus:border-slate-400 focus:outline-none"
          placeholder={t("password.confirmarPlaceholder")}
          autoComplete="new-password"
        />
      </div>

      {state === "success" && (
        <div
          role="status"
          aria-live="polite"
          className="rounded-md bg-green-50 px-3 py-2 text-xs text-green-700"
        >
          {t("password.ok")}
        </div>
      )}

      {(state === "error" || errorMsg) && (
        <div
          role="alert"
          className="rounded-md bg-red-50 px-3 py-2 text-xs text-red-700"
        >
          {errorMsg}
        </div>
      )}

      <div className="pt-1">
        <button
          type="submit"
          disabled={state === "loading"}
          className="rounded-md bg-slate-800 px-4 py-2 text-sm font-medium text-white hover:bg-slate-700 disabled:opacity-50"
        >
          {state === "loading" ? t("password.actualizando") : t("password.boton")}
        </button>
      </div>
    </form>
  );
}
