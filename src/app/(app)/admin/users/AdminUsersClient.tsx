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
  role: UserRole;
  created_at: string;
}

type UserRole = "owner" | "admin" | "specialist" | "analyst" | "viewer";

interface Props {
  initialUsers: UserRow[];
  currentUserId: string;
  currentUserRole: string;
}

// ── Role badge ────────────────────────────────────────────────────────────────

const ROLE_STYLES: Record<string, string> = {
  owner: "bg-amber-100 text-amber-800",
  admin: "bg-red-100 text-red-800",
  specialist: "bg-purple-100 text-purple-800",
  analyst: "bg-blue-100 text-blue-800",
  viewer: "bg-slate-100 text-slate-700",
};

const ROLE_LABELS: Record<string, string> = {
  owner: "Owner",
  admin: "Admin",
  specialist: "Especialista",
  analyst: "Analista",
  viewer: "Visor",
};

const ROLE_OPTIONS: Array<{ value: UserRole; label: string }> = [
  { value: "analyst", label: "Analista" },
  { value: "specialist", label: "Especialista" },
  { value: "viewer", label: "Visor" },
  { value: "admin", label: "Admin" },
  { value: "owner", label: "Owner" },
];

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

async function readApiError(res: Response, fallback: string): Promise<string> {
  const data = await res.json().catch(() => null);
  return data?.error?.message ?? fallback;
}

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
  currentUserRole,
}: {
  onClose: () => void;
  onCreated: () => void;
  currentUserRole: string;
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
      aria-label="Invitar usuario"
    >
      <div className="w-full max-w-md rounded-lg bg-white p-6 shadow-xl">
        <h2 className="mb-4 text-base font-semibold text-slate-900">
          Invitar usuario
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
              {ROLE_OPTIONS.map((option) => (
                <option
                  key={option.value}
                  value={option.value}
                  disabled={option.value === "owner" && currentUserRole !== "owner"}
                >
                  {option.value === "viewer" ? "Visor (solo lectura)" : option.label}
                </option>
              ))}
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

export function AdminUsersClient({
  initialUsers,
  currentUserId,
  currentUserRole,
}: Props) {
  const [users, setUsers] = useState<UserRow[]>(initialUsers);
  const [showDialog, setShowDialog] = useState(false);
  const [loading, setLoading] = useState(true);
  const [toast, setToast] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [changingUserId, setChangingUserId] = useState<string | null>(null);

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
    // eslint-disable-next-line react-hooks/set-state-in-effect -- fetch on mount, not a cascading re-render risk
    refreshUsers();
  }, [refreshUsers]);

  function handleCreated() {
    setToast("Usuario creado. Se enviará un correo de invitación.");
    refreshUsers();
    setTimeout(() => setToast(null), 4000);
  }

  async function handleRoleChange(user: UserRow, role: UserRole) {
    if (user.role === role) return;
    setError(null);
    setChangingUserId(user.id);
    try {
      const res = await fetch(`/api/admin/users/${user.id}`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ role }),
      });

      if (!res.ok) {
        throw new Error(await readApiError(res, "No se pudo actualizar el rol."));
      }

      setUsers((prev) =>
        prev.map((item) => (item.id === user.id ? { ...item, role } : item))
      );
      setToast("Rol actualizado.");
      setTimeout(() => setToast(null), 4000);
    } catch (err) {
      setError(err instanceof Error ? err.message : "No se pudo actualizar el rol.");
    } finally {
      setChangingUserId(null);
    }
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

      {error && (
        <div
          role="alert"
          className="mb-4 rounded-md bg-red-50 px-3 py-2 text-sm text-red-700 dark:bg-red-950/50 dark:text-red-200"
        >
          {error}
        </div>
      )}

      {/* Dialog */}
      {showDialog && (
        <CreateUserDialog
          onClose={() => setShowDialog(false)}
          onCreated={handleCreated}
          currentUserRole={currentUserRole}
        />
      )}

      {/* Table header with action */}
      <div className="mb-4 flex items-center justify-end">
        <button
          onClick={() => setShowDialog(true)}
          className="rounded-md bg-slate-800 px-4 py-2 text-sm font-medium text-white hover:bg-slate-700"
        >
          + Invitar usuario
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
                  No hay usuarios registrados.
                </td>
              </tr>
            ) : (
              users.map((user) => {
                const isSelf = user.id === currentUserId;
                const ownerProtected =
                  user.role === "owner" && currentUserRole !== "owner";
                const canChangeRole = !isSelf && !ownerProtected;

                return (
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
                      <div className="flex flex-wrap items-center gap-2">
                        <RoleBadge role={user.role} />
                        <select
                          value={user.role}
                          onChange={(e) =>
                            void handleRoleChange(user, e.target.value as UserRole)
                          }
                          disabled={!canChangeRole || changingUserId === user.id}
                          aria-label={`Cambiar rol de ${user.full_name}`}
                          className="rounded-md border border-slate-200 bg-white px-2.5 py-1 text-xs text-slate-700 disabled:cursor-not-allowed disabled:opacity-50 dark:border-slate-700 dark:bg-slate-950/40 dark:text-slate-200"
                        >
                          {ROLE_OPTIONS.map((option) => (
                            <option
                              key={option.value}
                              value={option.value}
                              disabled={
                                option.value === "owner" && currentUserRole !== "owner"
                              }
                            >
                              {option.label}
                            </option>
                          ))}
                        </select>
                        {!canChangeRole && (
                          <span className="text-xs text-slate-400">
                            {isSelf ? "Tu usuario" : "Bloqueado"}
                          </span>
                        )}
                      </div>
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
                );
              })
            )}
          </tbody>
        </table>
      </div>
    </>
  );
}
