/**
 * AC17: CasesTable renders "Otro" (es-AR) / "Other" (en-US) for claim_type = "other".
 *
 * Also verifies no crash occurs for the "other" value or any unknown claim_type.
 *
 * The LocaleContext default value uses es-AR (DEFAULT_LOCALE), so rendering
 * without a LocaleProvider gives Spanish labels — same pattern as status-badge.test.tsx.
 */

import { render, screen } from "@testing-library/react";
import { vi } from "vitest";
import { CasesTable } from "../../../src/app/(app)/bandeja/components/CasesTable";
import { LocaleProvider } from "../../../src/lib/i18n/LocaleContext";
import type { CaseRow } from "../../../src/server/cases/list";

// next/navigation must be mocked — CasesTable calls useRouter()
vi.mock("next/navigation", () => ({
  useRouter: () => ({ push: vi.fn() }),
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
