/**
 * AdminUsersClient — client component for the admin users page.
 *
 * Handles:
 *   - Fetching full user list (with emails) from GET /api/admin/users
 *   - Create user dialog (POST /api/admin/users)
 *   - Role badge display
 *   - Dar de baja (DELETE /api/admin/users/:id) y volver a habilitar (PATCH)
 *   - Toast notifications
 */

"use client";

import { useEffect, useRef, useState, useCallback, type FormEvent, type RefObject } from "react";

import { useDialogoModal } from "../../_components/dialogo-modal";
import { useT, useLocale } from "@/lib/i18n/LocaleContext";
import { textoDeSesionesCerradas } from "@/lib/i18n/sesiones-cerradas";
import { REINTENTO_SIN_CONTADOR_MS } from "@/lib/rate-limit/espera";
import { formatDate } from "@/lib/utils";

interface UserRow {
  id: string;
  full_name: string;
  email: string;
  role: UserRole;
  created_at: string;
  /** null = activo. Sin el dato (la lista del servidor) no se pinta el estado. */
  dado_de_baja_en?: string | null;
}

type UserRole = "owner" | "admin" | "specialist" | "analyst" | "viewer";

/** El `t` de los ayudantes que viven fuera del componente y lo reciben por parámetro. */
type Translate = ReturnType<typeof useT>;

interface Props {
  initialUsers: UserRow[];
  currentUserId: string;
  currentUserRole: string;
  emailAyuda: string;
  /** Cuántas filas deja armar el diálogo de una vez: el tope de invitaciones del día. */
  topeDelLote: number;
}

// ── Role badge ────────────────────────────────────────────────────────────────

const ROLE_STYLES: Record<string, string> = {
  owner: "bg-amber-100 text-amber-800",
  admin: "bg-red-100 text-red-800",
  specialist: "bg-purple-100 text-purple-800",
  analyst: "bg-blue-100 text-blue-800",
  viewer: "bg-slate-100 text-slate-700",
};

/*
 * El orden en que se ofrecen los roles en los dos desplegables. Los rótulos ya
 * no viven acá: los pone `roleLabel`, que necesita el idioma elegido.
 */
const ROLE_ORDER: UserRole[] = ["analyst", "specialist", "viewer", "admin", "owner"];

function roleLabel(role: string, t: Translate): string {
  switch (role) {
    case "owner":
      return t("usuarios.rol.owner");
    case "admin":
      return t("usuarios.rol.admin");
    case "specialist":
      return t("usuarios.rol.specialist");
    case "analyst":
      return t("usuarios.rol.analyst");
    case "viewer":
      return t("usuarios.rol.viewer");
    default:
      return role;
  }
}

function RoleBadge({ role }: { role: string }) {
  const t = useT();
  const styles = ROLE_STYLES[role] ?? "bg-slate-100 text-slate-800";
  const label = roleLabel(role, t);
  return (
    <span
      className={`inline-flex items-center rounded-full px-2.5 py-0.5 text-xs font-medium ${styles}`}
    >
      {label}
    </span>
  );
}

async function readApiError(res: Response, fallback: string): Promise<string> {
  const data = await res.json().catch(() => null);
  return data?.error?.message ?? fallback;
}

// ── Create user dialog ────────────────────────────────────────────────────────

/** Lo que el diálogo le cuenta al padre al terminar el lote. */
interface ResumenDelLote {
  hechas: number;
  rechazadas: number;
  sinCupo: number;
}

/** `aviso` es lo último que dijo el envío sobre la fila: el 422 del servidor, «sin cupo», «repetido». */
interface Fila {
  id: number;
  aviso?: string;
}

/** Los campos del diálogo, el selector de rol incluido, comparten estilo. */
const campo =
  "w-full rounded-md border border-slate-200 px-3 py-2 text-sm text-slate-900 focus:border-slate-400 focus:outline-none disabled:opacity-50";

