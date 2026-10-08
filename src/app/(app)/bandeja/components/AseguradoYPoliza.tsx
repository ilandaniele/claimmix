"use client";

import { Vacio } from "./Vacio";

/**
 * Asegurado y póliza, uno sobre el otro: la celda de la lista y la tarjeta del
 * tablero. Sin ninguno de los dos, el hueco; con uno solo, ese y el hueco
 * donde falta el nombre.
 */
export function AseguradoYPoliza({ nombre, poliza }: { nombre: string | null; poliza: string | null }) {
  if (!nombre && !poliza) return <Vacio />;
  return (
    <div className="min-w-0 max-w-[13rem]">
      {nombre ? (
        <span className="block truncate text-[13.5px] font-semibold text-slate-900" title={nombre}>
          {nombre}
        </span>
      ) : (
        <Vacio />
      )}
      {poliza && (
        <span className="mt-0.5 block whitespace-nowrap font-mono text-[11.5px] text-slate-500">
          {poliza}
        </span>
      )}
    </div>
  );
}
