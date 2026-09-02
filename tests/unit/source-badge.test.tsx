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
import { StatusBadge } from "../../src/app/(app)/bandeja/components/StatusBadge";
import { SeverityBadge } from "../../src/app/(app)/bandeja/components/SeverityBadge";
import type { CaseStatus, Severity } from "../../src/lib/schemas/cases";

/** Los trece estados y las cuatro severidades: todas las variantes, no una muestra. */
const STATUS_VALUES: CaseStatus[] = [
  "procesando",
  "listo",
  "esperando",
  "escalado",
  "cerrado",
  "recibido",
  "info_faltante",
  "confirmacion_pendiente",
  "requiere_especialista",
  "listo_para_core",
  "enviado_a_core",
  "error_core",
  "no_relevante",
];

const SEVERITY_VALUES: Severity[] = ["low", "medium", "high", "critical"];
import { CasesTable } from "../../src/app/(app)/bandeja/components/CasesTable";
import type { CaseRow } from "@/server/cases/list";

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

    // El azul es exclusivo de esta insignia: ninguna de las otras dos lo usa.
    // Quien lo verifica de verdad es el test de colisión de más abajo, que
    // compara contra lo que las otras insignias pintan HOY.
    expect(badge.className).not.toContain("bg-blue-100");
  });

  // AC18 — Sim palette: bg-slate-200 + text-slate-600
  it("AC18: Sim badge uses bg-slate-200 and text-slate-600 (distinct palette)", () => {
    const { container } = render(<SourceBadge channel="email_sim" />);
    const badge = container.firstElementChild as HTMLElement;
    expect(badge.className).toContain("bg-slate-200");
    expect(badge.className).toContain("text-slate-600");

    // Las otras dos insignias usan `bg-slate-100` para su tono gris; ésta usa
    // `bg-slate-200`, un escalón más oscuro, y ésa es toda la diferencia.
    expect(badge.className).not.toContain("bg-slate-100");
  });

  /*
   * AC18, comprobado contra la realidad y no contra una copia.
   *
   * Acá había dos tests que enumeraban a mano los colores que ELLOS CREÍAN que
   * usaban StatusBadge y SeverityBadge —`bg-green-100`, `bg-teal-100`,
   * `bg-rose-100`…— y verificaban que SourceBadge no usara ninguno.
   *
   * Ese trato tiene el problema de siempre con las listas copiadas: cuando la
   * paleta de las otras dos insignias cambió, la lista quedó describiendo
   * colores que ya nadie usa. Y lo peor no es que quedara vieja sino que seguía
   * pasando en verde: comprobaba que SourceBadge no chocara con la paleta de
   * ANTEAYER, mientras que un choque con la de hoy pasaba sin que nadie lo vea.
   *
   * Lo que va en su lugar renderiza las tres insignias, todas sus variantes, y
   * exige que no haya dos que pinten lo mismo. Es la invariante que AC18 quería
   * —que se distingan de un vistazo— y no hay nada que mantener sincronizado:
   * si mañana alguien le pone a un estado el azul de Gmail, esto se pone rojo
   * solo y dice cuáles dos chocaron.
   */
  it("AC18: ninguna de las tres insignias pinta igual que otra", () => {
    const pintura = (el: Element) =>
      (el as HTMLElement).className
        .split(/\s+/)
        .filter((c) => /^(bg|text)-[a-z]+-\d{2,3}$/.test(c))
        .sort()
        .join(" ");

    const pinturasDe = (nodos: (Element | null)[]) => {
      const set = new Set<string>();
      for (const n of nodos) {
        if (!n) continue; // El guion de «sin dato» no es una insignia.
        const p = pintura(n);
        if (p) set.add(p);
      }
      return set;
    };

    /*
     * DENTRO de una familia repetir color es deliberado: los tres estados que
     * piden una persona se ven igual justamente para que se lean como un grupo.
     * Lo que AC18 pide es que no se confundan las FAMILIAS entre sí — que una
     * severidad no se vea como un estado.
     */
    const estado = pinturasDe(
      STATUS_VALUES.map(
        (v) => render(<StatusBadge status={v} />).container.firstElementChild
      )
    );
    const severidad = pinturasDe(
      SEVERITY_VALUES.map(
        (v) => render(<SeverityBadge severity={v} />).container.firstElementChild
      )
    );
    const fuente = pinturasDe(
      (["email", "email_sim"] as const).map(
        (v) => render(<SourceBadge channel={v} />).container.firstElementChild
      )
    );

    // Que haya algo que comparar: si `pintura` dejara de encontrar clases, los
    // tres conjuntos quedarían vacíos y no chocar sería trivialmente cierto.
    expect(estado.size).toBeGreaterThan(0);
    expect(severidad.size).toBeGreaterThan(0);
    expect(fuente.size).toBeGreaterThan(0);

    const pares: [string, Set<string>, string, Set<string>][] = [
      ["estado", estado, "severidad", severidad],
      ["estado", estado, "fuente", fuente],
      ["severidad", severidad, "fuente", fuente],
    ];

    for (const [nombreA, a, nombreB, b] of pares) {
      const chocan = [...a].filter((p) => b.has(p));
      expect(
        chocan,
        `${nombreA} y ${nombreB} pintan igual: ${chocan.join(" | ")}`
      ).toEqual([]);
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
    confidence_min: "0.85",
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
      <CasesTable cases={[makeCase({ channel: null as unknown as CaseRow["channel"] })]} />
    );
    // No source badge present
    expect(container.querySelector("[data-source]")).toBeNull();
    // At least one "—" dash visible
    expect(container.textContent).toContain("—");
  });
});