function FilaDeInvitacion({
  fila,
  n,
  correoRef,
  quitar,
  enviando,
}: {
  fila: Fila;
  n: number;
  correoRef?: RefObject<HTMLInputElement | null>;
  quitar?: () => void;
  enviando: boolean;
}) {
  const t = useT();
  return (
    <div className="grid gap-2 sm:grid-cols-[1fr_1fr_auto]">
      <div>
        <label
          htmlFor={`full_name-${fila.id}`}
          className="mb-1 block text-xs font-medium text-slate-600"
        >
          {t("usuarios.form.nombre")}
        </label>
        <input
          id={`full_name-${fila.id}`}
          name="full_name"
          type="text"
          required
          minLength={2}
          maxLength={100}
          autoFocus={fila.id > 0}
          disabled={enviando}
          className={campo}
          placeholder={t("usuarios.form.nombrePlaceholder")}
        />
      </div>
      <div>
        <label
          htmlFor={`email-${fila.id}`}
          className="mb-1 block text-xs font-medium text-slate-600"
        >
          {t("usuarios.form.email")}
        </label>
        <input
          ref={correoRef}
          id={`email-${fila.id}`}
          name="email"
          type="email"
          required
          disabled={enviando}
          className={campo}
          placeholder={t("usuarios.form.emailPlaceholder")}
          aria-describedby="email-ayuda"
        />
      </div>
      {quitar && (
        <button
          type="button"
          onClick={quitar}
          disabled={enviando}
          aria-label={`${t("usuarios.lote.quitar")} ${n}`}
          className="self-end rounded-md px-3 py-2 text-sm text-slate-600 hover:bg-slate-100 disabled:opacity-50"
        >
          ×
        </button>
      )}
      {fila.aviso && (
        <p role="alert" className="text-xs text-red-700 sm:col-span-full">
          {fila.aviso}
        </p>
      )}
    </div>
  );
}

