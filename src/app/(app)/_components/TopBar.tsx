"use client";

import { useFormStatus } from "react-dom";
import { LogOut } from "lucide-react";
import { LanguageSwitcher } from "@/components/LanguageSwitcher";
import { ThemeToggle } from "@/components/ThemeToggle";
import { useT } from "@/lib/i18n/LocaleContext";
import { signOut } from "@/app/login/actions";

interface TopBarProps {
  fullName: string;
  role: string;
}

function getInitials(name: string): string {
  return name
    .split(" ")
    .filter(Boolean)
    .slice(0, 2)
    .map((n) => n[0]?.toUpperCase() ?? "")
    .join("");
}

/*
 * El boton de salir, con su espera visible.
 *
 * Va aparte porque `useFormStatus` solo lee el formulario que lo CONTIENE:
 * puesto en `TopBar` no ve nada. Es la unica razon de que exista.
 *
 * Mientras el servidor cierra la sesion el boton se deshabilita y muestra que
 * esta trabajando. Antes no mostraba nada: un icono de 28px que al apretarlo
 * no cambiaba, y del otro lado un viaje a Neon que en el plan gratuito puede
 * tardar unos segundos. Eso se lee como «aprete y no paso nada», y la persona
 * vuelve a apretar.
 */
function BotonSalir({ etiqueta }: { etiqueta: string }) {
  const { pending } = useFormStatus();
  return (
    <button
      type="submit"
      disabled={pending}
      aria-busy={pending}
      aria-label={etiqueta}
      data-testid="signout-button"
      className="flex h-9 w-9 items-center justify-center rounded-md text-slate-400 transition-colors hover:bg-slate-100 hover:text-slate-900 disabled:cursor-wait disabled:opacity-60 dark:hover:bg-slate-800 dark:hover:text-slate-100"
    >
      {pending ? (
        <span
          className="h-4 w-4 animate-spin rounded-full border-2 border-current border-t-transparent"
          aria-hidden="true"
        />
      ) : (
        <LogOut size={16} aria-hidden="true" />
      )}
    </button>
  );
}

export function TopBar({ fullName, role }: TopBarProps) {
  const t = useT();

  const initials = getInitials(fullName);
  const isAdmin = role === "admin" || role === "owner";
  const roleLabel =
    role === "owner"
      ? "Owner"
      : role === "admin"
        ? t("role.admin") || "Administrador"
        : role === "specialist"
          ? "Especialista"
          : role === "viewer"
            ? "Visor"
            : t("role.analyst") || "Analista";

  return (
    <header className="flex h-16 flex-shrink-0 items-center justify-end px-6">
      <div className="flex items-center gap-2">
        <ThemeToggle />
        <LanguageSwitcher />

        {/* divider */}
        <div className="mx-1 h-5 w-px bg-slate-200" />

        {/* Avatar */}
        <div
          aria-label={`Avatar ${fullName}`}
          className="flex h-8 w-8 flex-shrink-0 select-none items-center justify-center rounded-full bg-violet-600 text-xs font-semibold text-white"
        >
          {initials}
        </div>

        {/* Full name — hidden on mobile */}
        <span className="hidden text-sm font-medium text-slate-900 sm:inline dark:text-slate-100">
          {fullName}
        </span>

        {/* Role badge */}
        <span
          className={[
            "hidden rounded-full px-2 py-0.5 text-[12px] font-medium sm:inline",
            isAdmin
              ? "bg-violet-50 text-violet-700"
              : "bg-slate-100 text-slate-600",
          ].join(" ")}
        >
          {roleLabel}
        </span>

        {/*
          * Por la accion de servidor y no por `authClient.signOut()`.
          *
          * El camino de cliente hacia dos cosas mal. Cerraba la sesion sin
          * pasar por `signOut` de `login/actions.ts`, que es el que escribe
          * AUTH_SIGN_OUT en la auditoria: ningun cierre de sesion desde esta
          * barra quedo registrado nunca. Y despues navegaba con `router.push`
          * mas `router.refresh` desde el cliente, una carrera contra la cookie
          * que se acababa de borrar. La accion de servidor audita y redirige
          * en el mismo pedido.
          */}
        <form action={signOut}>
          <BotonSalir etiqueta={t("nav.signOut") || "Cerrar sesión"} />
        </form>
      </div>
    </header>
  );
}
