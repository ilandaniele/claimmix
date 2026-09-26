/**
 * Una fila por hecho, con la barra de confianza sólo en los campos clave y lo
 * demás plegado en «Ver datos técnicos».
 */

import { render, screen, within } from "@testing-library/react";
import { describe, it, expect } from "vitest";
import { LocaleProvider } from "@/lib/i18n/LocaleContext";
import { ExtractedFieldsTable } from "@/app/(app)/casos/[id]/components/ExtractedFieldsTable";

const HOY = "2026-09-22";

function field(overrides: {
  id: string;
  field_key: string;
  field_value: string;
  confidence: number;
  extracted_at?: string;
}) {
  return {
    case_id: "caso-1",
    tenant_id: "tenant-1",
    extracted_at: "2026-09-01T10:00:00Z",
    ...overrides,
  };
}

function show(fields: ReturnType<typeof field>[]) {
  return render(
    <LocaleProvider locale="es-AR">
      <ExtractedFieldsTable fields={fields} hoy={HOY} />
    </LocaleProvider>
  );
}

describe("ExtractedFieldsTable", () => {
  it("dos alias del mismo dato dan una fila con la confianza más alta", () => {
    show([
      field({ id: "1", field_key: "numero_poliza", field_value: "POL-1", confidence: 0.8 }),
      field({ id: "2", field_key: "policy_number", field_value: "POL-1", confidence: 0.95 }),
    ]);

    expect(screen.getAllByText("Número de póliza")).toHaveLength(1);
    expect(screen.getByRole("meter")).toHaveAttribute("aria-label", "Confianza: 95%");
  });

  it("hay_heridos y heridos dan una sola fila «Hay heridos»", () => {
    show([
      field({ id: "1", field_key: "hay_heridos", field_value: "none", confidence: 0.9 }),
      field({ id: "2", field_key: "heridos", field_value: "none", confidence: 0.6 }),
    ]);

    expect(screen.getAllByText("Hay heridos")).toHaveLength(1);
  });

  it("un email sin arroba no se muestra", () => {
    show([field({ id: "1", field_key: "email", field_value: "no-es-un-email", confidence: 0.9 })]);

    expect(screen.queryByText("no-es-un-email")).not.toBeInTheDocument();
  });

  it("una clave desconocida va dentro de «Ver datos técnicos»", () => {
    show([field({ id: "1", field_key: "foo_bar", field_value: "algo", confidence: 0.9 })]);

    const detalle = screen.getByText("Ver datos técnicos").closest("details")!;
    expect(within(detalle).getByText("foo_bar")).toBeInTheDocument();
  });

  it("la barra sólo aparece para los campos clave", () => {
    show([
      field({ id: "1", field_key: "policy_number", field_value: "POL-1", confidence: 0.9 }),
      field({ id: "2", field_key: "hay_heridos", field_value: "none", confidence: 0.9 }),
    ]);

    expect(screen.getAllByRole("meter")).toHaveLength(1);
  });
});
