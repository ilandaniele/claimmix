/**
 * Los dos paneles del equipo que salen de los choques (B18) y de la carta de
 * un tercero (B24).
 *
 * Sin mock de i18n a propósito: lo que se afirma es el texto que lee una
 * persona, en los dos idiomas. Lo que más importa: la opinión lleva la palabra
 * «orientativa», la identidad del reclamante sólo la ve quien ve el padrón, y
 * los montos salen siempre en pesos argentinos.
 */

import { describe, it, expect } from "vitest";
import { render } from "@testing-library/react";

import {
  ResponsabilidadPanel,
  VeredictoDeResponsabilidad,
} from "@/app/(app)/casos/[id]/_components/ResponsabilidadPanel";
import { ReclamoTerceroPanel } from "@/app/(app)/casos/[id]/_components/ReclamoTerceroPanel";
import type { Responsabilidad } from "@/core/case/responsabilidad";
import type { ReclamoTercero } from "@/core/case/reclamo-tercero";
import type { CartaEnPantalla } from "@/server/cases/detail-view";
import { getT, type Locale } from "@/lib/i18n";

const IDIOMAS: Locale[] = ["es-AR", "en-US"];

const opinion = (parcial: Partial<Responsabilidad> = {}): Responsabilidad => ({
  v: 1,
  responsable: "tercero",
  regla: "ley24449_art48g",
  motivo: { clave: "alcance", params: { parte: "tercero" } },
  faltantes: [],
  difiere: false,
  ...parcial,
});

const reclamo = (parcial: Partial<ReclamoTercero> = {}): ReclamoTercero => ({
  es_reclamo: true,
  reclamante: { nombre: "Marta Quiroga", patente: "AB123CD", aseguradora: "Seguros del Sur", letrado: "Dr. Pérez" },
  rubros: [
    { rubro: "danio_material", monto: 1234567 },
    { rubro: "danio_moral", monto: null },
  ],
  moneda: "ARS",
  plazo_dias: 10,
  fecha_carta: "2026-09-15",
  adjunta: ["presupuesto"],
  ...parcial,
});

const carta = (parcial: Partial<CartaEnPantalla> = {}): CartaEnPantalla => ({
  id: "c1",
  filename: "carta.pdf",
  reclamo: reclamo(),
  sinLeer: null,
  faltantes: [],
  cruces: [],
  total: 1234567,
  ...parcial,
});

const panelDeCartas = (cartas: CartaEnPantalla[], locale: Locale, puedeVerReclamante: boolean) =>
  render(<ReclamoTerceroPanel cartas={cartas} t={getT(locale)} locale={locale} puedeVerReclamante={puedeVerReclamante} />)
    .container.textContent ?? "";

describe.each(IDIOMAS)("ResponsabilidadPanel (%s)", (locale) => {
  const t = getT(locale);
  const texto = (o: Responsabilidad) => render(<ResponsabilidadPanel responsabilidad={o} t={t} />).container.textContent ?? "";

  it("dice que es orientativa", () => {
    expect(texto(opinion())).toContain(t("responsabilidad.orientativa"));
  });

  it("muestra al responsable y la regla con su artículo", () => {
    const salida = texto(opinion());
    expect(salida).toContain(t("responsabilidad.responsable.tercero"));
    expect(salida).toContain("24.449");
    expect(salida).toMatch(/48/);
  });

  it("el motivo nombra a la parte", () => {
    expect(texto(opinion())).toContain(t("responsabilidad.parte.tercero"));
  });

  it("sin regla cita «ninguna» y lista lo que falta", () => {
    const salida = texto(
      opinion({
        responsable: "no_determinable",
        regla: null,
        motivo: { clave: "sin_regla", params: {} },
        faltantes: ["maniobra_asegurado", "parte_o_denuncia"],
      })
    );
    expect(salida).toContain(t("responsabilidad.regla.ninguna"));
    expect(salida).toContain(t("responsabilidad.faltantes"));
    expect(salida).toContain(t("responsabilidad.faltante.maniobra_asegurado"));
    expect(salida).toContain(t("responsabilidad.faltante.parte_o_denuncia"));
  });

  it("una clave que la versión no sabe traducir no deja un renglón vacío", () => {
    const { container } = render(
      <ResponsabilidadPanel responsabilidad={opinion({ faltantes: ["clave_del_futuro"] })} t={t} />
    );
    expect(container.querySelectorAll("li")).toHaveLength(0);
    expect(container.textContent).not.toContain(t("responsabilidad.faltantes"));
  });

  it("con reglas de partes distintas las lista todas", () => {
    const salida = texto(
      opinion({
        responsable: "compartida",
        regla: null,
        motivo: { clave: "compartida", params: { reglas: "ley24449_art44,ley24449_art48g" } },
      })
    );
    expect(salida).toContain(t("responsabilidad.regla.ley24449_art44"));
    expect(salida).toContain(t("responsabilidad.regla.ley24449_art48g"));
  });

  it("avisa cuando el relato y los documentos no cuentan lo mismo", () => {
    expect(texto(opinion({ difiere: true }))).toContain(t("responsabilidad.difiere"));
    expect(texto(opinion({ difiere: false }))).not.toContain(t("responsabilidad.difiere"));
  });

  it("el veredicto es una etiqueta con el responsable", () => {
    const { container } = render(<VeredictoDeResponsabilidad responsabilidad={opinion({ responsable: "asegurado" })} t={t} />);
    expect(container.textContent).toBe(t("responsabilidad.responsable.asegurado"));
  });
});

