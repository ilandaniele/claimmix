/**
 * ConfiguracionClient — password change form.
 *
 * Uses Supabase browser client's `updateUser()` to change the password.
 * Only the new password + confirm are needed — Supabase handles re-auth
 * via the existing session (the current password is verified server-side
 * by Supabase Auth).
 */

"use client";

import { useState } from "react";
import { supabaseBrowser } from "@/lib/supabase/browser";

type FormState = "idle" | "loading" | "success" | "error";

export function ConfiguracionClient() {
  const [newPassword, setNewPassword] = useState("");
  const [confirmPassword, setConfirmPassword] = useState("");
  const [state, setState] = useState<FormState>("idle");
  const [errorMsg, setErrorMsg] = useState("");

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    setErrorMsg("");

    if (newPassword.length < 8) {
      setErrorMsg("La contraseña debe tener al menos 8 caracteres.");
      return;
    }
    if (newPassword !== confirmPassword) {
      setErrorMsg("Las contraseñas no coinciden.");
      return;
    }

    setState("loading");

    try {
      const { error } = await supabaseBrowser.auth.updateUser({
        password: newPassword,
      });

      if (error) {
        setErrorMsg("Error al cambiar la contraseña. Intentá de nuevo.");
        setState("error");
        return;
      }

      setState("success");
      setNewPassword("");
      setConfirmPassword("");
      // Auto-reset success state after 4 seconds
      setTimeout(() => setState("idle"), 4000);
    } catch {
      setErrorMsg("Error inesperado. Intentá de nuevo.");
      setState("error");
    }
  }

  return (
    <form onSubmit={handleSubmit} className="space-y-4">
      <div>
        <label
          htmlFor="new_password"
          className="mb-1 block text-xs font-medium text-slate-600"
        >
          Nueva contraseña
        </label>
        <input
          id="new_password"
          type="password"
          required
          minLength={8}
          value={newPassword}
          onChange={(e) => setNewPassword(e.target.value)}
          className="w-full rounded-md border border-slate-200 px-3 py-2 text-sm text-slate-900 focus:border-slate-400 focus:outline-none"
          placeholder="Mínimo 8 caracteres"
          autoComplete="new-password"
        />
      </div>

      <div>
        <label
          htmlFor="confirm_password"
          className="mb-1 block text-xs font-medium text-slate-600"
        >
          Confirmar nueva contraseña
        </label>
        <input
          id="confirm_password"
          type="password"
          required
          minLength={8}
          value={confirmPassword}
          onChange={(e) => setConfirmPassword(e.target.value)}
          className="w-full rounded-md border border-slate-200 px-3 py-2 text-sm text-slate-900 focus:border-slate-400 focus:outline-none"
          placeholder="Repetí la nueva contraseña"
          autoComplete="new-password"
        />
      </div>

      {state === "success" && (
        <div
          role="status"
          aria-live="polite"
          className="rounded-md bg-green-50 px-3 py-2 text-xs text-green-700"
        >
          Contraseña actualizada correctamente.
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
          {state === "loading" ? "Actualizando..." : "Cambiar contraseña"}
        </button>
      </div>
    </form>
  );
}
