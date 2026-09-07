/**
 * La bandeja manda al navegador el renglón del desplegable, no el expediente.
 *
 * `page.tsx` es un componente de servidor y le pasa la lista a
 * `DashboardClient`, que es de cliente. Una prop que cruza esa frontera viaja
 * serializada adentro del HTML: pasando `SCENARIOS` entero eran 145,9 KB de
 * texto de denuncias en cada carga de la pantalla que más se abre.
 *
 * Estas pruebas fijan las dos mitades del arreglo. La primera —que el objeto no
 * tenga las claves grandes— es la que importa, porque el defecto vuelve solo:
 * el día que alguien necesite un campo más en el modal, agregarlo al `map` es
 * un renglón y devolver `s` entero también. La segunda comprueba que el
 * desplegable siga diciendo exactamente lo mismo, que es la condición para que
 * esto sea un ahorro y no un cambio de pantalla.
 */

import { describe, expect, it } from "vitest";
import {
  OPCIONES_DE_ESCENARIO,
  SCENARIOS,
  type OpcionDeEscenario,
} from "@/server/intake/scenarios";

/** El corte que hacía el modal antes de este cambio, copiado tal cual. */
function comoCortabaElModal(str: string, max: number): string {
  if (str.length <= max) return str;
  return str.slice(0, max) + "...";
}

describe("las opciones del selector de simulación", () => {
  it("hay una por escenario, en el mismo orden", () => {
    expect(OPCIONES_DE_ESCENARIO).toHaveLength(SCENARIOS.length);
    expect(OPCIONES_DE_ESCENARIO.map((o) => o.id)).toEqual(SCENARIOS.map((s) => s.id));
  });

  it("no llevan el texto de la denuncia ni los campos esperados", () => {
    for (const opcion of OPCIONES_DE_ESCENARIO) {
      const claves = Object.keys(opcion).sort();
      expect(claves).toEqual(["case_type", "id", "policyholder_name", "preview"]);
    }
  });

  it("el adelanto dice lo mismo que decía el modal", () => {
    for (const escenario of SCENARIOS) {
      const opcion = OPCIONES_DE_ESCENARIO.find((o) => o.id === escenario.id);
      expect(opcion, `falta la opción de ${escenario.id}`).toBeDefined();
      expect(opcion!.preview).toBe(
        comoCortabaElModal(escenario.raw_text.replace(/\n/g, " "), 80)
      );
      expect(opcion!.case_type).toBe(escenario.case_type);
      expect(opcion!.policyholder_name).toBe(escenario.policyholder_name);
    }
  });

  it("el adelanto es de una sola línea y no se pasa de 83 caracteres", () => {
    for (const opcion of OPCIONES_DE_ESCENARIO) {
      expect(opcion.preview).not.toContain("\n");
      // 80 más los tres puntos: el renglón entra en el desplegable.
      expect(opcion.preview.length).toBeLessThanOrEqual(83);
    }
  });

  it("lo que se serializa pesa una fracción de lo que se serializaba", () => {
    const antes = JSON.stringify(SCENARIOS).length;
    const ahora = JSON.stringify(OPCIONES_DE_ESCENARIO).length;
    // Medido: 145,9 KB → 29,1 KB con 163 escenarios. El margen es ancho porque
    // la proporción se mueve con cada escenario nuevo; lo que fija la prueba es
    // que el recorte siga siendo un orden de magnitud, no el número exacto.
    expect(ahora).toBeLessThan(antes / 3);
  });
});

describe("el tipo de la opción", () => {
  it("no deja colar un escenario entero por descuido", () => {
    // Si alguien cambia el `map` por `SCENARIOS`, esto deja de compilar además
    // de fallar arriba. La prueba en runtime existe porque `tsc` no corre en
    // todos los caminos por los que se toca este archivo.
    const opcion: OpcionDeEscenario = OPCIONES_DE_ESCENARIO[0]!;
    expect(opcion).not.toHaveProperty("raw_text");
    expect(opcion).not.toHaveProperty("expected_fields");
    expect(opcion).not.toHaveProperty("policy_number");
  });
});
