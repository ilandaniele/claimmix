/**
 * Cuatro cosas que la interfaz prometía y no cumplía.
 *
 * Un diálogo que declara `aria-modal` y no atrapa el foco, un documento que
 * dice estar en castellano cuando está en inglés, un formulario cuyos controles
 * no tienen nombre, y un texto que se coló entre las exenciones del barrido de
 * contraste.
 */

import { readFileSync } from "node:fs";

import { describe, expect, it } from "vitest";

const USERS = readFileSync("src/app/(app)/admin/users/AdminUsersClient.tsx", "utf8");
const APP_LAYOUT = readFileSync("src/app/(app)/layout.tsx", "utf8");
const CAMPOS = readFileSync("src/app/(app)/agente/CustomFieldsPanel.tsx", "utf8");
const PROVIDER = readFileSync("src/app/(app)/configuracion/AiProviderPanel.tsx", "utf8");
const HILO = readFileSync("src/app/(app)/casos/[id]/_components/MessagesThread.tsx", "utf8");

describe("el quinto diálogo", () => {
  it("atrapa el foco como los otros cuatro", () => {
    /*
     * Declaraba `role="dialog"` y `aria-modal="true"` y no tenía nada: ni foco
     * inicial, ni trampa de Tab, ni Escape, ni devolución del foco al cerrar.
     * Con `aria-modal` puesto, el lector esconde todo lo de afuera y el Tab
     * lleva justo ahí: la persona quedaba parada en la nada.
     *
     * Y es el formulario que crea usuarios con su rol.
     */
    expect(USERS).toContain("useDialogoModal");
    expect(USERS).toContain("ref={dialogRef}");
  });

  it("y el foco arranca en el primer campo que se llena", () => {
    expect(USERS).toContain("useDialogoModal<HTMLDivElement>(onClose, correoRef)");
    expect(USERS).toContain("ref={correoRef}");
  });
});

describe("el idioma de la parte que cambia", () => {
  it("el envoltorio de la app lo declara", () => {
    /*
     * El layout raíz escribe `lang="es-AR"` fijo, y está bien: `/login`,
     * `/registro` y `/recuperar` tienen el texto en castellano a mano. Pero acá
     * adentro la interfaz puede estar en inglés —la preferencia de la cuenta le
     * gana a la cookie— y con el idioma equivocado un lector lee todo con
     * fonemas castellanos. SC 3.1.2.
     */
    expect(APP_LAYOUT).toContain("<div lang={locale}");
  });
});

describe("los controles sin nombre", () => {
  it("los cuatro del formulario de campos lo tienen", () => {
    // Los dos `select` no tenían NINGUNO: se anunciaban como «cuadro
    // combinado» sin decir de qué.
    expect((CAMPOS.match(/aria-label=\{t\(/g) ?? []).length).toBe(4);
  });

  it("y usan las claves que ya rotulan esas mismas columnas", () => {
    // Nada de traducciones nuevas: la tabla de abajo ya las tiene.
    for (const clave of ["campos.col.clave", "campos.col.etiqueta", "campos.col.tipo", "campos.col.siniestro"]) {
      expect(CAMPOS, clave).toContain(clave);
    }
  });

  it("el rótulo de la clave de Gemini está unido a su campo", () => {
    // Eran hermanos —el input vive adentro del `div.flex`— así que sin
    // `htmlFor` no los unía nada: el clic no enfocaba y se anunciaba una
    // contraseña sin nombre.
    expect(PROVIDER).toContain("htmlFor={idClave}");
    expect(PROVIDER).toContain("id={idClave}");
  });
});

describe("el contraste que quedó afuera del barrido", () => {
  it("la hora de cada mensaje es texto, no un icono", () => {
    /*
     * Se salvó porque lleva `flex-shrink-0`, que era uno de los marcadores con
     * los que se reconocía a los iconos. Pero es texto: 400 sobre blanco da
     * 2,56:1 contra el 4,5:1 que pide WCAG 1.4.3.
     */
    expect(HILO).not.toContain("text-slate-400");
  });
});