function CreateUserDialog({
  cerrar,
  onCreated,
  currentUserRole,
  emailAyuda,
  topeDelLote,
}: {
  cerrar: () => void;
  onCreated: (resumen: ResumenDelLote) => void;
  currentUserRole: string;
  emailAyuda: string;
  topeDelLote: number;
}) {
  const t = useT();
  const [filas, setFilas] = useState<Fila[]>([{ id: 0 }]);
  const [enviando, setEnviando] = useState(false);
  const proximoId = useRef(1);
  /*
   * Los correos ya aceptados. Después de un lote partido las filas hechas salen
   * de la lista, pero la misma dirección escrita de nuevo en otra fila no tiene
   * que volver a invitarse.
   */
  const enviados = useRef(new Set<string>());

  /*
   * Mientras envía no se cierra: la respuesta que vuelve necesita el diálogo para
   * marcar las filas. Escape y Cancelar pasan por acá.
   */
  const onClose = () => {
    if (!enviando) cerrar();
  };

  /*
   * El foco arranca en el correo, que es el primer campo que se llena.
   *
   * `useDialogoModal` se ocupa del resto: atrapa el Tab, cierra con Escape y
   * devuelve el foco al botón que abrió. Los otros cuatro diálogos de la app lo
   * usan desde hace tiempo; éste se quedó afuera.
   */
  const correoRef = useRef<HTMLInputElement>(null);
  const dialogRef = useDialogoModal<HTMLDivElement>(onClose, correoRef);

  /*
   * Quitar una fila o apagar los controles al enviar deja el foco en el aire; se
   * vuelve al primer correo. Va después del hook: en el montaje el foco ya lo
   * puso él y esto no hace nada.
   */
  useEffect(() => {
    if (!enviando && !dialogRef.current?.contains(document.activeElement)) {
      correoRef.current?.focus();
    }
  }, [enviando, filas.length, dialogRef]);

  function agregar() {
    const id = proximoId.current++;
    setFilas((prev) => [...prev, { id }]);
  }

  async function enviar(e: FormEvent<HTMLFormElement>) {
    e.preventDefault();
    if (enviando) return;
    // Un campo por fila y en el orden de `filas`: los `key` estables mantienen el orden del DOM.
    const datos = new FormData(e.currentTarget);
    const nombres = datos.getAll("full_name");
    const correos = datos.getAll("email");
    const role = datos.get("role");
    setEnviando(true);

    const avisos = new Map<number, string>();
    const hechas = new Set<number>();
    const vistos = new Set(enviados.current);
    let rechazadas = 0;
    let sinCupo = 0;
    for (let i = 0; i < filas.length; i++) {
      const fila = filas[i]!;
      const correo = String(correos[i]).trim().toLowerCase();
      if (vistos.has(correo)) {
        avisos.set(fila.id, t("usuarios.lote.repetido"));
        rechazadas++;
        continue;
      }
      vistos.add(correo);

      let res: Response;
      try {
        res = await fetch("/api/admin/users", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ full_name: nombres[i], email: correos[i], role }),
        });
      } catch {
        // No se sabe si el servidor llegó a tomar el cupo: no se sigue ni se reintenta.
        avisos.set(fila.id, t("usuarios.error.red"));
        rechazadas++;
        break;
      }

      if (res.ok) {
        enviados.current.add(correo);
        hechas.add(fila.id);
        continue;
      }
      /*
       * En Postgres los intentos rechazados también cuentan contra el cupo: al
       * primer 429 se corta, sin reintento. Si el contador no contestó el servidor
       * pide esperar a lo sumo un minuto: eso no es «sin cupo hoy», y lo que falta
       * queda con el mensaje del servidor entre las rechazadas.
       */
      if (res.status === 429) {
        const porHoy = Number(res.headers.get("Retry-After")) > REINTENTO_SIN_CONTADOR_MS / 1000;
        const aviso = porHoy ? t("usuarios.lote.sinCupo") : await readApiError(res, t("usuarios.error.crear"));
        for (const f of filas.slice(i)) avisos.set(f.id, aviso);
        if (porHoy) sinCupo = filas.length - i;
        else rechazadas += filas.length - i;
        break;
      }
      avisos.set(fila.id, await readApiError(res, t("usuarios.error.crear")));
      rechazadas++;
      /*
       * Sólo un 400 habla de esta fila y sigue: no tocó el cupo. El 422 de dominio sí lo
       * gastó (el servidor cuenta cada intento: probar direcciones ajenas no sale gratis), así
       * que seguir quemaría una invitación del día por fila. Lo demás (sesión, permiso,
       * remitente, error) vale para todas y seguir lo repetiría.
       */
      if (res.status !== 400) break;
    }

    const quedan = filas
      .filter((f) => !hechas.has(f.id))
      .map((f) => ({ id: f.id, aviso: avisos.get(f.id) }));
    setFilas(quedan);
    setEnviando(false);
    if (hechas.size + rechazadas + sinCupo > 0) {
      onCreated({ hechas: hechas.size, rechazadas, sinCupo });
    }
    if (quedan.length === 0) cerrar();
  }

  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center bg-black/40"
      role="dialog"
      aria-modal="true"
      aria-label={t("usuarios.invitar")}
    >
      {/*
        El quinto diálogo, que nunca recibió el arreglo de foco.

        Los otros cuatro usan `useDialogoModal`; éste declaraba `aria-modal` y
        no tenía nada: ni foco inicial, ni trampa de Tab, ni Escape, ni
        devolución del foco al cerrar. Con `aria-modal` puesto el lector de
        pantalla esconde todo lo de afuera, así que la persona quedaba parada
        en la nada — y es el formulario que crea usuarios con su rol.
      */}
      <div
        ref={dialogRef}
        className="max-h-[90vh] w-full max-w-xl overflow-y-auto rounded-lg bg-white p-6 shadow-xl"
      >
        <h2 className="mb-4 text-base font-semibold text-slate-900">
          {t("usuarios.invitar")}
        </h2>

        <form onSubmit={(e) => void enviar(e)} className="space-y-4">
          {filas.map((fila, i) => (
            <FilaDeInvitacion
              key={fila.id}
              fila={fila}
              n={i + 1}
              correoRef={i === 0 ? correoRef : undefined}
              quitar={i === 0 ? undefined : () => setFilas((prev) => prev.filter((f) => f.id !== fila.id))}
              enviando={enviando}
            />
          ))}
          <p id="email-ayuda" className="text-xs text-slate-500">
            {emailAyuda}
          </p>

          <button
            type="button"
            onClick={agregar}
            disabled={enviando || filas.length >= topeDelLote}
            className="rounded-md px-3 py-2 text-sm font-medium text-slate-700 hover:bg-slate-100 disabled:opacity-50"
          >
            + {t("usuarios.lote.agregar")}
          </button>

          <div>
            <label
              htmlFor="role"
              className="mb-1 block text-xs font-medium text-slate-600"
            >
              {t("usuarios.form.rol")}
            </label>
            <select
              id="role"
              name="role"
              defaultValue="analyst"
              disabled={enviando}
              className={campo}
            >
              {ROLE_ORDER.map((value) => (
                <option
                  key={value}
                  value={value}
                  disabled={value === "owner" && currentUserRole !== "owner"}
                >
                  {value === "viewer"
                    ? t("usuarios.rol.viewerSoloLectura")
                    : roleLabel(value, t)}
                </option>
              ))}
            </select>
          </div>

          <div className="flex justify-end gap-2 pt-2">
            <button
              type="button"
              onClick={onClose}
              disabled={enviando}
              className="rounded-md px-4 py-2 text-sm font-medium text-slate-600 hover:bg-slate-100 disabled:opacity-50"
            >
              {t("usuarios.cancelar")}
            </button>
            <button
              type="submit"
              disabled={enviando}
              className="rounded-md bg-slate-800 px-4 py-2 text-sm font-medium text-white hover:bg-slate-700 disabled:opacity-50"
            >
              {enviando ? t("usuarios.enviandoInvitacion") : t("usuarios.enviarInvitacion")}
            </button>
          </div>
        </form>
      </div>
    </div>
  );
}

