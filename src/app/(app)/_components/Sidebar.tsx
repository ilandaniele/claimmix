"use client";

import Link from "next/link";
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
        className="flex cursor-not-allowed items-center gap-2.5 rounded-md px-3 py-2 text-slate-300 dark:text-slate-600"
      >
        <Icon size={14} className="text-slate-300 dark:text-slate-600" />
        <span className="text-[13px] font-medium">{label}</span>
        <Lock size={12} className="ml-auto text-slate-300 dark:text-slate-600" />
      </div>
    );
  }

  return (
    <Link
      href={href}
      className={[
        "flex items-center gap-2.5 rounded-md px-3 py-2 transition-colors",
        isActive
          ? "bg-indigo-50 text-indigo-600 dark:bg-indigo-950/40 dark:text-indigo-400"
          : "text-slate-600 hover:bg-slate-100 hover:text-slate-900 dark:text-slate-400 dark:hover:bg-slate-800 dark:hover:text-slate-100",
      ].join(" ")}
    >
      <Icon
        size={14}
        className={
          isActive
            ? "text-indigo-600 dark:text-indigo-400"
            : "text-slate-400 dark:text-slate-500"
        }
      />
      <span className="text-[13px] font-medium">{label}</span>
    </Link>
  );
}

export function Sidebar({ role }: { role: string }) {
  const t = useT();
  const canUseAgent = role === "owner" || role === "admin";

  const operacionItems: NavItemDef[] = [
    { label: t("nav.bandeja") || "Bandeja", href: "/bandeja", icon: Inbox },
    { label: t("nav.escalados") || "Escalados", href: "/escalados", icon: AlertTriangle },
    { label: t("nav.clientes") || "Clientes", href: "/clientes", icon: Users },
  ];

  const analisisItems: NavItemDef[] = [
    { label: t("nav.metricas") || "Métricas", href: "/metricas", icon: BarChart2 },
    { label: "Demo", href: "/demo", icon: Play },
    {
      label: "Agente",
      href: "/agente",
      icon: Brain,
      disabled: !canUseAgent,
      disabledReason: "Solo administradores pueden abrir la consola del agente.",
    },
    { label: t("nav.admin") || "Usuarios", href: "/admin/users", icon: Shield },
  ];

  return (
    <nav
      aria-label="Navegación principal"
      className="flex h-full w-[220px] flex-shrink-0 flex-col border-r border-[#EEF0F3] bg-white dark:border-[#1E2D45] dark:bg-[#0F1929]"
    >
      {/* Logo / brand */}
      <div className="flex h-14 items-center gap-2.5 px-4">
        <div className="flex h-7 w-7 flex-shrink-0 items-center justify-center rounded-md bg-indigo-600 text-xs font-bold text-white">
          CM
        </div>
        <span className="text-sm font-semibold text-slate-900 dark:text-slate-100">
          ClaimMix
        </span>
      </div>

      {/* Navigation links */}
      <div className="flex flex-1 flex-col overflow-y-auto px-2 py-3">
        {/* OPERACIÓN section */}
        <div className="mb-4">
          <p className="mb-1.5 px-3 text-[10px] font-semibold uppercase tracking-wider text-slate-400">
            OPERACIÓN
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
          <p className="mb-1.5 px-3 text-[10px] font-semibold uppercase tracking-wider text-slate-400">
            ANÁLISIS
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
