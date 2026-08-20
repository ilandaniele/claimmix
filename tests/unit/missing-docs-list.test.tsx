/**
 * Two different things live in `missing_docs`, and the page was showing them
 * as one.
 *
 * Files the claimant has to send, and fields the extractor was unsure about,
 * are stored in the same table. The agent has always told them apart — it
 * never asked anyone to attach the time of the accident — but the analyst's
 * view did not, so a claim with every document settled still displayed four
 * "documentos pendientes" that were facts, not paper. On a board, that reads
 * as work outstanding on a case that is finished.
 */

import { render, screen, within } from "@testing-library/react";
import { describe, it, expect } from "vitest";
import { LocaleProvider } from "@/lib/i18n/LocaleContext";
import { MissingDocsList } from "@/app/(app)/casos/[id]/components/MissingDocsList";
import type { MissingDocRow } from "@/lib/db/types";

const CASE = "11111111-1111-1111-1111-111111111111";
const TENANT = "10000000-0000-0000-0000-000000000001";

function doc(overrides: Partial<MissingDocRow> & { doc_key: string }): MissingDocRow {
  return {
    id: `row-${overrides.doc_key}`,
    case_id: CASE,
    tenant_id: TENANT,
    requested_at: "2026-08-20T00:00:00Z",
    satisfied_at: null,
    declined_at: null,
    declined_note: null,
    ...overrides,
  } as MissingDocRow;
}

function show(docs: MissingDocRow[]) {
  return render(
    <LocaleProvider locale="es-AR">
      <MissingDocsList docs={docs} />
    </LocaleProvider>
  );
}

describe("MissingDocsList — telling paper from facts", () => {
  const FILE = doc({ doc_key: "fotos_danos" });
  const FACT = doc({ doc_key: "hora_siniestro" });

  it("puts each row under the heading it belongs to", () => {
    show([FILE, FACT]);

    const files = screen.getByRole("region", { name: "Documentación" });
    const facts = screen.getByRole("region", { name: "Datos por confirmar" });

    expect(within(files).getByText("Fotos de los daños")).toBeInTheDocument();
    expect(within(facts).getByText(/hora/i)).toBeInTheDocument();
  });

  it("does not file a fact under the documents heading", () => {
    // The whole point: "Hora del siniestro" listed as documentation is what
    // made a finished case look unfinished.
    show([FILE, FACT]);

    const files = screen.getByRole("region", { name: "Documentación" });
    expect(within(files).queryByText(/hora/i)).not.toBeInTheDocument();
  });

  it("shows one plain list when everything is the same kind", () => {
    // A heading over a single list is noise.
    show([FILE, doc({ doc_key: "licencia_conducir" })]);

    expect(screen.queryByRole("region", { name: "Documentación" })).not.toBeInTheDocument();
    expect(screen.getByText("Fotos de los daños")).toBeInTheDocument();
    expect(screen.getByText("Licencia de conducir")).toBeInTheDocument();
  });

  it("says nothing at all when there is nothing to show", () => {
    show([]);
    expect(screen.getByRole("status")).toHaveTextContent("Sin documentación pendiente.");
  });
});

describe("MissingDocsList — a document nobody has", () => {
  it("reads as 'no lo tienen', never as received", () => {
    // An analyst who reads "Recibido" goes looking for a file that does not
    // exist; one who reads "Pendiente" chases a claimant who already answered.
    show([
      doc({
        doc_key: "parte_amistoso",
        declined_at: "2026-08-20T20:03:00Z",
        declined_note: "No lo quiso hacer el otro conductor",
      }),
    ]);

    expect(screen.getByText("No lo tienen")).toBeInTheDocument();
    expect(screen.queryByText("Recibido")).not.toBeInTheDocument();
    expect(screen.queryByText("Pendiente")).not.toBeInTheDocument();
  });

  it("quotes what they said, so someone can judge whether to insist", () => {
    show([
      doc({
        doc_key: "parte_amistoso",
        declined_at: "2026-08-20T20:03:00Z",
        declined_note: "No lo quiso hacer el otro conductor",
      }),
    ]);

    expect(screen.getByText(/No lo quiso hacer el otro conductor/)).toBeInTheDocument();
  });

  it("still says 'recibido' for a document that actually arrived", () => {
    show([doc({ doc_key: "fotos_danos", satisfied_at: "2026-08-20T19:18:08Z" })]);

    expect(screen.getByText("Recibido")).toBeInTheDocument();
  });
});