// ── Main client component ─────────────────────────────────────────────────────

export function AdminUsersClient({
  initialUsers,
  currentUserId,
  currentUserRole,
  emailAyuda,
  topeDelLote,
}: Props) {
  const t = useT();
  const { locale } = useLocale();
  const [users, setUsers] = useState<UserRow[]>(initialUsers);
  const [showDialog, setShowDialog] = useState(false);
  const [loading, setLoading] = useState(true);
  const [toast, setToast] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [changingUserId, setChangingUserId] = useState<string | null>(null);
  const [closingSessionsId, setClosingSessionsId] = useState<string | null>(null);
  const [bajaId, setBajaId] = useState<string | null>(null);

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

  function handleCreated({ hechas, rechazadas, sinCupo }: ResumenDelLote) {
    setToast(
      hechas === 1 && rechazadas + sinCupo === 0
        ? t("usuarios.toast.creado")
        : t("usuarios.lote.resumen")
            .replace("{hechas}", String(hechas))
            .replace("{rechazadas}", String(rechazadas))
            .replace("{sinCupo}", String(sinCupo))
    );
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
        throw new Error(await readApiError(res, t("usuarios.error.rol")));
      }

      setUsers((prev) =>
        prev.map((item) => (item.id === user.id ? { ...item, role } : item))
      );
      setToast(t("usuarios.toast.rolActualizado"));
      setTimeout(() => setToast(null), 4000);
    } catch (err) {
      setError(err instanceof Error ? err.message : t("usuarios.error.rol"));
    } finally {
      setChangingUserId(null);
    }
  }

  async function handleCloseSessions(user: UserRow) {
    if (!window.confirm(t("usuarios.cerrarSesionesConfirmar").replace("{nombre}", user.full_name))) {
      return;
    }
    setError(null);
    setClosingSessionsId(user.id);
    try {
      const res = await fetch(`/api/admin/users/${user.id}/sessions`, { method: "DELETE" });

      if (!res.ok) {
        throw new Error(await readApiError(res, t("usuarios.error.sesiones")));
      }

      const data = await res.json().catch(() => null);
      setToast(textoDeSesionesCerradas(t, data?.sesiones_cerradas ?? 0));
      setTimeout(() => setToast(null), 4000);
    } catch (err) {
      setError(err instanceof Error ? err.message : t("usuarios.error.sesiones"));
    } finally {
      setClosingSessionsId(null);
    }
  }

  async function handleBaja(user: UserRow, baja: boolean) {
    if (
      baja &&
      !window.confirm(t("usuarios.darDeBajaConfirmar").replace("{nombre}", user.full_name))
    ) {
      return;
    }
    setError(null);
    setBajaId(user.id);
    try {
      const res = await fetch(
        `/api/admin/users/${user.id}`,
        baja
          ? { method: "DELETE" }
          : {
              method: "PATCH",
              headers: { "Content-Type": "application/json" },
              body: JSON.stringify({ activo: true }),
            }
      );

      if (!res.ok) {
        throw new Error(await readApiError(res, t("usuarios.error.baja")));
      }

      const data = await res.json().catch(() => null);
      const dado_de_baja_en: string | null =
        data?.user?.dado_de_baja_en ?? (baja ? new Date().toISOString() : null);
      setUsers((prev) =>
        prev.map((item) => (item.id === user.id ? { ...item, dado_de_baja_en } : item))
      );
      setToast(t(baja ? "usuarios.toast.dadoDeBaja" : "usuarios.toast.habilitado"));
      setTimeout(() => setToast(null), 4000);
    } catch (err) {
      setError(err instanceof Error ? err.message : t("usuarios.error.baja"));
    } finally {
      setBajaId(null);
    }
  }

  return (
    <>
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
          cerrar={() => setShowDialog(false)}
          onCreated={handleCreated}
          currentUserRole={currentUserRole}
          emailAyuda={emailAyuda}
          topeDelLote={topeDelLote}
        />
      )}

      {/* Toast: después del diálogo, para que si éste sigue abierto el telón no lo tape */}
      {toast && (
        <div
          role="status"
          aria-live="polite"
          className="fixed bottom-4 right-4 z-50 rounded-lg bg-slate-800 px-4 py-3 text-sm text-white shadow-lg"
        >
          {toast}
        </div>
      )}

      {/* Table header with action */}
      <div className="mb-4 flex items-center justify-end">
        <button
          onClick={() => setShowDialog(true)}
          className="rounded-md bg-slate-800 px-4 py-2 text-sm font-medium text-white hover:bg-slate-700"
        >
          + {t("usuarios.invitar")}
        </button>
      </div>

      {/* Users table */}
      <div className="rounded-lg border border-slate-200 bg-white">
        <table className="w-full text-sm">
          <thead>
            <tr className="border-b border-slate-100 bg-slate-50 text-xs font-medium uppercase tracking-wide text-slate-500">
              <th className="px-5 py-3 text-left">{t("usuarios.col.nombre")}</th>
              <th className="px-5 py-3 text-left">{t("usuarios.col.email")}</th>
              <th className="px-5 py-3 text-left">{t("usuarios.col.rol")}</th>
              <th className="px-5 py-3 text-left">{t("usuarios.col.estado")}</th>
              <th className="px-5 py-3 text-left">{t("usuarios.col.creado")}</th>
            </tr>
          </thead>
          <tbody>
            {loading && users.length === 0 ? (
              <tr>
                <td colSpan={5} className="px-5 py-8 text-center text-slate-500">
                  {t("usuarios.cargando")}
                </td>
              </tr>
            ) : users.length === 0 ? (
              <tr>
                <td colSpan={5} className="px-5 py-8 text-center text-slate-500">
                  {t("usuarios.vacio")}
                </td>
              </tr>
            ) : (
              users.map((user) => {
                const isSelf = user.id === currentUserId;
                const ownerProtected =
                  user.role === "owner" && currentUserRole !== "owner";
                const canChangeRole = !isSelf && !ownerProtected;
                const deBaja = Boolean(user.dado_de_baja_en);

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
                          aria-label={`${t("usuarios.cambiarRol")} ${user.full_name}`}
                          className="rounded-md border border-slate-200 bg-white px-2.5 py-1 text-xs text-slate-700 disabled:cursor-not-allowed disabled:opacity-50 dark:border-slate-700 dark:bg-slate-950/40 dark:text-slate-200"
                        >
                          {ROLE_ORDER.map((value) => (
                            <option
                              key={value}
                              value={value}
                              disabled={
                                value === "owner" && currentUserRole !== "owner"
                              }
                            >
                              {roleLabel(value, t)}
                            </option>
                          ))}
                        </select>
                        {!canChangeRole && (
                          <span className="text-xs text-slate-500">
                            {isSelf ? t("usuarios.propio") : t("usuarios.bloqueado")}
                          </span>
                        )}
                        {canChangeRole && !deBaja && (
                          <button
                            type="button"
                            onClick={() => void handleCloseSessions(user)}
                            disabled={closingSessionsId === user.id}
                            className="rounded-md border border-slate-200 px-2.5 py-1 text-xs text-slate-700 hover:bg-slate-50 disabled:cursor-not-allowed disabled:opacity-50 dark:border-slate-700 dark:text-slate-200 dark:hover:bg-slate-900"
                          >
                            {closingSessionsId === user.id
                              ? t("usuarios.cerrandoSesiones")
                              : t("usuarios.cerrarSesiones")}
                          </button>
                        )}
                        {canChangeRole && user.dado_de_baja_en !== undefined && (
                          <button
                            type="button"
                            onClick={() => void handleBaja(user, !deBaja)}
                            disabled={bajaId === user.id}
                            className="rounded-md border border-slate-200 px-2.5 py-1 text-xs text-slate-700 hover:bg-slate-50 disabled:cursor-not-allowed disabled:opacity-50 dark:border-slate-700 dark:text-slate-200 dark:hover:bg-slate-900"
                          >
                            {bajaId === user.id
                              ? t(deBaja ? "usuarios.habilitando" : "usuarios.dandoDeBaja")
                              : t(deBaja ? "usuarios.habilitar" : "usuarios.darDeBaja")}
                          </button>
                        )}
                      </div>
                    </td>
                    <td className="px-5 py-3">
                      {user.dado_de_baja_en !== undefined && (
                        <span
                          className={`inline-flex items-center rounded-full px-2.5 py-0.5 text-xs font-medium ${
                            deBaja ? "bg-slate-100 text-slate-700" : "bg-green-100 text-green-800"
                          }`}
                        >
                          {t(deBaja ? "usuarios.deBaja" : "usuarios.activo")}
                        </span>
                      )}
                    </td>
                    <td className="px-5 py-3 text-slate-500">
                      {formatDate(user.created_at, locale)}
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
