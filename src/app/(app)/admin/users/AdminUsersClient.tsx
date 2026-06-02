/**
 * AdminUsersClient — client component for the admin users page.
 *
 * Handles:
 *   - Fetching full user list (with emails) from GET /api/admin/users
 *   - Create user dialog (POST /api/admin/users)
 *   - Role badge display
 *   - Toast notifications
 */

"use client";

import { useEffect, useState, useCallback } from "react";
import { useActionState } from "react";
import { useFormStatus } from "react-dom";

interface UserRow {
  id: string;
  full_name: string;
  email: string;
  role: string;
  created_at: string;
}

interface Props {
  initialUsers: UserRow[];
}

// ── Role badge ────────────────────────────────────────────────────────────────

const ROLE_STYLES: Record<string, string> = {
  analyst: "bg-blue-100 text-blue-800",
  supervisor: "bg-purple-100 text-purple-800",
  admin: "bg-red-100 text-red-800",
};

const ROLE_LABELS: Record<string, string> = {
  analyst: "Analista",
  supervisor: "Supervisor",
  admin: "Admin",
};

function RoleBadge({ role }: { role: string }) {
  const styles = ROLE_STYLES[role] ?? "bg-slate-100 text-slate-800";
  const label = ROLE_LABELS[role] ?? role;
  return (
    <span
      className={`inline-flex items-center rounded-full px-2.5 py-0.5 text-xs font-medium ${styles}`}
    >
      {label}
    </span>
  );
}

// ── Submit button with pending state ──────────────────────────────────────────

function SubmitButton({ label, pendingLabel }: { label: string; pendingLabel: string }) {
  const { pending } = useFormStatus();
  return (
    <button
      type="submit"
      disabled={pending}
      className="rounded-md bg-slate-800 px-4 py-2 text-sm font-medium text-white hover:bg-slate-700 disabled:opacity-50"
    >
      {pending ? pendingLabel : label}
    </button>
  );
}

// ── Create user form action ───────────────────────────────────────────────────

type FormState = { error?: string; success?: boolean };

async function createUserAction(
  _prev: FormState,
  formData: FormData
): Promise<FormState> {
  const body = {
    full_name: formData.get("full_name"),
    email: formData.get("email"),
    role: formData.get("role"),
  };

  try {
    const res = await fetch("/api/admin/users", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
    });

    if (!res.ok) {
      const data = await res.json().catch(() => ({}));
      return {
        error:
          data?.error?.message ?? "Error al crear el usuario. Intentá de nuevo.",
      };
    }

    return { success: true };
  } catch {
    return { error: "Error de red. Intentá de nuevo." };
  }
}

// ── Create user dialog ────────────────────────────────────────────────────────

function CreateUserDialog({
  onClose,
  onCreated,
}: {
  onClose: () => void;
  onCreated: () => void;
}) {
  const [state, action] = useActionState<FormState, FormData>(createUserAction, {});

  useEffect(() => {
    if (state.success) {
      onCreated();
      onClose();
    }
  }, [state.success, onCreated, onClose]);

  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center bg-black/40"
      role="dialog"
      aria-modal="true"
      aria-label="Invitar analista"
    >
      <div className="w-full max-w-md rounded-lg bg-white p-6 shadow-xl">
        <h2 className="mb-4 text-base font-semibold text-slate-900">
          Invitar analista
        </h2>

        <form action={action} className="space-y-4">
          <div>
            <label
              htmlFor="full_name"
              className="mb-1 block text-xs font-medium text-slate-600"
            >
              Nombre completo
            </label>
            <input
              id="full_name"
              name="full_name"
              type="text"
              required
              minLength={2}
              maxLength={100}
              className="w-full rounded-md border border-slate-200 px-3 py-2 text-sm text-slate-900 focus:border-slate-400 focus:outline-none"
              placeholder="Ej: María García"
            />
          </div>

          <div>
            <label
              htmlFor="email"
              className="mb-1 block text-xs font-medium text-slate-600"
            >
              Correo electrónico
            </label>
            <input
              id="email"
              name="email"
              type="email"
              required
              className="w-full rounded-md border border-slate-200 px-3 py-2 text-sm text-slate-900 focus:border-slate-400 focus:outline-none"
              placeholder="analista@empresa.com"
            />
          </div>

          <div>
            <label
              htmlFor="role"
              className="mb-1 block text-xs font-medium text-slate-600"
            >
              Rol
            </label>
            <select
              id="role"
              name="role"
              defaultValue="analyst"
              className="w-full rounded-md border border-slate-200 px-3 py-2 text-sm text-slate-900 focus:border-slate-400 focus:outline-none"
            >
              <option value="analyst">Analista</option>
              <option value="admin">Admin</option>
            </select>
          </div>

          {state.error && (
            <div
              role="alert"
              className="rounded-md bg-red-50 px-3 py-2 text-xs text-red-700"
            >
              {state.error}
            </div>
          )}

          <div className="flex justify-end gap-2 pt-2">
            <button
              type="button"
              onClick={onClose}
              className="rounded-md px-4 py-2 text-sm font-medium text-slate-600 hover:bg-slate-100"
            >
              Cancelar
            </button>
            <SubmitButton label="Invitar" pendingLabel="Invitando..." />
          </div>
        </form>
      </div>
    </div>
  );
}

