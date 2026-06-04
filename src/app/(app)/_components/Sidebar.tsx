"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";
import { useT } from "@/lib/i18n/LocaleContext";

interface NavItem {
  label: string;
  href: string;
}

function NavLink({ href, label }: NavItem) {
  const pathname = usePathname();
  const isActive = pathname === href || pathname.startsWith(href + "/");

  return (
    <Link
      href={href}
      className={[
        "flex items-center rounded-md px-3 py-2 text-sm font-medium transition-colors",
        isActive
          ? "bg-slate-200 text-slate-900"
          : "text-slate-600 hover:bg-slate-100 hover:text-slate-900",
      ].join(" ")}
    >
      {label}
    </Link>
  );
}

export function Sidebar() {
  const t = useT();

  const navSections = [
    {
      label: "Operación",
      items: [
        { label: t("nav.bandeja"), href: "/bandeja" },
        { label: t("nav.escalados"), href: "/escalados" },
        { label: t("nav.clientes"), href: "/clientes" },
      ],
    },
  ];

  const navTopLevel: NavItem[] = [
    { label: t("nav.analisis"), href: "/analisis" },
    { label: t("nav.metricas"), href: "/metricas" },
    { label: t("nav.admin"), href: "/admin/users" },
    { label: t("nav.configuracion"), href: "/configuracion" },
  ];

  return (
    <nav
      aria-label="Navegación principal"
      className="flex h-full w-56 flex-col border-r border-slate-200 bg-slate-50"
    >
      {/* Logo / brand */}
      <div className="flex h-14 items-center border-b border-slate-200 px-4">
        <span className="text-base font-semibold text-slate-900">ClaimMix</span>
      </div>

      {/* Navigation links */}
      <div className="flex-1 overflow-y-auto px-2 py-4">
        {navSections.map((section) => (
          <div key={section.label} className="mb-4">
            <p className="mb-1 px-3 text-xs font-semibold uppercase tracking-wider text-slate-400">
              {section.label}
            </p>
            <div className="space-y-0.5">
              {section.items.map((item) => (
                <NavLink key={item.href} {...item} />
              ))}
            </div>
          </div>
        ))}

        <div className="my-3 border-t border-slate-200" />

        <div className="space-y-0.5">
          {navTopLevel.map((item) => (
            <NavLink key={item.href} {...item} />
          ))}
        </div>
      </div>
    </nav>
  );
}
