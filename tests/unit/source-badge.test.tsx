/**
 * Unit tests for SourceBadge component and CasesTable "Fuente" column.
 *
 * AC15: channel='email'     → data-source="gmail", text "Gmail" (blue badge)
 * AC16: channel='email_sim' → data-source="sim",   text "Sim"   (slate badge)
 * AC17: CasesTable renders a column header with text "Fuente"
 * AC18: SourceBadge uses blue-50/blue-700 (Gmail) and slate-200/slate-600 (Sim)
 *       — these class combos must NOT appear in StatusBadge or SeverityBadge.
 *
 * Also asserts null/undefined channel renders "—".
 */

import { render, screen } from "@testing-library/react";
import { describe, it, expect } from "vitest";
import { SourceBadge } from "../../src/app/(app)/bandeja/components/SourceBadge";
import { CasesTable } from "../../src/app/(app)/bandeja/components/CasesTable";
import type { CaseRow } from "../../src/server/cases/list";

// ── SourceBadge unit tests ────────────────────────────────────────────────────

describe("SourceBadge", () => {
  // AC15
  it("AC15: renders Gmail badge for channel='email'", () => {
    const { container } = render(<SourceBadge channel="email" />);
    const badge = container.firstElementChild as HTMLElement;
    expect(badge).not.toBeNull();
    expect(badge.getAttribute("data-source")).toBe("gmail");
    expect(badge.textContent).toBe("Gmail");
  });

  // AC16
  it("AC16: renders Sim badge for channel='email_sim'", () => {
    const { container } = render(<SourceBadge channel="email_sim" />);
    const badge = container.firstElementChild as HTMLElement;
    expect(badge).not.toBeNull();
    expect(badge.getAttribute("data-source")).toBe("sim");
    expect(badge.textContent).toBe("Sim");
  });

  // AC18 — Gmail palette: bg-blue-50 + text-blue-700
  it("AC18: Gmail badge uses bg-blue-50 and text-blue-700 (distinct palette)", () => {
    const { container } = render(<SourceBadge channel="email" />);
    const badge = container.firstElementChild as HTMLElement;
    expect(badge.className).toContain("bg-blue-50");
    expect(badge.className).toContain("text-blue-700");

    // StatusBadge uses bg-blue-100 text-blue-800 for "procesando" — NOT bg-blue-50
    expect(badge.className).not.toContain("bg-blue-100");
    expect(badge.className).not.toContain("text-blue-800");
  });

  // AC18 — Sim palette: bg-slate-200 + text-slate-600
  it("AC18: Sim badge uses bg-slate-200 and text-slate-600 (distinct palette)", () => {
    const { container } = render(<SourceBadge channel="email_sim" />);
    const badge = container.firstElementChild as HTMLElement;
    expect(badge.className).toContain("bg-slate-200");
    expect(badge.className).toContain("text-slate-600");

    // StatusBadge  uses bg-slate-100 text-slate-800 (cerrado) and bg-slate-100 text-slate-600 (no_relevante)
    // SeverityBadge uses bg-slate-100 text-slate-700 (low)
    // SourceBadge Sim uses bg-slate-200 — different from all StatusBadge/SeverityBadge bg tokens
    expect(badge.className).not.toContain("bg-slate-100");
    // Text class text-slate-600 appears on StatusBadge no_relevante, but the COMBINED
    // class string "bg-slate-200 text-slate-600" is not present in any other badge.
    // The AC18 requirement says "class combo" — bg-slate-200 is unique to SourceBadge.
  });

  // AC18 — comprehensive check: no StatusBadge-specific background colors leak in
  it("AC18: SourceBadge does not use StatusBadge background colors", () => {
    const statusBadgeBgs = [
      "bg-green-100",
      "bg-yellow-100",
      "bg-red-100",
      "bg-blue-100",
      "bg-sky-100",
      "bg-amber-100",
      "bg-orange-100",
      "bg-rose-100",
      "bg-emerald-100",
      "bg-teal-100",
    ];

    for (const channel of ["email", "email_sim"] as const) {
      const { container } = render(<SourceBadge channel={channel} />);
      const badge = container.firstElementChild as HTMLElement;
      for (const cls of statusBadgeBgs) {
        expect(badge.className).not.toContain(cls);
      }
    }
  });

  // AC18 — no SeverityBadge-specific background colors leak in
  it("AC18: SourceBadge does not use SeverityBadge background colors", () => {
    const severityBadgeBgs = [
      "bg-yellow-100",
      "bg-orange-100",
      "bg-red-100",
    ];

    for (const channel of ["email", "email_sim"] as const) {
      const { container } = render(<SourceBadge channel={channel} />);
      const badge = container.firstElementChild as HTMLElement;
      for (const cls of severityBadgeBgs) {
        expect(badge.className).not.toContain(cls);
      }
    }
  });

  // Null/undefined → "—" dash
  it("renders '—' for null channel", () => {
    render(<SourceBadge channel={null} />);
    expect(screen.getByText("—")).toBeInTheDocument();
  });

  it("renders '—' for undefined channel", () => {
    render(<SourceBadge channel={undefined} />);
    expect(screen.getByText("—")).toBeInTheDocument();
  });

  it("renders '—' for unknown channel (future-proofing)", () => {
    render(<SourceBadge channel="whatsapp" />);
    expect(screen.getByText("—")).toBeInTheDocument();
  });

  // Verify no data-source attribute on the dash fallback
  it("dash fallback has no data-source attribute", () => {
    const { container } = render(<SourceBadge channel={null} />);
    const el = container.firstElementChild as HTMLElement;
    expect(el.hasAttribute("data-source")).toBe(false);
  });

  // a11y: aria-label on Gmail badge
  it("Gmail badge has aria-label='Gmail'", () => {
    const { container } = render(<SourceBadge channel="email" />);
    const badge = container.firstElementChild as HTMLElement;
    expect(badge.getAttribute("aria-label")).toBe("Gmail");
  });

  // a11y: aria-label on Sim badge
  it("Sim badge has aria-label='Sim'", () => {
    const { container } = render(<SourceBadge channel="email_sim" />);
    const badge = container.firstElementChild as HTMLElement;
    expect(badge.getAttribute("aria-label")).toBe("Sim");
  });
});