describe.each(IDIOMAS)("ReclamoTerceroPanel (%s)", (locale) => {
  const t = getT(locale);

  it("aclara que lo que dice la carta va sin verificar", () => {
    expect(panelDeCartas([carta()], locale, true)).toContain(t("reclamo.aviso"));
  });

  it("los montos salen en pesos argentinos aunque el idioma sea otro", () => {
    const salida = panelDeCartas([carta()], locale, true);
    expect(salida).toContain("1.234.567");
    expect(salida).toContain(t("reclamo.sinMonto"));
    expect(salida).toContain(t("reclamo.rubro.danio_material"));
  });

  it("la fecha sigue el orden del idioma y el plazo se cuenta en días", () => {
    const salida = panelDeCartas([carta()], locale, true);
    expect(salida).toContain(locale === "es-AR" ? "15/09/2026" : "09/15/2026");
    expect(salida).toContain(t("reclamo.plazoDias").replace("{n}", "10"));
  });

  it("quien ve el padrón ve quién reclama", () => {
    const salida = panelDeCartas([carta()], locale, true);
    expect(salida).toContain("Marta Quiroga");
    expect(salida).toContain("AB123CD");
    expect(salida).toContain("Dr. Pérez");
    expect(salida).not.toContain(t("reclamo.reservado"));
  });

  it("quien no lo ve no recibe nombre, patente ni letrado, sólo el aviso", () => {
    const salida = panelDeCartas([carta()], locale, false);
    expect(salida).not.toContain("Marta Quiroga");
    expect(salida).not.toContain("AB123CD");
    expect(salida).not.toContain("Dr. Pérez");
    expect(salida).toContain(t("reclamo.reservado"));
    expect(salida).toContain("Seguros del Sur");
    expect(salida).toContain("1.234.567");
  });

  it("lista lo que falta, lo que dice que adjunta y el cotejo", () => {
    const salida = panelDeCartas(
      [carta({ faltantes: ["plazo", "poder"], cruces: ["reclama_incapacidad_sin_historia"] })],
      locale,
      true
    );
    expect(salida).toContain(t("reclamo.faltantes"));
    expect(salida).toContain(t("reclamo.faltante.plazo"));
    expect(salida).toContain(t("reclamo.faltante.poder"));
    expect(salida).toContain(t("reclamo.adjunta.presupuesto"));
    expect(salida).toContain(t("reclamo.cruce.reclama_incapacidad_sin_historia"));
  });

  it("una carta reconocida y todavía sin leer lo dice y no inventa campos", () => {
    const salida = panelDeCartas([carta({ reclamo: null, total: null })], locale, true);
    expect(salida).toContain(t("reclamo.sinLeer"));
    expect(salida).not.toContain(t("reclamo.total"));
  });

  it("una carta que ningún reintento arregla dice por qué, y no promete reintentarlo", () => {
    for (const motivo of ["archivo", "paginas", "formato"] as const) {
      const salida = panelDeCartas([carta({ reclamo: null, total: null, sinLeer: motivo })], locale, true);
      expect(salida).toContain(t(`lectura.sinLeer.${motivo}`));
      expect(salida).not.toContain(t("reclamo.sinLeer"));
    }
  });

  it("los montos en dólares salen como dólares", () => {
    const salida = panelDeCartas(
      [carta({ reclamo: reclamo({ moneda: "USD", rubros: [{ rubro: "danio_material", monto: 5000 }] }), total: 5000 })],
      locale,
      true
    );
    expect(salida).toContain("US$");
    expect(salida).not.toContain("$ 5.000,00");
  });

  it("dos cartas se pintan las dos", () => {
    const salida = panelDeCartas([carta({ id: "a", filename: "uno.pdf" }), carta({ id: "b", filename: "dos.pdf" })], locale, true);
    expect(salida).toContain("uno.pdf");
    expect(salida).toContain("dos.pdf");
  });
});
