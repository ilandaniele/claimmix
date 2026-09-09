/**
 * La intersección de dos ensayos, que se comía justo las regresiones peores.
 *
 * Cuando algo difiere, el post-deploy corre el ensayo de nuevo e intersecta:
 * lo que falló las dos veces es una regresión, lo que falló una es el modelo
 * eligiendo distinto.
 *
 * La intersección se hacía sobre el texto del motivo, y ese texto LLEVA ADENTRO
 * lo que el modelo contestó. La misma afirmación rota dos veces con dos valores
 * distintos daba dos claves y salía verde — o sea que una regresión inestable
 * se escondía mejor que una determinista.
 */

import { execFileSync } from "node:child_process";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { describe, expect, it } from "vitest";

function comparar(
  primera: unknown[],
  segunda: unknown[]
): { salida: string; codigo: number } {
  const dir = mkdtempSync(join(tmpdir(), "ensayos-"));
  const a = join(dir, "primera.json");
  const b = join(dir, "segunda.json");
  writeFileSync(a, JSON.stringify(primera));
  writeFileSync(b, JSON.stringify(segunda));

  try {
    const salida = execFileSync(
      process.execPath,
      ["scripts/comparar-ensayos.mjs", a, b],
      { encoding: "utf8" }
    );
    return { salida, codigo: 0 };
  } catch (err) {
    const e = err as { stdout?: string; stderr?: string; status?: number };
    return { salida: `${e.stdout ?? ""}${e.stderr ?? ""}`, codigo: e.status ?? 1 };
  }
}

const dif = (comprobacion: string, why: string) => ({
  scenario: "goteo",
  turn: 2,
  why,
  comprobacion,
});

describe("comparar-ensayos", () => {
  it("la misma comprobación rota dos veces es roja aunque el valor cambie", () => {
    // El caso que se escapaba. El modelo devolvió dos estados equivocados
    // distintos: dos motivos distintos, una sola afirmación rota.
    const { salida, codigo } = comparar(
      [dif("estado", "estado info_faltante, esperaba listo")],
      [dif("estado", "estado confirmacion_pendiente, esperaba listo")]
    );

    expect(codigo).toBe(1);
    expect(salida).toContain("en LAS DOS corridas");
  });

  it("y muestra los dos valores, no sólo el primero", () => {
    // Mostrar uno solo se lee como «se repitió idéntica». Dos valores dicen
    // algo más: el comportamiento cambió y además es inestable.
    const { salida } = comparar(
      [dif("estado", "estado info_faltante, esperaba listo")],
      [dif("estado", "estado confirmacion_pendiente, esperaba listo")]
    );

    expect(salida).toContain("info_faltante");
    expect(salida).toContain("confirmacion_pendiente");
  });

  it("dos comprobaciones distintas siguen siendo variación", () => {
    // El control. Si la clave fuera el escenario y el turno a secas, esto
    // saldría rojo y el reintento no separaría nada.
    const { salida, codigo } = comparar(
      [dif("estado", "estado listo, esperaba info_faltante")],
      [dif("adjuntos", "0 adjunto(s) guardado(s), esperaba 1")]
    );

    expect(codigo).toBe(0);
    expect(salida).toContain("Nada falló las dos veces");
  });

  it("un reporte que falta no es cero diferencias", () => {
    const dir = mkdtempSync(join(tmpdir(), "ensayos-"));
    const a = join(dir, "primera.json");
    writeFileSync(a, JSON.stringify([dif("estado", "x")]));

    let codigo = 0;
    try {
      execFileSync(
        process.execPath,
        ["scripts/comparar-ensayos.mjs", a, join(dir, "no-existe.json")],
        { encoding: "utf8" }
      );
    } catch (err) {
      codigo = (err as { status?: number }).status ?? 1;
    }
    expect(codigo).toBe(1);
  });
});