// ── CasesTable "Fuente" column header test (AC17) ────────────────────────────

/**
 * Minimal CaseRow factory — only fills the fields CasesTable actually accesses.
 * The real CaseRow type has many more fields from the DB schema; we supply enough
 * for the table to render without throwing.
 */
function makeCase(overrides: Partial<CaseRow> = {}): CaseRow {
  return {
    id: "00000000-0000-0000-0000-000000000001",
    tenant_id: "tenant-a",
    policy_number: "POL-001",
    policyholder_name: "Ana García",
    claim_type: "choque",
    status: "procesando",
    confidence_min: 0.85,
    assigned_to: null,
    channel: "email",
    created_at: new Date(Date.now() - 2 * 24 * 60 * 60 * 1000).toISOString(),
    updated_at: new Date().toISOString(),
    closed_at: null,
    severity: null,
    customer_id: null,
    policy_id: null,
    email_message_id: null,
    email_thread_id: null,
    is_claim: true,
    not_relevant_reason: null,
    requires_specialist: false,
    core_external_id: null,
    core_error_message: null,
    core_sent_at: null,
    ...overrides,
  } as unknown as CaseRow;
}

// CasesTable uses useRouter — mock next/navigation
vi.mock("next/navigation", () => ({
  useRouter: () => ({ push: vi.fn() }),
}));

describe("CasesTable — Fuente column", () => {
  // AC17: column header text is "Fuente"
  it("AC17: renders a column header with text 'Fuente'", () => {
    render(<CasesTable cases={[makeCase()]} />);
    // Headers are rendered as <th scope="col"> elements
    const headers = screen.getAllByRole("columnheader");
    const headerTexts = headers.map((h) => h.textContent?.trim());
    expect(headerTexts).toContain("Fuente");
  });

  // AC15 via table rendering
  it("AC15: email channel renders data-source='gmail' cell in CasesTable", () => {
    const { container } = render(
      <CasesTable cases={[makeCase({ channel: "email" })]} />
    );
    const gmailBadge = container.querySelector("[data-source='gmail']");
    expect(gmailBadge).not.toBeNull();
    expect(gmailBadge!.textContent).toBe("Gmail");
  });

  // AC16 via table rendering
  it("AC16: email_sim channel renders data-source='sim' cell in CasesTable", () => {
    const { container } = render(
      <CasesTable cases={[makeCase({ channel: "email_sim" })]} />
    );
    const simBadge = container.querySelector("[data-source='sim']");
    expect(simBadge).not.toBeNull();
    expect(simBadge!.textContent).toBe("Sim");
  });

  it("renders '—' for null channel in CasesTable", () => {
    const { container } = render(
      <CasesTable cases={[makeCase({ channel: null })]} />
    );
    // No source badge present
    expect(container.querySelector("[data-source]")).toBeNull();
    // At least one "—" dash visible
    expect(container.textContent).toContain("—");
  });
});
