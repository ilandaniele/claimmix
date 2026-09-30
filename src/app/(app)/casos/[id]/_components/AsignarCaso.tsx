/**
 * Quién tiene el caso y cómo cambiarlo (B9).
 *
 * Owner, admin y specialist eligen a cualquier persona del equipo, con la carga
 * de cada una a la vista; un analista sólo toma un caso libre o suelta uno
 * suyo. Es un espejo de `puedeAsignar`: la decisión es de la ruta, esto sólo
 * evita ofrecer lo que ella rechazaría.
 *
 * Usa el mismo PATCH del caso que el resto de la ficha. Con un 403 o un 404
 * —otro se llevó el caso mientras la pantalla estaba abierta— refresca para
 * mostrar quién lo tiene ahora.
 */

"use client";

import { useRouter } from "next/navigation";
import { useState } from "react";
import { asignaATerceros } from "@/lib/auth/roles";
import { useT } from "@/lib/i18n/LocaleContext";
import type { PersonaConCarga } from "@/server/cases/efectos-de-transicion";

interface AsignarCasoProps {
  caseId: string;
  rol: string;
  miId: string;
  asignadoA: string | null;
  /** `null` si nadie lo tiene o no se pudo leer el nombre. */
  nombreAsignado: string | null;
  /** Vacía para quien no asigna a terceros. */
  carga: PersonaConCarga[];
}

export function AsignarCaso({ caseId, rol, miId, asignadoA, nombreAsignado, carga }: AsignarCasoProps) {
  const t = useT();
  const router = useRouter();
  const [pendiente, setPendiente] = useState(false);
  const [fallo, setFallo] = useState(false);

  async function asignar(destino: string | null) {
    setPendiente(true);
    setFallo(false);
    try {
      const res = await fetch(`/api/cases/${caseId}`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ assigned_to: destino }),
      });
      if (!res.ok) setFallo(true);
      router.refresh();
    } catch {
      setFallo(true);
    } finally {
      setPendiente(false);
    }
  }

  const nombre = asignadoA ? (nombreAsignado ?? t("case.detail.assigned")) : t("case.detail.unassigned");

  return (
    <div className="flex flex-wrap items-center gap-2">
      {asignaATerceros(rol) ? (
        <select
          aria-label={t("asignar.rotulo")}
          value={asignadoA ?? ""}
          disabled={pendiente}
          onChange={(e) => void asignar(e.target.value || null)}
          className="max-w-full rounded-md border border-slate-300 bg-white px-2 py-1 text-sm text-slate-900 disabled:opacity-50"
        >
          <option value="">{t("case.detail.unassigned")}</option>
          {/* Quien lo tiene puede haber dejado de editar: su opción no desaparece del select. */}
          {asignadoA && !carga.some((p) => p.id === asignadoA) && <option value={asignadoA}>{nombre}</option>}
          {carga.map((p) => (
            <option key={p.id} value={p.id}>
              {t("asignar.opcion").replace("{nombre}", p.full_name).replace("{n}", String(p.abiertos))}
            </option>
          ))}
        </select>
      ) : (
        <>
          <span>{nombre}</span>
          {(asignadoA === null || asignadoA === miId) && (
            <button
              type="button"
              disabled={pendiente}
              onClick={() => void asignar(asignadoA === null ? miId : null)}
              className="rounded-md px-2 py-1 text-[13px] font-medium text-violet-700 transition-colors hover:bg-violet-50 disabled:opacity-50"
            >
              {t(asignadoA === null ? "asignar.tomar" : "asignar.soltar")}
            </button>
          )}
        </>
      )}
      {fallo && (
        <p role="alert" className="w-full text-[12.5px] text-red-600">
          {t("asignar.error")}
        </p>
      )}
    </div>
  );
}
