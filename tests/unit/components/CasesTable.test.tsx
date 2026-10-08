/**
 * AC17: CasesTable renders "Otro" (es-AR) / "Other" (en-US) for claim_type = "other".
 *
 * Also verifies no crash occurs for the "other" value or any unknown claim_type.
 *
 * The LocaleContext default value uses es-AR (DEFAULT_LOCALE), so rendering
 * without a LocaleProvider gives Spanish labels — same pattern as status-badge.test.tsx.
 */

import { readFileSync } from "fs";
import { join } from "path";
import { fireEvent, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, vi } from "vitest";
import { CasesTable } from "../../../src/app/(app)/bandeja/components/CasesTable";
import { LocaleProvider } from "../../../src/lib/i18n/LocaleContext";
import type { CaseRow } from "../../../src/server/cases/list";
import { formatAge, formatDate } from "../../../src/lib/utils";
import { getT } from "../../../src/lib/i18n";

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

describe("CasesTable — columna «Recibido»", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-09-26T12:00:00.000Z"));
  });
  afterEach(() => vi.useRealTimers());

  it("muestra la antigüedad relativa y la fecha completa en el title", () => {
    const iso = "2026-09-26T09:00:00.000Z"; // 3 horas antes
    const cases = [makeCase({ created_at: iso })];
    render(
      <LocaleProvider locale="es-AR">
        <CasesTable cases={cases} />
      </LocaleProvider>
    );

    const t = getT("es-AR");
    const esperado = formatAge(iso, t);
    const elemento = screen.getByText(esperado);
    expect(elemento).toHaveAttribute("title", formatDate(iso, "es-AR"));
  });

  it("en inglés muestra la antigüedad en inglés", () => {
    const iso = "2026-09-26T09:00:00.000Z";
    const cases = [makeCase({ created_at: iso })];
    render(
      <LocaleProvider locale="en-US">
        <CasesTable cases={cases} />
      </LocaleProvider>
    );

    const t = getT("en-US");
    expect(screen.getByText(formatAge(iso, t))).toBeInTheDocument();
  });
});

