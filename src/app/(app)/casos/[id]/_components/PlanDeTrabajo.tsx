/**
 * El checklist de trabajo del caso (B11).
 *
 * Arriba los próximos pasos —los que faltan, en el orden del plan— y abajo los
 * hechos. Un paso con `auto` lo tilda solo el caso al entrar a ese estado y así
 * se rotula, pero una persona también puede tildarlo o destildarlo.
 *
 * Sin `puedeCambiarEstado` las casillas quedan a la vista y deshabilitadas: un
 * analista ve el plan de un caso ajeno, no lo toca. La ruta hace el mismo
 * chequeo; esto evita ofrecer una casilla que devolvería 404.
 */

"use client";

import { useRouter } from "next/navigation";
import { useOptimistic, useState, startTransition } from "react";
import { useT } from "@/lib/i18n/LocaleContext";
import type { PasoEnPantalla } from "@/server/cases/detail-view";

interface PlanDeTrabajoProps {
  caseId: string;
  pasos: PasoEnPantalla[];
  puedeCambiarEstado: boolean;
}

export function PlanDeTrabajo({ caseId, pasos, puedeCambiarEstado }: PlanDeTrabajoProps) {
  const t = useT();
  const router = useRouter();
  // La casilla responde ya, pero sólo mientras dura la transición: al terminar
  // vale lo que dice la página, así un cambio de otra persona no queda tapado.
  const [visibles, marcar] = useOptimistic(pasos, (actuales, cambio: { clave: string; hecho: boolean }) =>
    actuales.map((p) => (p.clave === cambio.clave ? { ...p, hecho: cambio.hecho } : p))
  );
  const [fallo, setFallo] = useState(false);

  function cambiar(clave: string, hecho: boolean) {
    setFallo(false);
    startTransition(async () => {
      marcar({ clave, hecho });
      let bien = false;
      try {
        const res = await fetch(`/api/cases/${caseId}/plan`, {
          method: "PATCH",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ clave, hecho }),
        });
        bien = res.ok;
      } catch {
        // Sin red vale lo mismo que un rechazo: la casilla vuelve a lo que dice el servidor.
      }
      if (!bien) setFallo(true);
      router.refresh();
    });
  }

  const fila = (p: PasoEnPantalla) => (
    <li key={p.clave} className="flex items-start gap-2">
      <label className={`flex items-start gap-2 text-sm text-slate-700 ${puedeCambiarEstado ? "cursor-pointer" : ""}`}>
        <input
          type="checkbox"
          checked={p.hecho}
          disabled={!puedeCambiarEstado}
          onChange={(e) => cambiar(p.clave, e.target.checked)}
          className="mt-0.5 h-4 w-4 rounded border-slate-300"
        />
        <span className={p.hecho ? "text-slate-500 line-through" : undefined}>{p.titulo}</span>
      </label>
      {p.auto && <span className="mt-0.5 shrink-0 text-[11px] uppercase tracking-wide text-slate-400">{t("planDeTrabajo.automatico")}</span>}
    </li>
  );

  const proximos = visibles.filter((p) => !p.hecho);
  const hechos = visibles.filter((p) => p.hecho);

  return (
    <div className="space-y-4">
      {proximos.length > 0 && (
        <div>
          <p className="rotulo text-slate-500">{t("planDeTrabajo.proximos")}</p>
          <ul className="mt-1 space-y-1.5">{proximos.map(fila)}</ul>
        </div>
      )}
      {hechos.length > 0 && (
        <div>
          <p className="rotulo text-slate-500">{t("planDeTrabajo.hechos")}</p>
          <ul className="mt-1 space-y-1.5">{hechos.map(fila)}</ul>
        </div>
      )}
      {fallo && (
        <p role="alert" className="text-[12.5px] text-red-600">
          {t("planDeTrabajo.error")}
        </p>
      )}
    </div>
  );
}
