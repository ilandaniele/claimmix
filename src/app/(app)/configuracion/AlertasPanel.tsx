"use client";

import { useState } from "react";

import { useT } from "@/lib/i18n/LocaleContext";

interface Props {
  inicial: string[];
}

/**
 * La lista de avisos de casos urgentes de este tenant, editable por un admin.
 *
 * El servidor es el único que valida (dirección vedada, tope de 10, formato):
 * este panel no importa `@/lib/email/reserved` ni ningún módulo de servidor,
 * para no cargar peso al cliente que no le sirve para nada acá.
 */
export function AlertasPanel({ inicial }: Props) {
  const [texto, setTexto] = useState(inicial.join("\n"));
  const [estado, setEstado] = useState<"idle" | "guardando" | "ok" | "error">("idle");
  const [motivo, setMotivo] = useState<string | null>(null);
  const t = useT();

  async function guardar() {
    setEstado("guardando");
    setMotivo(null);
    try {
      const res = await fetch("/api/admin/alertas", {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          emails: texto.split(/[\n,]/).map((s) => s.trim()).filter(Boolean),
        }),
      });
      if (res.ok) {
        const { emails } = await res.json();
        setTexto(emails.join("\n"));
        setEstado("ok");
      } else {
        const cuerpo = await res.json().catch(() => null);
        setMotivo(cuerpo?.error?.message ?? null);
        setEstado("error");
      }
    } catch {
      setEstado("error");
    }
  }

  return (
    <div className="space-y-2">
      <textarea
        rows={4}
        value={texto}
        onChange={(e) => setTexto(e.target.value)}
        aria-label={t("configuracion.alertas.titulo")}
        aria-describedby="alertas-ayuda"
        className="w-full rounded border border-slate-300 bg-white px-3 py-1.5 text-sm text-slate-800 focus:border-blue-500 focus:outline-none"
      />
      <p id="alertas-ayuda" className="text-xs text-slate-500">
        {t("configuracion.alertas.ayuda")}
      </p>
      <button
        onClick={guardar}
        disabled={estado === "guardando"}
        className="rounded bg-blue-600 px-3 py-1.5 text-xs font-medium text-white hover:bg-blue-700 disabled:opacity-50"
      >
        {t(estado === "guardando" ? "claveIa.guardando" : "claveIa.guardar")}
      </button>
      {(estado === "ok" || estado === "error") && (
        <p
          role="status"
          className={estado === "ok" ? "text-xs text-emerald-600" : "text-xs text-red-500"}
        >
          {t(estado === "ok" ? "configuracion.alertas.guardadas" : "configuracion.alertas.error")}
          {estado === "error" && motivo && ` ${motivo}`}
        </p>
      )}
    </div>
  );
}