describe("CasesTable — modo selección", () => {
  const dos = [makeCase(), makeCase({ id: "00000000-0000-0000-0000-000000000002" })];
  function pintar(cases: CaseRow[], seleccionando = true, borrar = vi.fn()) {
    return (
      <LocaleProvider locale="es-AR">
        <CasesTable cases={cases} seleccionando={seleccionando} onDeleteMany={borrar} />
      </LocaleProvider>
    );
  }
  function montar(seleccionando = true) {
    return render(pintar(dos, seleccionando));
  }
  /** La cifra de la barra: cuántas dice que hay marcadas. */
  function cifra() {
    return screen.getByRole("toolbar").querySelector(".cifra");
  }
  function marcada(id: string) {
    return screen.getByRole("checkbox", { name: new RegExp(id) });
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
    rerender(pintar(dos, false));
    expect(screen.queryAllByRole("checkbox")).toHaveLength(0);
    rerender(pintar(dos));
    for (const c of screen.getAllByRole("checkbox")) expect(c).toHaveAttribute("aria-checked", "false");
  });

  // Lo marcado es subconjunto de lo que está en pantalla. Cambiar de página
  // o de filtro poda; una fila nueva o cambiada del polling no toca nada.

  it("cambian las filas y se olvida lo marcado", () => {
    const { rerender } = montar();
    fireEvent.click(screen.getAllByRole("checkbox")[0]);
    rerender(
      pintar([
        makeCase({ id: "00000000-0000-0000-0000-000000000003" }),
        makeCase({ id: "00000000-0000-0000-0000-000000000004" }),
      ])
    );
    for (const c of screen.getAllByRole("checkbox")) expect(c).toHaveAttribute("aria-checked", "false");
    expect(screen.queryByRole("button", { name: /Eliminar seleccionados/ })).toBeNull();
    expect(cifra()).toHaveTextContent("0");
  });

  it("otra referencia con los mismos ids no olvida", () => {
    const { rerender } = montar();
    fireEvent.click(screen.getAllByRole("checkbox")[0]);
    rerender(pintar(dos.map((c) => ({ ...c }))));
    expect(marcada("SIN-0000-0001")).toHaveAttribute("aria-checked", "true");
    expect(screen.getByRole("button", { name: /Eliminar seleccionados \(1\)/ })).toBeInTheDocument();
  });

  it("una fila nueva arriba no toca lo marcado", () => {
    const { rerender } = montar();
    fireEvent.click(marcada("SIN-0000-0001"));
    rerender(pintar([makeCase({ id: "00000000-0000-0000-0000-000000000009" }), ...dos]));
    expect(screen.getAllByRole("checkbox")).toHaveLength(3);
    expect(marcada("SIN-0000-0001")).toHaveAttribute("aria-checked", "true");
    expect(marcada("SIN-0000-0009")).toHaveAttribute("aria-checked", "false");
    expect(cifra()).toHaveTextContent("1");
  });

  it("una fila cambiada en el lugar no toca lo marcado", () => {
    const { rerender } = montar();
    fireEvent.click(marcada("SIN-0000-0001"));
    rerender(pintar([makeCase({ status: "listo" }), dos[1]]));
    expect(marcada("SIN-0000-0001")).toHaveAttribute("aria-checked", "true");
    expect(cifra()).toHaveTextContent("1");
  });

  it("se va una fila marcada y quedan las otras; borrar manda sólo lo visible", () => {
    const borrar = vi.fn();
    const { rerender } = render(pintar(dos, true, borrar));
    fireEvent.click(screen.getByRole("button", { name: /Seleccionar los 2 de esta página/ }));
    rerender(pintar([dos[1]], true, borrar));
    const casillas = screen.getAllByRole("checkbox");
    expect(casillas).toHaveLength(1);
    expect(casillas[0]).toHaveAttribute("aria-checked", "true");
    expect(cifra()).toHaveTextContent("1");
    fireEvent.click(screen.getByRole("button", { name: /Eliminar seleccionados \(1\)/ }));
    expect(borrar).toHaveBeenCalledWith(["00000000-0000-0000-0000-000000000002"]);
  });

  // La papelera por fila vive con sólo tener `onDeleteMany`, dentro y fuera del
  // modo: por eso se monta con `seleccionando = false`.
  it("la papelera de una fila pide borrar sólo esa y no navega", () => {
    const borrar = vi.fn();
    render(pintar(dos, false, borrar));
    push.mockClear();
    fireEvent.click(screen.getAllByRole("button", { name: "Eliminar caso" })[0]);
    expect(borrar).toHaveBeenCalledWith(["00000000-0000-0000-0000-000000000001"]);
    expect(push).not.toHaveBeenCalled();
  });

  it("lista vacía y de vuelta: nada marcado", () => {
    const { rerender } = montar();
    fireEvent.click(screen.getAllByRole("checkbox")[0]);
    rerender(pintar([]));
    rerender(pintar(dos));
    for (const c of screen.getAllByRole("checkbox")) expect(c).toHaveAttribute("aria-checked", "false");
    expect(cifra()).toHaveTextContent("0");
  });
});

// E19d: sale @tanstack/react-table de esta tabla; el render tiene que ser el
// mismo antes y después. La comprobación de fuente falla antes del cambio.
describe("CasesTable — sin @tanstack/react-table", () => {
  it("no importa @tanstack/react-table", () => {
    const src = readFileSync(
      join(__dirname, "../../../src/app/(app)/bandeja/components/CasesTable.tsx"),
      "utf-8"
    );
    expect(src).not.toContain("@tanstack/react-table");
  });
});

