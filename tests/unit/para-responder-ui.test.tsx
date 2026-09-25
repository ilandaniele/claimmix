/**
 * «Para responder» en pantalla: el aviso y el botón del detalle, y la marca de
 * la tabla, en los dos idiomas.
 *
 * Los textos van literales a propósito: armados desde el diccionario, una
 * clave equivocada dejaba todo verde.
 */

import { fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { CasesTable } from "../../src/app/(app)/bandeja/components/CasesTable";
import { CaseDetailClient } from "../../src/app/(app)/casos/[id]/CaseDetailClient";
import { LocaleProvider } from "../../src/lib/i18n/LocaleContext";
import type { Locale } from "../../src/lib/i18n";
import type { CaseRow } from "../../src/server/cases/list";

vi.mock("next/navigation", () => ({
  useRouter: () => ({ push: vi.fn(), refresh: vi.fn() }),
}));

const VISTO = "2026-09-25T12:00:00.000Z";

afterEach(() => {
  vi.unstubAllGlobals();
});

function detalle(locale: Locale, paraResponder: boolean, puedeMarcar: boolean) {
  render(
    <LocaleProvider locale={locale}>
      <CaseDetailClient
        caseId="c1"
        status="requiere_especialista"
        caseNumber="#1"
        paraResponder={paraResponder}
        vistoEn={VISTO}
        puedeMarcar={puedeMarcar}
      />
    </LocaleProvider>
  );
}

describe("«Para responder» en el detalle", () => {
  it.each([
    ["es-AR", /Llegó un mensaje después de que el agente terminó/, "Marcar como respondido"],
    ["en-US", /A message arrived after the agent finished/, "Mark as answered"],
  ] as const)("en %s avisa y ofrece marcarlo", (locale, aviso, boton) => {
    detalle(locale, true, true);
    expect(screen.getByText(aviso)).toBeInTheDocument();
    expect(screen.getByRole("button", { name: boton })).toBeInTheDocument();
  });

  it("a un viewer le avisa pero no le ofrece un botón que le contesta 403", () => {
    detalle("es-AR", true, false);
    expect(screen.getByText(/Llegó un mensaje/)).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Marcar como respondido" })).toBeNull();
  });

  it("sin la marca no hay aviso", () => {
    detalle("es-AR", false, true);
    expect(screen.queryByText(/Llegó un mensaje/)).toBeNull();
  });

  it.each([
    ["es-AR", true, "Marcado como respondido."],
    ["es-AR", false, "El caso cambió mientras lo mirabas. Revisalo de nuevo."],
    ["en-US", true, "Marked as answered."],
    ["en-US", false, "The case changed while you were viewing it. Check it again."],
  ] as const)(
    "en %s, con actualizado=%s, manda cuándo lo vio y avisa «%s»",
    async (locale, actualizado, texto) => {
      const fetchSpy = vi.fn().mockResolvedValue({
        ok: true,
        status: 200,
        json: async () => ({ actualizado }),
      });
      vi.stubGlobal("fetch", fetchSpy);
      detalle(locale, true, true);

      fireEvent.click(
        screen.getByRole("button", {
          name: locale === "es-AR" ? "Marcar como respondido" : "Mark as answered",
        })
      );

      expect(await screen.findByText(texto)).toBeInTheDocument();
      expect(fetchSpy).toHaveBeenCalledWith(
        "/api/cases/c1/respondido",
        expect.objectContaining({ method: "POST", body: JSON.stringify({ visto: VISTO }) })
      );
    }
  );
});

describe("«Para responder» en la tabla", () => {
  const fila = (para_responder_desde: string | null) =>
    ({
      id: "00000000-0000-0000-0000-000000000001",
      tenant_id: "t1",
      policy_number: "POL-1",
      policyholder_name: "Juan Pérez",
      claim_type: "choque",
      status: "listo",
      confidence_min: 0.9,
      assigned_to: null,
      channel: "whatsapp",
      created_at: "2026-09-06T00:00:00.000Z",
      updated_at: null,
      closed_at: null,
      // Un no-siniestro ya respondido: igual lo tiene que contestar una persona.
      is_claim: false,
      replied_at: "2026-09-06T00:01:00.000Z",
      para_responder_desde,
    }) as unknown as CaseRow;

  it.each([
    ["es-AR", "Para responder"],
    ["en-US", "Needs reply"],
  ] as const)("en %s la marca le gana a «respondido» y a un no-siniestro", (locale, texto) => {
    render(
      <LocaleProvider locale={locale}>
        <CasesTable cases={[fila("2026-09-07T00:00:00.000Z")]} />
      </LocaleProvider>
    );
    expect(screen.getByText(texto)).toBeInTheDocument();
  });

  // Sin esto «Volver» llevaba a la bandeja entera y seguir con la cola quedaba
  // en el Atrás del navegador.
  it("abierto desde la cola, el caso sabe volver a ella", () => {
    const { container } = render(
      <LocaleProvider locale="es-AR">
        <CasesTable cases={[fila("2026-09-07T00:00:00.000Z")]} desde="para_responder" />
      </LocaleProvider>
    );
    expect(container.querySelector('a[href^="/casos/"]')?.getAttribute("href")).toBe(
      "/casos/00000000-0000-0000-0000-000000000001?desde=para_responder"
    );
  });

  it("sin la marca, un no-siniestro no muestra nada que responder", () => {
    render(
      <LocaleProvider locale="es-AR">
        <CasesTable cases={[fila(null)]} />
      </LocaleProvider>
    );
    expect(screen.queryByText("Para responder")).toBeNull();
    expect(screen.queryByText("Sin responder")).toBeNull();
  });
});
