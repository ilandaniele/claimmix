/**
 * En es-AR, lo que el caso tiene se llama «Situación»; «Estado» queda para el
 * estado de la cuenta del cliente en la cartera.
 *
 * Los textos van literales a propósito: armados desde el diccionario, volver
 * a «Estado» dejaba todo verde.
 */

import { readFileSync } from "node:fs";
import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { CasesTable } from "../../src/app/(app)/bandeja/components/CasesTable";
import { CaseDetailClient } from "../../src/app/(app)/casos/[id]/CaseDetailClient";
import { AuditTimeline } from "../../src/app/(app)/casos/[id]/components/AuditTimeline";
import { EscalateDialog } from "../../src/app/(app)/casos/[id]/components/EscalateDialog";
import { LocaleProvider } from "../../src/lib/i18n/LocaleContext";
import { esAR } from "../../src/lib/i18n/es-AR";
import type { CaseRow } from "../../src/server/cases/list";

vi.mock("next/navigation", () => ({
  useRouter: () => ({ push: vi.fn(), refresh: vi.fn() }),
}));

const leer = (p: string) => readFileSync(p, "utf8");

// Con la lista vacía la tabla muestra su estado vacío y no hay encabezados.
const UN_CASO = {
  id: "00000000-0000-0000-0000-000000000001",
  tenant_id: "t1",
  policy_number: "POL-1",
  policyholder_name: "Juan Pérez",
  claim_type: "choque",
  status: "recibido",
  confidence_min: 0.9,
  assigned_to: null,
  channel: "email_sim",
  created_at: "2026-09-06T00:00:00.000Z",
  updated_at: null,
  closed_at: null,
} as unknown as CaseRow;

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("la situación del caso", () => {
  it.each([
    ["es-AR", "Situación"],
    ["en-US", "Status"],
  ] as const)("la columna de la bandeja en %s dice «%s»", (locale, texto) => {
    render(
      <LocaleProvider locale={locale}>
        <CasesTable cases={[UN_CASO]} />
      </LocaleProvider>
    );
    expect(screen.getByRole("columnheader", { name: texto })).toBeInTheDocument();
  });

  it("los filtros y las métricas también dicen «situación»", () => {
    expect(esAR["filter.estado"]).toBe("Situación");
    expect(esAR["metricas.porEstado"]).toBe("Siniestros por situación");
  });

  it.each([
    ["es-AR", 200, "Situación actualizada."],
    ["es-AR", 409, "Ese cambio de situación no es válido."],
    ["en-US", 200, "Status updated."],
    ["en-US", 409, "Invalid state transition."],
  ] as const)("el detalle en %s avisa un cambio que responde %i con «%s»", async (locale, status, texto) => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue({ ok: status === 200, status }));
    render(
      <LocaleProvider locale={locale}>
        <CaseDetailClient
          caseId="c1"
          status="esperando"
          caseNumber="#1"
          paraResponder={false}
          vistoEn="2026-09-25T12:00:00.000Z"
          puedeMarcar={false}
        />
      </LocaleProvider>
    );
    fireEvent.click(screen.getByTestId("action-marcar-completo"));
    expect(await screen.findByText(texto)).toBeInTheDocument();
  });

  it("la línea de tiempo del detalle dice «Situación actualizada»", () => {
    render(
      <LocaleProvider locale="es-AR">
        <AuditTimeline
          events={[{ id: 1, event_type: "case.status_changed", created_at: "2026-09-06T00:00:00Z", reason: null }]}
        />
      </LocaleProvider>
    );
    expect(screen.getByText("Situación actualizada")).toBeInTheDocument();
  });

  it.each([
    ["es-AR", "Ese cambio de situación no es válido."],
    ["en-US", "Invalid state transition."],
  ] as const)("escalar con 409 avisa en %s con el texto del diccionario", async (locale, texto) => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue({ ok: false, status: 409 }));
    const onError = vi.fn();
    render(
      <LocaleProvider locale={locale}>
        <EscalateDialog caseId="c1" onClose={vi.fn()} onSuccess={vi.fn()} onError={onError} />
      </LocaleProvider>
    );
    fireEvent.click(screen.getByTestId("escalate-confirm-button"));
    await waitFor(() => expect(onError).toHaveBeenCalledWith(texto));
  });

  it("la cartera sigue diciendo «Estado»: es la cuenta del cliente, no un caso", () => {
    expect(esAR["cartera.col.estado"]).toBe("Estado");
    const cartera = leer("src/app/(app)/admin/cartera/page.tsx");
    expect(cartera).toContain('t("cartera.col.estado")');
    expect(cartera).not.toContain('t("table.col.status")');
  });

  it("la guía de /demo y el análisis no nombran un filtro «estado» que ya no existe", () => {
    expect(leer("src/app/demo/DemoPublic.tsx")).toContain("Se filtra por situación,");
    expect(leer("src/app/(app)/analisis/page.tsx")).toContain("Distribución por situación");
  });
});