describe("CasesTable — snapshot del render (E19d)", () => {
  const filaCompleta = makeCase({
    id: "00000000-0000-0000-0000-0000000000f1",
    policy_number: "POL-777",
    policyholder_name: "Marta Gómez",
    claim_type: "robo",
    channel: "whatsapp",
    status: "listo",
    replied_at: "2026-09-27T10:00:00.000Z",
    confidence_min: "0.62",
    created_at: "2026-09-27T09:00:00.000Z",
    severity: "high",
    assigned_to: "user-1",
    assigned_name: "Ana Torres",
    fecha_siniestro: "2026-09-20",
  } as Partial<CaseRow>);

  beforeEach(() => {
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(new Date("2026-09-27T12:00:00Z"));
  });
  afterEach(() => vi.useRealTimers());

  it("modo normal", () => {
    const { container } = render(
      <LocaleProvider locale="es-AR">
        <CasesTable cases={[filaCompleta]} />
      </LocaleProvider>
    );
    expect(container.innerHTML).toMatchSnapshot();
  });

  it("con onDeleteMany", () => {
    const { container } = render(
      <LocaleProvider locale="es-AR">
        <CasesTable cases={[filaCompleta]} onDeleteMany={vi.fn()} />
      </LocaleProvider>
    );
    expect(container.innerHTML).toMatchSnapshot();
  });

  it("con onDeleteMany + seleccionando y una fila marcada", () => {
    const { container } = render(
      <LocaleProvider locale="es-AR">
        <CasesTable cases={[filaCompleta]} onDeleteMany={vi.fn()} seleccionando />
      </LocaleProvider>
    );
    fireEvent.click(screen.getByRole("checkbox"));
    expect(container.innerHTML).toMatchSnapshot();
  });
});

describe("CasesTable — vista de descartes", () => {
  const descarte = makeCase({
    id: "00000000-0000-0000-0000-0000000000d1",
    is_claim: false,
    claim_type: "robo",
    channel: "email",
    status: "no_relevante",
    asunto: "Promo de fin de mes",
    remitente: "ventas@example.com",
    not_relevant_reason: "Es publicidad de un comercio, no una denuncia",
    confidence_min: "0.91",
    vence_en: null,
    puntaje_complejidad: null,
  } as Partial<CaseRow>);

  function pintar(cases: CaseRow[], descartes = true) {
    return render(
      <LocaleProvider locale="es-AR">
        <CasesTable cases={cases} descartes={descartes} />
      </LocaleProvider>
    );
  }

  it("muestra el asunto, el remitente y el motivo, y saca tipo, respondido y score", () => {
    pintar([descarte]);
    expect(screen.getByText("Promo de fin de mes")).toBeInTheDocument();
    expect(screen.getByText("ventas@example.com")).toBeInTheDocument();
    expect(screen.getByText("Es publicidad de un comercio, no una denuncia")).toBeInTheDocument();
    expect(screen.getByRole("columnheader", { name: "Asunto / remitente" })).toBeInTheDocument();
    expect(screen.getByRole("columnheader", { name: "Motivo del descarte" })).toBeInTheDocument();
    expect(screen.queryByRole("columnheader", { name: "Asegurado" })).toBeNull();
    for (const sobra of ["Tipo", "Respondido", "Score"]) {
      expect(screen.queryByRole("columnheader", { name: sobra })).toBeNull();
    }
    expect(screen.queryByText("Robo")).toBeNull();
  });

  it("sin descartes la tabla sigue igual: asegurado, tipo y score, sin motivo", () => {
    pintar([descarte], false);
    expect(screen.getByRole("columnheader", { name: "Asegurado" })).toBeInTheDocument();
    expect(screen.getByRole("columnheader", { name: "Tipo" })).toBeInTheDocument();
    expect(screen.getByRole("columnheader", { name: "Score" })).toBeInTheDocument();
    expect(screen.queryByRole("columnheader", { name: "Motivo del descarte" })).toBeNull();
    expect(screen.queryByText("Promo de fin de mes")).toBeNull();
  });

  it("un motivo con el texto fijo de antes muestra el texto por defecto, no ese", () => {
    pintar([
      {
        ...descarte,
        not_relevant_reason: "El clasificador de IA determinó que este email no es un reclamo de seguro",
      },
    ]);
    expect(screen.getByText("La IA determinó que no es una denuncia")).toBeInTheDocument();
    expect(screen.queryByText(/El clasificador de IA determinó/)).toBeNull();
  });

  it("sin motivo muestra el texto por defecto", () => {
    pintar([{ ...descarte, not_relevant_reason: null }]);
    expect(screen.getByText("La IA determinó que no es una denuncia")).toBeInTheDocument();
  });

  it("sin asunto pone «(sin asunto)» y sin remitente no pinta renglón", () => {
    pintar([{ ...descarte, asunto: null, remitente: null }]);
    expect(screen.getByText("(sin asunto)")).toBeInTheDocument();
    expect(screen.queryByText("ventas@example.com")).toBeNull();
  });

  it("el motivo es texto plano: un tag del modelo no se interpreta", () => {
    const { container } = pintar([{ ...descarte, not_relevant_reason: "<b>negrita</b> y <img src=x>" }]);
    expect(screen.getByText("<b>negrita</b> y <img src=x>")).toBeInTheDocument();
    expect(container.querySelector("img")).toBeNull();
  });

  it("el piso de ancho suma el motivo y resta lo que no se pinta", () => {
    const ancho = (c: HTMLElement) => Number(c.querySelector("table")!.style.minWidth.replace("px", ""));
    const normal = pintar([descarte], false);
    const completa = ancho(normal.container);
    normal.unmount();
    const vista = pintar([descarte]);
    expect(ancho(vista.container)).not.toBe(completa);
    expect(ancho(vista.container)).toBeGreaterThan(0);
  });
});