// ── Main client component ─────────────────────────────────────────────────────

function formatDate(iso: string): string {
  return new Date(iso).toLocaleDateString("es-AR", {
    day: "2-digit",
    month: "2-digit",
    year: "numeric",
  });
}

export function AdminUsersClient({ initialUsers }: Props) {
  const [users, setUsers] = useState<UserRow[]>(initialUsers);
  const [showDialog, setShowDialog] = useState(false);
  const [loading, setLoading] = useState(true);
  const [toast, setToast] = useState<string | null>(null);

  // Fetch full user list (with emails) from the API route on mount
  const refreshUsers = useCallback(async () => {
    try {
      setLoading(true);
      const res = await fetch("/api/admin/users");
      if (res.ok) {
        const data = await res.json();
        setUsers(data.users ?? []);
      }
    } catch {
      // Silently fall back to initialUsers on error
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    refreshUsers();
  }, [refreshUsers]);

  function handleCreated() {
    setToast("Usuario creado. Se enviará un correo de invitación.");
    refreshUsers();
    setTimeout(() => setToast(null), 4000);
  }

  return (
    <>
      {/* Toast */}
      {toast && (
        <div
          role="status"
          aria-live="polite"
          className="fixed bottom-4 right-4 z-50 rounded-lg bg-slate-800 px-4 py-3 text-sm text-white shadow-lg"
        >
          {toast}
        </div>
      )}

      {/* Dialog */}
      {showDialog && (
        <CreateUserDialog
          onClose={() => setShowDialog(false)}
          onCreated={handleCreated}
        />
      )}

      {/* Table header with action */}
      <div className="mb-4 flex items-center justify-end">
        <button
          onClick={() => setShowDialog(true)}
          className="rounded-md bg-slate-800 px-4 py-2 text-sm font-medium text-white hover:bg-slate-700"
        >
          + Invitar analista
        </button>
      </div>

      {/* Users table */}
      <div className="rounded-lg border border-slate-200 bg-white">
        <table className="w-full text-sm">
          <thead>
            <tr className="border-b border-slate-100 bg-slate-50 text-xs font-medium uppercase tracking-wide text-slate-500">
              <th className="px-5 py-3 text-left">Nombre</th>
              <th className="px-5 py-3 text-left">Email</th>
              <th className="px-5 py-3 text-left">Rol</th>
              <th className="px-5 py-3 text-left">Estado</th>
              <th className="px-5 py-3 text-left">Creado</th>
            </tr>
          </thead>
          <tbody>
            {loading && users.length === 0 ? (
              <tr>
                <td colSpan={5} className="px-5 py-8 text-center text-slate-400">
                  Cargando...
                </td>
              </tr>
            ) : users.length === 0 ? (
              <tr>
                <td colSpan={5} className="px-5 py-8 text-center text-slate-400">
                  No hay analistas registrados.
                </td>
              </tr>
            ) : (
              users.map((user) => (
                <tr
                  key={user.id}
                  className="border-b border-slate-50 last:border-0 hover:bg-slate-50"
                >
                  <td className="px-5 py-3 font-medium text-slate-800">
                    {user.full_name}
                  </td>
                  <td className="px-5 py-3 text-slate-600">
                    {user.email || "—"}
                  </td>
                  <td className="px-5 py-3">
                    <RoleBadge role={user.role} />
                  </td>
                  <td className="px-5 py-3">
                    <span className="inline-flex items-center rounded-full bg-green-100 px-2.5 py-0.5 text-xs font-medium text-green-800">
                      Activo
                    </span>
                  </td>
                  <td className="px-5 py-3 text-slate-500">
                    {formatDate(user.created_at)}
                  </td>
                </tr>
              ))
            )}
          </tbody>
        </table>
      </div>
    </>
  );
}
