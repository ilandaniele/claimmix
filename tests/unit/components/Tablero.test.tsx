/**
 * G36: el tablero de la bandeja — seis columnas, de sólo lectura.
 *
 * Sin arrastrar y sin botones de estado: cada tarjeta y cada "ver todos" son
 * enlaces de navegación, no acciones que llamen a la API.
 */

import { render, screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import { Tablero } from "../../../src/app/(app)/bandeja/components/Tablero";
import { LocaleProvider } from "../../../src/lib/i18n/LocaleContext";
import type { CaseRow } from "../../../src/server/cases/list";
import type { ClaveDeEstado } from "../../../src/core/case/filtro-de-estado";

function makeCase(overrides: Partial<CaseRow> = {}): CaseRow {
  return {
    id: "00000000-0000-0000-0000-000000000001",
    tenant_id: "tenant-1",
    policy_number: "POL-001",
    policyholder_name: "Juan Pérez",
    claim_type: "choque",
    status: "recibido",
    confidence_min: 0.85,
    assigned_to: null,
    channel: "email_sim",
    created_at: new Date().toISOString(),
    updated_at: null,
    closed_at: null,
    severity: null,
    ...overrides,
  } as CaseRow;
}

const TOTALES: Record<ClaveDeEstado, number> = {
  procesando: 5,
  esperando: 0,
  confirmacion_pendiente: 0,
  escalado: 1,
  listo: 0,
  cerrado: 0,
};

function montar(casos: CaseRow[]) {
  return render(
    <LocaleProvider locale="es-AR">
      <Tablero casos={casos} totales={TOTALES} />
    </LocaleProvider>
  );
}

describe("Tablero — columnas", () => {
  it("dibuja las seis columnas del filtro de estado, en su orden", () => {
    montar([]);
    const titulos = screen.getAllByRole("heading", { level: 3 }).map((h) => h.textContent);
    expect(titulos).toEqual([
      "Procesando",
      "Esperando",
      "Confirmación pendiente",
      "Escalados",
      "Listos",
      "Cerrados",
    ]);
  });
});

describe("Tablero — tarjetas", () => {
  it("cada tarjeta enlaza al detalle del caso", () => {
    montar([makeCase({ id: "11111111-1111-1111-1111-111111111111", status: "recibido" })]);
    const link = screen.getByText("SIN-1111-1111").closest("a");
    expect(link).toHaveAttribute("href", "/casos/11111111-1111-1111-1111-111111111111");
  });

  it("un caso escalado cae sólo en la columna escalado", () => {
    montar([makeCase({ id: "22222222-2222-2222-2222-222222222222", status: "requiere_especialista" })]);
    expect(screen.getByText("SIN-2222-2222")).toBeInTheDocument();
    // Las otras cinco columnas quedan vacías.
    expect(screen.getAllByText("Sin casos en esta columna.")).toHaveLength(5);
  });
});

describe('Tablero — "ver todos"', () => {
  it("cada columna linkea a /bandeja?status=<clave>", () => {
    montar([]);
    const links = screen.getAllByText("Ver todos");
    expect(links.map((l) => l.getAttribute("href"))).toEqual([
      "/bandeja?status=procesando",
      "/bandeja?status=esperando",
      "/bandeja?status=confirmacion_pendiente",
      "/bandeja?status=escalado",
      "/bandeja?status=listo",
      "/bandeja?status=cerrado",
    ]);
  });
});

describe("Tablero — de sólo lectura", () => {
  it("no dibuja ningún botón: nada arrastra ni llama a la API", () => {
    const { container } = montar([makeCase()]);
    expect(container.querySelectorAll("button")).toHaveLength(0);
    expect(container.querySelectorAll("[draggable='true']")).toHaveLength(0);
  });
});