describe("CasesTable — columnas vacías", () => {
  function pintar(cases: CaseRow[]) {
    return render(
      <LocaleProvider locale="es-AR">
        <CasesTable cases={cases} />
      </LocaleProvider>
    );
  }
  const sinDato = { vence_en: null, puntaje_complejidad: null } as Partial<CaseRow>;

  it("Vence y Complejidad no se pintan si ninguna fila de la página trae dato", () => {
    pintar([makeCase(sinDato), makeCase({ ...sinDato, id: "00000000-0000-0000-0000-000000000002" })]);
    expect(screen.queryByRole("columnheader", { name: "Vence" })).toBeNull();
    expect(screen.queryByRole("columnheader", { name: "Complejidad" })).toBeNull();
  });

  it("alcanza con una fila con dato para que la columna vuelva", () => {
    pintar([
      makeCase(sinDato),
      makeCase({
        ...sinDato,
        id: "00000000-0000-0000-0000-000000000002",
        vence_en: "2026-10-09T12:00:00.000Z",
        puntaje_complejidad: 40,
      }),
    ]);
    expect(screen.getByRole("columnheader", { name: "Vence" })).toBeInTheDocument();
    expect(screen.getByRole("columnheader", { name: "Complejidad" })).toBeInTheDocument();
  });

  it("el piso de ancho baja cuando faltan las dos columnas", () => {
    const ancho = (c: HTMLElement) => Number(c.querySelector("table")!.style.minWidth.replace("px", ""));
    const con = pintar([makeCase({ vence_en: "2026-10-09T12:00:00.000Z", puntaje_complejidad: 40 } as Partial<CaseRow>)]);
    const conAncho = ancho(con.container);
    con.unmount();
    const sin = pintar([makeCase(sinDato)]);
    expect(conAncho - ancho(sin.container)).toBe(190);
  });
});

describe("CasesTable — respondido de un caso de ensayo", () => {
  function pintar(c: CaseRow) {
    return render(
      <LocaleProvider locale="es-AR">
        <CasesTable cases={[c]} />
      </LocaleProvider>
    );
  }

  it("un caso de ensayo no queda «sin responder»", () => {
    for (const channel of ["email_sim", "whatsapp_sim"] as const) {
      const { unmount } = pintar(makeCase({ channel, replied_at: null, para_responder_desde: null } as Partial<CaseRow>));
      expect(screen.queryByText("Sin responder")).toBeNull();
      unmount();
    }
  });

  it("un caso real sin respuesta sigue «sin responder»", () => {
    pintar(makeCase({ channel: "email", replied_at: null, para_responder_desde: null } as Partial<CaseRow>));
    expect(screen.getByText("Sin responder")).toBeInTheDocument();
  });

  it("un caso de ensayo con un mensaje tardío sigue para responder", () => {
    pintar(
      makeCase({ channel: "email_sim", para_responder_desde: "2026-10-07T10:00:00.000Z" } as Partial<CaseRow>)
    );
    expect(screen.getByText(getT("es-AR")("bandeja.paraResponder"))).toBeInTheDocument();
  });
});
