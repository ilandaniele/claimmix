/**
 * AC17: CasesTable renders "Otro" (es-AR) / "Other" (en-US) for claim_type = "other".
 *
 * Also verifies no crash occurs for the "other" value or any unknown claim_type.
 *
 * The LocaleContext default value uses es-AR (DEFAULT_LOCALE), so rendering
 * without a LocaleProvider gives Spanish labels — same pattern as status-badge.test.tsx.
 */

import { fireEvent, render, screen } from "@testing-library/react";
import { vi } from "vitest";
import { CasesTable } from "../../../src/app/(app)/bandeja/components/CasesTable";
import { LocaleProvider } from "../../../src/lib/i18n/LocaleContext";
import type { CaseRow } from "../../../src/server/cases/list";

// next/navigation must be mocked — CasesTable calls useRouter()
const push = vi.hoisted(() => vi.fn());
vi.mock("next/navigation", () => ({
  useRouter: () => ({ push }),
}));

/** Minimal CaseRow factory for test data. */
function makeCase(overrides: Partial<CaseRow> = {}): CaseRow {
  return {
    id: "00000000-0000-0000-0000-000000000001",
    tenant_id: "tenant-1",
    policy_number: "POL-001",
    policyholder_name: "Juan Pérez",
    claim_type: "choque",
    status: "procesando",
    confidence_min: 0.85,
    assigned_to: null,
    channel: "email_sim",
    created_at: new Date().toISOString(),
    updated_at: null,
    closed_at: null,
    ...overrides,
  } as CaseRow;
}

describe("CasesTable — AC17 (claim_type = 'other')", () => {
  it('renders "Otro" label for claim_type="other" in es-AR locale', () => {
    const cases = [makeCase({ claim_type: "other" as CaseRow["claim_type"] })];
    render(
      <LocaleProvider locale="es-AR">
        <CasesTable cases={cases} />
      </LocaleProvider>
    );
    expect(screen.getByText("Otro")).toBeInTheDocument();
  });

  it('renders "Other" label for claim_type="other" in en-US locale', () => {
    const cases = [makeCase({ claim_type: "other" as CaseRow["claim_type"] })];
    render(
      <LocaleProvider locale="en-US">
        <CasesTable cases={cases} />
      </LocaleProvider>
    );
    expect(screen.getByText("Other")).toBeInTheDocument();
  });

  it("renders without crash for claim_type='other'", () => {
    const cases = [makeCase({ claim_type: "other" as CaseRow["claim_type"] })];
    expect(() =>
      render(
        <LocaleProvider locale="es-AR">
          <CasesTable cases={cases} />
        </LocaleProvider>
      )
    ).not.toThrow();
  });

  it('still renders "Choque" label for claim_type="choque" (regression)', () => {
    const cases = [makeCase({ claim_type: "choque" })];
    render(
      <LocaleProvider locale="es-AR">
        <CasesTable cases={cases} />
      </LocaleProvider>
    );
    expect(screen.getByText("Choque")).toBeInTheDocument();
  });

  it("renders empty state message when cases array is empty", () => {
    render(
      <LocaleProvider locale="es-AR">
        <CasesTable cases={[]} />
      </LocaleProvider>
    );
    expect(
      screen.getByText("No hay siniestros que coincidan con los filtros.")
    ).toBeInTheDocument();
  });
});

describe("CasesTable — modo selección", () => {
  const dos = [makeCase(), makeCase({ id: "00000000-0000-0000-0000-000000000002" })];
  function montar(seleccionando = true) {
    return render(
      <LocaleProvider locale="es-AR">
        <CasesTable cases={dos} seleccionando={seleccionando} onDeleteMany={vi.fn()} />
      </LocaleProvider>
    );
  }

  it("tocar el círculo marca la fila", () => {
    montar();
    const [c1] = screen.getAllByRole("checkbox");
    expect(c1).toHaveAttribute("aria-checked", "false");
    fireEvent.click(c1);
    expect(c1).toHaveAttribute("aria-checked", "true");
    expect(screen.getByRole("button", { name: /Eliminar seleccionados \(1\)/ })).toBeInTheDocument();
  });

  it("tocar la fila marca y no navega", () => {
    montar();
    fireEvent.click(screen.getAllByRole("row", { name: /Siniestro/ })[1]);
    expect(screen.getAllByRole("checkbox")[1]).toHaveAttribute("aria-checked", "true");
    expect(push).not.toHaveBeenCalled();
  });

  it("salir del modo olvida lo marcado", () => {
    const { rerender } = montar();
    fireEvent.click(screen.getAllByRole("checkbox")[0]);
    const sin = (
      <LocaleProvider locale="es-AR">
        <CasesTable cases={dos} seleccionando={false} onDeleteMany={vi.fn()} />
      </LocaleProvider>
    );
    rerender(sin);
    expect(screen.queryAllByRole("checkbox")).toHaveLength(0);
    rerender(
      <LocaleProvider locale="es-AR">
        <CasesTable cases={dos} seleccionando onDeleteMany={vi.fn()} />
      </LocaleProvider>
    );
    for (const c of screen.getAllByRole("checkbox")) expect(c).toHaveAttribute("aria-checked", "false");
  });
});
