"use client";

/**
 * Sube el PDF de condiciones de una póliza, que se lee una sola vez (B6).
 *
 * El estado (sin subir, sin leer, leídas) lo pinta la página; acá sólo va el
 * botón y el aviso de por qué no se leyó. No hay descarga: el PDF queda en el
 * bucket para quien lo lea después, no para bajarlo desde acá.
 */

import { useState } from "react";
import { useRouter } from "next/navigation";

import { esMotivoSinLeer } from "@/core/ai/sin-leer";
import type { TranslationKey } from "@/lib/i18n";
import { useT } from "@/lib/i18n/LocaleContext";

interface Props {
  policyId: string;
  subido: boolean;
}

export function SubirCondiciones({ policyId, subido }: Props) {
  const t = useT();
  const router = useRouter();
  const [subiendo, setSubiendo] = useState(false);
  const [aviso, setAviso] = useState<{ clave: TranslationKey; detalle?: string } | null>(null);

  async function subir(archivo: File) {
    setSubiendo(true);
    setAviso(null);
    try {
      const form = new FormData();
      form.append("archivo", archivo);
      const res = await fetch(`/api/policies/${policyId}/condiciones`, { method: "POST", body: form });
      const cuerpo = await res.json().catch(() => null);
      const motivo: unknown = cuerpo?.motivo;
      if (!res.ok) setAviso({ clave: "condiciones.error", detalle: cuerpo?.error?.message });
      else if (esMotivoSinLeer(motivo)) setAviso({ clave: `lectura.sinLeer.${motivo}` });
      router.refresh();
    } catch {
      setAviso({ clave: "condiciones.error" });
    } finally {
      setSubiendo(false);
    }
  }

  return (
    <div className="space-y-1">
      <label className="inline-flex cursor-pointer items-center rounded border border-slate-300 bg-white px-2 py-0.5 text-xs font-medium text-slate-700 hover:bg-slate-50 has-[:disabled]:cursor-not-allowed has-[:disabled]:opacity-50">
        {t(subiendo ? "condiciones.subiendo" : subido ? "condiciones.reemplazar" : "condiciones.subir")}
        <input
          type="file"
          accept="application/pdf"
          className="sr-only"
          disabled={subiendo}
          onChange={(e) => {
            const archivo = e.target.files?.[0];
            e.target.value = "";
            if (archivo) void subir(archivo);
          }}
        />
      </label>
      {aviso && (
        <p role="status" className="text-xs text-amber-700">
          {t(aviso.clave)}
          {aviso.detalle && ` ${aviso.detalle}`}
        </p>
      )}
    </div>
  );
}
