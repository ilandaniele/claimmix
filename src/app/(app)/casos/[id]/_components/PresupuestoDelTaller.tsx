"use client";

/**
 * El presupuesto del taller de un adjunto, leído a pedido (B21).
 *
 * Lo pide una persona del equipo con el botón; la lectura y las alertas quedan
 * guardadas en el adjunto. Nada de esto sale al asegurado.
 */

import { useState } from "react";
import { useRouter } from "next/navigation";

import { esMotivoSinLeer } from "@/core/ai/sin-leer";
import type { LecturaGuardada } from "@/core/case/presupuesto-taller";
import type { ClaveDelCliente } from "@/lib/i18n";
import { useT } from "@/lib/i18n/LocaleContext";
import { formatArs } from "@/lib/utils";

interface Props {
  caseId: string;
  attachmentId: string;
  inicial: LecturaGuardada | null;
  puedeLeer: boolean;
}

export function PresupuestoDelTaller({ caseId, attachmentId, inicial, puedeLeer }: Props) {
  const t = useT();
  const router = useRouter();
  const [lectura, setLectura] = useState(inicial);
  const [estado, setEstado] = useState<"idle" | "leyendo">("idle");
  const [aviso, setAviso] = useState<ClaveDelCliente | null>(null);

  async function leer() {
    setEstado("leyendo");
    setAviso(null);
    try {
      const res = await fetch(`/api/cases/${caseId}/attachments/${attachmentId}/presupuesto`, { method: "POST" });
      const cuerpo = await res.json().catch(() => null);
      const motivo: unknown = cuerpo?.motivo;
      if (res.ok && cuerpo?.leido) {
        setLectura(cuerpo.lectura_presupuesto);
        router.refresh();
      } else {
        setAviso(res.ok && esMotivoSinLeer(motivo) ? `lectura.sinLeer.${motivo}` : "presupuesto.error");
      }
    } catch {
      setAviso("presupuesto.error");
    } finally {
      setEstado("idle");
    }
  }

  if (!lectura && !puedeLeer) return null;
  const importe = (n: number) => (lectura?.lectura.moneda === "ARS" ? formatArs(n) : n.toLocaleString("es-AR"));
  const alertasDelItem = (i: number) => lectura?.alertas.filter((a) => a.item === i) ?? [];
  const alertasGenerales = lectura?.alertas.filter((a) => a.item === undefined) ?? [];

  return (
    <div className="mt-2 space-y-2 rounded-md border border-slate-200 bg-slate-50 px-3 py-2 text-xs">
      {lectura && (
        <>
          <p className="font-medium text-slate-700">{t("presupuesto.titulo")}</p>
          <ul className="space-y-0.5">
            {lectura.lectura.items.map((item, i) => (
              <li key={i} className="flex flex-wrap items-baseline gap-x-2">
                <span className="text-slate-700">{item.descripcion || "—"}</span>
                <span className="font-mono text-slate-800">{importe(item.importe)}</span>
                {alertasDelItem(i).map((a) => (
                  <span key={a.codigo} className="rounded bg-amber-100 px-1.5 py-0.5 text-[11px] text-amber-800">
                    {t(`presupuesto.alerta.${a.codigo}`)}
                  </span>
                ))}
              </li>
            ))}
          </ul>
          {lectura.lectura.total !== null && (
            <p className="text-slate-700">
              {t("presupuesto.total")}: <span className="font-mono">{importe(lectura.lectura.total)}</span>
            </p>
          )}
          {alertasGenerales.length > 0 && (
            <ul className="space-y-0.5 text-amber-800">
              {alertasGenerales.map((a) => (
                <li key={a.codigo}>· {t(`presupuesto.alerta.${a.codigo}`)}</li>
              ))}
            </ul>
          )}
        </>
      )}
      {puedeLeer && (
        <button
          onClick={() => void leer()}
          disabled={estado === "leyendo"}
          className="rounded border border-slate-300 bg-white px-2.5 py-1 font-medium text-slate-700 hover:bg-slate-100 disabled:opacity-50"
        >
          {t(estado === "leyendo" ? "presupuesto.leyendo" : lectura ? "presupuesto.releer" : "presupuesto.leer")}
        </button>
      )}
      {aviso && (
        <p role="status" className="text-amber-800">
          {t(aviso)}
        </p>
      )}
    </div>
  );
}
