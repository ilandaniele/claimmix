import { describe, expect, it } from "vitest";

import { getT } from "@/lib/i18n";
import { resumenDeLaIA, textoDeIndicio } from "@/lib/labels/textos-de-la-ia";

describe("resumenDeLaIA", () => {
  it("en castellano se muestra; en otro idioma la ficha cae a lo suyo", () => {
    expect(resumenDeLaIA("Choque en una esquina.", "es-AR")).toBe("Choque en una esquina.");
    expect(resumenDeLaIA("Choque en una esquina.", "en-US")).toBeNull();
  });
});

describe("textoDeIndicio", () => {
  const derivado = { description: "Una foto adjunta se sacó fuera del país.", clave: "foto_fuera_del_pais" };

  it("un indicio de los adjuntos se traduce por su clave", () => {
    expect(textoDeIndicio(derivado, getT("en-US"))).toBe("An attached photo was taken outside the country.");
    expect(textoDeIndicio(derivado, getT("es-AR"))).toBe(derivado.description);
  });

  it("sin una clave conocida queda la descripción", () => {
    expect(textoDeIndicio({ description: "del modelo" }, getT("en-US"))).toBe("del modelo");
    expect(textoDeIndicio({ description: "x", clave: "otra" }, getT("en-US"))).toBe("x");
  });
});
