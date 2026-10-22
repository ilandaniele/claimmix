/**
 * Las insignias de plazo y de complejidad (B10, B13) y las dos columnas de la
 * bandeja que las usan.
 */

import { render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { CasesTable } from "../../../src/app/(app)/bandeja/components/CasesTable";
import {
  InsigniaDeComplejidad,
  InsigniaDeDenuncia,
  InsigniaDeVencimiento,
} from "../../../src/app/(app)/_components/plazo-y-complejidad";
import { LocaleProvider } from "../../../src/lib/i18n/LocaleContext";
import type { Locale } from "../../../src/lib/i18n";
import type { CaseRow } from "../../../src/server/cases/list";

vi.mock("next/navigation", () => ({ useRouter: () => ({ push: vi.fn() }) }));

const AHORA = new Date("2026-09-29T15:00:00.000Z");

const conIdioma = (ui: React.ReactElement, locale: Locale = "es-AR") =>
  render(<LocaleProvider locale={locale}>{ui}</LocaleProvider>);

describe("InsigniaDeVencimiento", () => {
  it("sin vencimiento pinta el hueco, no un texto", () => {
    conIdioma(<InsigniaDeVencimiento vence={null} ahora={AHORA} />);
    expect(screen.getByLabelText("Sin dato")).toBeInTheDocument();
  });

  it("un vencimiento que no es una fecha también es un hueco", () => {
    conIdioma(<InsigniaDeVencimiento vence="no es una fecha" ahora={AHORA} />);
    expect(screen.getByLabelText("Sin dato")).toBeInTheDocument();
  });

  it("vencido: rojo y con los días que pasaron", () => {
    conIdioma(<InsigniaDeVencimiento vence="2026-09-26T02:59:59.999Z" ahora={AHORA} />);
    const el = screen.getByText("Vencido hace 4 d");
    expect(el.className).toContain("text-red-600");
  });

  it("venció hace menos de un día: «hace 1 d», no «hoy»", () => {
    conIdioma(<InsigniaDeVencimiento vence="2026-09-29T14:00:00.000Z" ahora={AHORA} />);
    expect(screen.getByText("Vencido hace 1 d")).toBeInTheDocument();
  });

  it("vence hoy: ámbar", () => {
    conIdioma(<InsigniaDeVencimiento vence="2026-09-30T02:59:59.999Z" ahora={AHORA} />);
    const el = screen.getByText("Vence hoy");
    expect(el.className).toContain("text-amber-700");
  });

  it("por vencer dentro de cinco días: ámbar y con los días que faltan", () => {
    conIdioma(<InsigniaDeVencimiento vence="2026-10-02T02:59:59.999Z" ahora={AHORA} />);
    const el = screen.getByText("Vence en 2 d");
    expect(el.className).toContain("text-amber-700");
  });

  it("en plazo: gris", () => {
    conIdioma(<InsigniaDeVencimiento vence="2026-10-29T02:59:59.999Z" ahora={AHORA} />);
    const el = screen.getByText("Vence en 29 d");
    expect(el.className).toContain("text-slate-500");
  });

  it("en inglés arma la frase con sus palabras", () => {
    conIdioma(<InsigniaDeVencimiento vence="2026-09-26T02:59:59.999Z" ahora={AHORA} />, "en-US");
    expect(screen.getByText("Overdue by 4 d")).toBeInTheDocument();
  });

  it("el título trae la fecha del vencimiento en hora argentina", () => {
    conIdioma(<InsigniaDeVencimiento vence="2026-09-30T02:59:59.999Z" ahora={AHORA} />);
    expect(screen.getByText("Vence hoy").getAttribute("title")).toBe("29/09/2026");
  });
});

describe("InsigniaDeComplejidad", () => {
  it("sin puntaje pinta el hueco", () => {
    conIdioma(<InsigniaDeComplejidad puntaje={null} />);
    expect(screen.getByLabelText("Sin dato")).toBeInTheDocument();
  });

  it.each([
    [0, "Baja 0", "text-slate-500"],
    [33, "Baja 33", "text-slate-500"],
    [34, "Media 34", "text-amber-700"],
    [66, "Media 66", "text-amber-700"],
    [67, "Alta 67", "text-red-600"],
    [100, "Alta 100", "text-red-600"],
  ])("puntaje %d es «%s»", (puntaje, texto, color) => {
    conIdioma(<InsigniaDeComplejidad puntaje={puntaje} />);
    const el = screen.getByText(texto);
    expect(el.className).toContain(color);
    expect(el.getAttribute("title")).toBe(`Puntaje ${puntaje} de 100`);
  });

  it("en inglés", () => {
    conIdioma(<InsigniaDeComplejidad puntaje={80} />, "en-US");
    const el = screen.getByText("High 80");
    expect(el.getAttribute("title")).toBe("Score 80 of 100");
  });
});

describe("InsigniaDeDenuncia", () => {
  it("sin resultado no pinta nada", () => {
    const { container } = conIdioma(<InsigniaDeDenuncia resultado={null} />);
    expect(container).toBeEmptyDOMElement();
  });

  it("sin superar el art. 46: gris y con los días", () => {
    conIdioma(<InsigniaDeDenuncia resultado={{ dias: 2, superaArt46: false }} />);
    const el = screen.getByText("2 d del hecho a la denuncia");
    expect(el.className).toContain("text-slate-500");
    expect(el.getAttribute("title")).toContain("art. 46");
  });

  it("al superarlo: ámbar, con los días y para revisar", () => {
    conIdioma(<InsigniaDeDenuncia resultado={{ dias: 9, superaArt46: true }} />);
    const el = screen.getByText("9 d del hecho a la denuncia · revisar");
    expect(el.className).toContain("text-amber-700");
    expect(el.getAttribute("title")).toContain("no una decisión");
  });

  it("nunca es una condena: ni rojo, ni «término», ni «Late»", () => {
    for (const resultado of [
      { dias: 2, superaArt46: false },
      { dias: 9, superaArt46: true },
    ]) {
      for (const locale of ["es-AR", "en-US"] as const) {
        const { container, unmount } = conIdioma(<InsigniaDeDenuncia resultado={resultado} />, locale);
        const el = container.firstElementChild as HTMLElement;
        expect(el.className).not.toContain("text-red-600");
        expect(el.textContent).not.toMatch(/término|Late/);
        expect(el.getAttribute("title")).not.toMatch(/término|Late/);
        unmount();
      }
    }
  });

  it("en inglés", () => {
    conIdioma(<InsigniaDeDenuncia resultado={{ dias: 9, superaArt46: true }} />, "en-US");
    expect(screen.getByText("9 d from loss to report · review")).toBeInTheDocument();
  });
});

describe("CasesTable — columnas de plazo y complejidad", () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  function caso(extra: Partial<CaseRow>): CaseRow {
    return {
      id: "00000000-0000-0000-0000-000000000001",
      tenant_id: "tenant-1",
      policy_number: "POL-001",
      policyholder_name: "Juan Pérez",
      claim_type: "choque",
      status: "listo",
      confidence_min: 0.85,
      assigned_to: null,
      channel: "email_sim",
      created_at: "2026-09-20T12:00:00.000Z",
      updated_at: null,
      closed_at: null,
      vence_en: null,
      puntaje_complejidad: null,
      ...extra,
    } as unknown as CaseRow;
  }

  it("muestra las dos columnas, con su encabezado", () => {
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(AHORA);
    conIdioma(<CasesTable cases={[caso({ vence_en: "2026-09-26T02:59:59.999Z", puntaje_complejidad: 72 })]} />);

    expect(screen.getByRole("columnheader", { name: "Vence" })).toBeInTheDocument();
    expect(screen.getByRole("columnheader", { name: "Complejidad" })).toBeInTheDocument();
    expect(screen.getByText("Vencido hace 4 d")).toBeInTheDocument();
    expect(screen.getByText("Alta 72")).toBeInTheDocument();
  });

  it("un caso sin plazo ni puntaje (anterior a la 0042) no rompe la fila", () => {
    conIdioma(<CasesTable cases={[caso({})]} />);
    expect(screen.getByText("Juan Pérez")).toBeInTheDocument();
  });
});
