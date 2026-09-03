"use client";

import Link from "next/link";

import { CUSTOMER_PII_ROLES } from "@/lib/auth/roles";
import { usePathname } from "next/navigation";
import { useT } from "@/lib/i18n/LocaleContext";
import {
  Inbox,
  AlertTriangle,
  Users,
  BarChart2,
  Settings,
  Shield,
  Brain,
  Lock,
  Play,
  Receipt,
  Briefcase,
} from "lucide-react";
import type { LucideIcon } from "lucide-react";

interface NavItemDef {
  label: string;
  href: string;
  icon: LucideIcon;
  disabled?: boolean;
  disabledReason?: string;
}

function NavLink({ href, label, icon: Icon, disabled, disabledReason }: NavItemDef) {
  const pathname = usePathname();
  const isActive = pathname === href || pathname.startsWith(href + "/");

  if (disabled) {
    return (
      <div
        aria-disabled="true"
        title={disabledReason}
        /*
         * El ítem deshabilitado tiene que verse MENOS que los habilitados, y
         * durante un tiempo se vio más.
         *
         * La causa no estaba acá: `dark:text-slate-600` estaba escrito, pero el
         * variante `dark:` de Tailwind seguía al tema del SISTEMA y no a la
         * clase `.dark` que pone el botón del producto, así que en una máquina
         * con el sistema en claro no llegaba nunca y quedaba el
         * `text-slate-300` del modo claro: gris clarito sobre fondo oscuro.
         *
         * Se arregló en `globals.css` con `@custom-variant dark`, que es de
         * dónde salía el problema. Las dos clases de acá son correctas y ahora
         * además se aplican.
         */
        className="flex cursor-not-allowed items-center gap-3 rounded-xl px-3 py-2.5 text-slate-300 dark:text-slate-600"
      >
        <Icon size={17} className="text-slate-300 dark:text-slate-600" />
        <span className="text-[13.5px]">{label}</span>
        <Lock size={12} className="ml-auto text-slate-300 dark:text-slate-600" />
      </div>
    );
  }

  return (
    <Link
      href={href}
      className={[
        // El anillo de foco, con el acento nuevo. `focus-visible` y no `focus`:
        // así aparece para quien navega con teclado y no en cada clic del mouse.
        "flex items-center gap-3 rounded-xl px-3 py-2.5 transition-colors",
        "focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-violet-500 focus-visible:ring-offset-1",
        isActive
          ? "bg-violet-50 text-violet-700 font-semibold"
          : "text-slate-600 hover:bg-slate-100 hover:text-slate-900",
      ].join(" ")}
    >
      <Icon
        size={17}
        className={
          isActive
            ? "text-violet-700"
            : "text-slate-400"
        }
      />
      <span className="text-[13.5px]">{label}</span>
    </Link>
  );
}

export function Sidebar({
  role,
  isOperator = false,
}: {
  role: string;
  /** Quien opera ClaimMix, no el asegurador. Ve la cartera de clientes. */
  isOperator?: boolean;
}) {
  const t = useT();
  const canUseAgent = role === "owner" || role === "admin";
  const puedeVerClientes = (CUSTOMER_PII_ROLES as string[]).includes(role);

  const operacionItems: NavItemDef[] = [
    { label: t("nav.bandeja") || "Bandeja", href: "/bandeja", icon: Inbox },
    { label: t("nav.escalados") || "Escalados", href: "/escalados", icon: AlertTriangle },
    /*
     * «Clientes» sólo para quien puede ver datos personales.
     *
     * Estaba sin condición, así que un analista y un viewer lo veían en la barra
     * permanente, lo apretaban, y `clientes/page.tsx` los mandaba de vuelta a
     * /bandeja sin decir nada. Un enlace que siempre está y nunca funciona se
     * lee como que el producto está roto, no como que no les corresponde.
     *
     * Se esconde y no se deshabilita —al revés que «Agente», que sí se
     * deshabilita con su motivo— porque acá lo que está del otro lado son datos
     * personales de terceros. Que la pantalla exista no es algo que le tenga que
     * constar a alguien que no la puede abrir.
     *
     * Esto NO es la guarda: la guarda es el chequeo del servidor, que sigue
     * donde estaba. Esto es que el menú diga la verdad.
     */
    ...(puedeVerClientes
      ? [{ label: t("nav.clientes") || "Clientes", href: "/clientes", icon: Users }]
      : []),
  ];

  const analisisItems: NavItemDef[] = [
    { label: t("nav.metricas") || "Métricas", href: "/metricas", icon: BarChart2 },
    { label: t("nav.demo"), href: "/demo", icon: Play },
    {
      label: t("nav.agente"),
      href: "/agente",
      icon: Brain,
      disabled: !canUseAgent,
      disabledReason: t("nav.agenteBloqueado"),
    },
    { label: t("nav.admin") || "Usuarios", href: "/admin/users", icon: Shield },
    { label: t("nav.facturacion"), href: "/admin/facturacion", icon: Receipt },
    // La cartera cruza tenants: la ve el operador, no el asegurador. Se
    // oculta en vez de deshabilitarse — que la pantalla exista tampoco es
    // algo que le tenga que constar a un cliente.
    ...(isOperator
      ? [{ label: t("nav.cartera"), href: "/admin/cartera", icon: Briefcase }]
      : []),
  ];

  return (
    <nav
      aria-label={t("nav.principal")}
      className="flex h-full w-[232px] flex-shrink-0 flex-col border-r border-slate-200"
    >
      {/* Logo / brand */}
      <div className="flex h-16 items-center gap-2.5 px-4">
        <div className="flex h-8 w-8 flex-shrink-0 items-center justify-center rounded-xl bg-violet-600 text-[11px] font-bold text-white">
          CM
        </div>
        <span className="text-[15px] font-semibold tracking-tight text-slate-900">
          ClaimMix
        </span>
      </div>

      {/* Navigation links */}
      <div className="flex flex-1 flex-col overflow-y-auto px-2 py-3">
        {/* OPERACIÓN section */}
        <div className="mb-4">
          {/* El `.rotulo` lo pone en mayúscula por CSS, así que la clave
              guarda «Operación» y no «OPERACIÓN»: el diccionario tiene el
              texto, la hoja de estilos la forma. */}
          <p className="rotulo mb-2 px-3 text-slate-500">
            {t("nav.operation")}
          </p>
          <div className="space-y-0.5">
            {operacionItems.map((item) => (
              <NavLink key={item.href} {...item} />
            ))}
          </div>
        </div>

        {/* Spacer */}
        <div className="flex-1" />

        {/* ANÁLISIS section */}
        <div className="mb-2">
          <p className="rotulo mb-2 px-3 text-slate-500">
            {t("nav.analisis")}
          </p>
          <div className="space-y-0.5">
            {analisisItems.map((item) => (
              <NavLink key={item.href} {...item} />
            ))}
          </div>
        </div>

        {/* Settings at bottom */}
        <div className="space-y-0.5 pb-2">
          <NavLink
            href="/configuracion"
            label={t("nav.configuracion") || "Configuración"}
            icon={Settings}
          />
        </div>
      </div>
    </nav>
  );
}
