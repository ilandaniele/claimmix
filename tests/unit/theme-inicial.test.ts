/**
 * El script que decide el tema antes del primer pintado.
 *
 * Lo que se rompía: `ThemeProvider` elegía el tema en un `useEffect`, o sea
 * después de dibujar. Medido con el sistema en oscuro pidiendo /clientes, el
 * servidor mandaba `class="h-full antialiased"` y el fondo salía
 * rgb(248,250,252) —blanco— hasta que el efecto lo pasaba a rgb(11,17,32). Un
 * destello blanco en cada carga completa para todo el que tenga el sistema en
 * oscuro, que hoy es casi todo el mundo.
 *
 * Estos tests EJECUTAN el string tal como viaja en el HTML. No lo leen ni lo
 * comparan con una copia: le arman un `localStorage` y un `matchMedia`, lo
 * corren, y miran qué quedó en `<html>`. Si alguien le cambia la clave, el
 * orden de preferencias o el nombre de la clase, esto se entera.
 */

import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";

import { CLAVE_TEMA, SCRIPT_TEMA_INICIAL } from "@/lib/theme/script-inicial";

/** Corre el script como lo correría el navegador, con el entorno que se le dé. */
function correrScript({
  guardado,
  sistemaOscuro,
}: {
  guardado?: string | null;
  sistemaOscuro: boolean;
}): { tieneClaseDark: boolean; colorScheme: string } {
  document.documentElement.className = "h-full antialiased";
  document.documentElement.style.colorScheme = "";

  if (guardado === undefined || guardado === null) {
    window.localStorage.removeItem(CLAVE_TEMA);
  } else {
    window.localStorage.setItem(CLAVE_TEMA, guardado);
  }

  vi.stubGlobal(
    "matchMedia",
    (consulta: string) =>
      ({
        matches: consulta.includes("dark") ? sistemaOscuro : false,
        media: consulta,
      }) as MediaQueryList
  );

  // eslint-disable-next-line no-new-func
  new Function(SCRIPT_TEMA_INICIAL).call(window);

  return {
    tieneClaseDark: document.documentElement.classList.contains("dark"),
    colorScheme: document.documentElement.style.colorScheme,
  };
}

describe("el script inicial del tema", () => {
  beforeEach(() => {
    window.localStorage.clear();
  });

  afterEach(() => {
    vi.unstubAllGlobals();
    document.documentElement.className = "";
    document.documentElement.style.colorScheme = "";
  });

  it("con el sistema en oscuro y sin elección previa, pone oscuro antes de pintar", () => {
    // Éste es exactamente el caso que producía el destello blanco.
    const r = correrScript({ sistemaOscuro: true });
    expect(r.tieneClaseDark).toBe(true);
    expect(r.colorScheme).toBe("dark");
  });

  it("con el sistema en claro y sin elección previa, no pone nada", () => {
    const r = correrScript({ sistemaOscuro: false });
    expect(r.tieneClaseDark).toBe(false);
    expect(r.colorScheme).toBe("light");
  });

  it("lo que la persona eligió le gana al sistema operativo", () => {
    // Alguien con el sistema en oscuro que apretó el botón para ver claro tiene
    // que seguir viendo claro, que es para lo que existe el botón.
    expect(correrScript({ guardado: "light", sistemaOscuro: true }).tieneClaseDark).toBe(false);
    expect(correrScript({ guardado: "dark", sistemaOscuro: false }).tieneClaseDark).toBe(true);
  });

  it("un valor guardado que no sirve no rompe: cae en el del sistema", () => {
    // Pasa de verdad: alguien edita el storage, o queda un valor de una versión
    // vieja. Sin este `else` el script dejaba `class` intacta y `colorScheme`
    // en basura.
    const r = correrScript({ guardado: "verde", sistemaOscuro: true });
    expect(r.tieneClaseDark).toBe(true);
    expect(r.colorScheme).toBe("dark");
  });

  it("si localStorage tira, la página se dibuja igual", () => {
    // En algunos modos privados `localStorage` lanza al leer. Un tema
    // equivocado es mucho mejor que una pantalla en blanco, así que el script
    // se traga el error y no propaga nada.
    const original = window.localStorage.getItem;
    window.localStorage.getItem = () => {
      throw new Error("acceso denegado");
    };
    expect(() => correrScript({ sistemaOscuro: true })).not.toThrow();
    window.localStorage.getItem = original;
  });

  it("usa la misma clave que guarda el botón del tema", () => {
    // La regla que de verdad importa: si el script lee una clave y el botón
    // escribe otra, la elección de la persona se pierde en cada carga y el
    // síntoma es el destello, no un error.
    expect(CLAVE_TEMA).toBe("claimmix-theme");
    expect(SCRIPT_TEMA_INICIAL).toContain(JSON.stringify(CLAVE_TEMA));
  });
});
