/**
 * G36: el tablero de la bandeja — seis columnas, de sólo lectura.
 *
 * Sin arrastrar y sin botones de estado: cada tarjeta y cada "ver todos" son
 * enlaces de navegación, no acciones que llamen a la API.
 */

import { render, screen, within } from "@testing-library/react";
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

function montar(casos: CaseRow[], paramsActuales = "vista=tablero") {
  return render(
    <LocaleProvider locale="es-AR">
      <Tablero
        casos={casos}
        totales={TOTALES}
        tiposPropios={[{ clave: "granizo", nombre: "Granizo" }]}
        paramsActuales={paramsActuales}
      />
    </LocaleProvider>
  );
}

const hace = (dias: number) => new Date(Date.now() - dias * 86_400_000).toISOString();

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
    // Las otras cinco columnas quedan vacías, colapsadas.
    expect(screen.getAllByRole("group", { name: "Sin casos en esta columna." })).toHaveLength(5);
  });

  it("la tarjeta muestra el tipo, cuánto hace que entró y a quién está asignada", () => {
    montar([makeCase({ claim_type: "choque", created_at: hace(3), assigned_to: "u1", assigned_name: "Ana Gómez" })]);
    expect(screen.getByText("Choque")).toBeInTheDocument();
    expect(screen.getByText("Hace 3d")).toBeInTheDocument();
    expect(screen.getByText("Ana Gómez")).toBeInTheDocument();
  });

  it("un caso sin asignar lo dice, y uno asignado sin nombre dice Asignado", () => {
    montar([
      makeCase({ id: "33333333-3333-3333-3333-333333333333", assigned_to: null }),
      makeCase({ id: "44444444-4444-4444-4444-444444444444", assigned_to: "u1", assigned_name: null }),
    ]);
    expect(screen.getByText("Sin asignar")).toBeInTheDocument();
    expect(screen.getByText("Asignado")).toBeInTheDocument();
  });

  it("un tipo propio de la aseguradora se lee con su nombre, no con la clave", () => {
    montar([makeCase({ claim_type: "granizo" as CaseRow["claim_type"] })]);
    expect(screen.getByText("Granizo")).toBeInTheDocument();
  });

  it("junto al nombre va la póliza", () => {
    montar([makeCase({ policyholder_name: "Juan Pérez", policy_number: "POL-001" })]);
    expect(screen.getByText("Juan Pérez")).toBeInTheDocument();
    expect(screen.getByText("POL-001")).toBeInTheDocument();
  });

  it("sin nombre se ve la póliza", () => {
    montar([makeCase({ policyholder_name: null, policy_number: "POL-777" })]);
    expect(screen.getByText("POL-777")).toBeInTheDocument();
  });

  it("sin nombre ni póliza se ve el guión", () => {
    montar([makeCase({ policyholder_name: null, policy_number: null })]);
    expect(screen.getByLabelText("Sin dato")).toHaveTextContent("—");
  });
});

describe("Tablero — columna vacía", () => {
  it("se colapsa: conserva el rótulo y el total, sin texto, enlace ni botón", () => {
    montar([makeCase({ status: "requiere_especialista" })]);
    // La primera colapsada es «Procesando», que tiene 5 en total.
    const [columna] = screen.getAllByRole("group", { name: "Sin casos en esta columna." });
    expect(within(columna).getByRole("heading", { level: 3 })).toHaveTextContent("Procesando");
    expect(columna).toHaveTextContent("5");
    expect(columna).toHaveAttribute("title", "Sin casos en esta columna.");
    expect(columna.className).toContain("w-10");
    expect(columna.querySelector("a, button, p")).toBeNull();
    expect(screen.queryByText("Sin casos en esta columna.")).not.toBeInTheDocument();
  });
});

describe('Tablero — "Ver todos"', () => {
  const UNO_POR_COLUMNA = [
    "procesando",
    "esperando",
    "confirmacion_pendiente",
    "escalado",
    "listo",
    "cerrado",
  ].map((status, i) =>
    makeCase({ id: `${i + 1}0000000-0000-0000-0000-000000000000`, status: status as CaseRow["status"] })
  );

  it("cada columna con casos linkea a /bandeja?status=<clave>", () => {
    montar(UNO_POR_COLUMNA, "");
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

  it("conserva la búsqueda, la cola y el tipo; cambia el estado y no lleva ni vista ni página", () => {
    montar(
      [makeCase({ status: "requiere_especialista" })],
      "q=perez&cola=mia&type=choque&status=listo&vista=tablero&page=3"
    );
    expect(screen.getByText("Ver todos")).toHaveAttribute(
      "href",
      "/bandeja?q=perez&cola=mia&type=choque&status=escalado"
    );
  });

  it("una columna vacía no ofrece «Ver todos»", () => {
    montar([makeCase({ status: "requiere_especialista" })]);
    expect(screen.getAllByText("Ver todos")).toHaveLength(1);
  });
});

describe("Tablero — de sólo lectura", () => {
  it("no dibuja ningún botón: nada arrastra ni llama a la API", () => {
    const { container } = montar([makeCase()]);
    expect(container.querySelectorAll("button")).toHaveLength(0);
    expect(container.querySelectorAll("[draggable='true']")).toHaveLength(0);
  });
});
