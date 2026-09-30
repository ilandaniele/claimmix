/**
 * La pestaña «Trabajo del equipo» de /agente (B9, B10, B11, B13): cuatro
 * secciones editables, la carga de cada persona y los avisos de lo que no anda.
 */

import { cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { TrabajoPanel } from "@/app/(app)/agente/TrabajoPanel";
import { LocaleProvider } from "@/lib/i18n/LocaleContext";

const ANA = "30000000-0000-0000-0000-000000000001";
const FANTASMA = "30000000-0000-0000-0000-0000000000ff";

const POR_DEFECTO = {
  reglas_asignacion: { reglas: [] },
  plazos: [],
  plan_por_tipo: { porTipo: { "*": [{ clave: "revisar", titulo: "Revisar" }] } },
  pesos_puntaje: { severidad: 35, fraude: 25, lesiones: 25 },
};

function datos(guardado: Partial<Record<keyof typeof POR_DEFECTO, unknown>> = {}) {
  return {
    guardado: { reglas_asignacion: null, plazos: null, plan_por_tipo: null, pesos_puntaje: null, ...guardado },
    porDefecto: POR_DEFECTO,
    legales: { art46: { dias: 3 }, art56: { dias: 30, ancla: "listo_para_core" } },
    carga: [
      { id: ANA, full_name: "Ana Pérez", role: "analyst", abiertos: 2 },
      { id: "40000000-0000-0000-0000-000000000001", full_name: "Beto Gómez", role: "admin", abiertos: 0 },
    ],
  };
}

const fetchMock = vi.fn();

function responder(cuerpo: unknown, ok = true) {
  return { ok, json: async () => cuerpo };
}

async function mostrar(guardado = {}, locale: "es-AR" | "en-US" = "es-AR") {
  fetchMock.mockResolvedValueOnce(responder(datos(guardado)));
  render(
    <LocaleProvider locale={locale}>
      <TrabajoPanel />
    </LocaleProvider>
  );
  await screen.findByRole("heading", { name: locale === "es-AR" ? "Asignación automática" : "Automatic assignment" });
}

const seccion = (titulo: string) => screen.getByRole("region", { name: titulo });
const patchs = () => fetchMock.mock.calls.filter(([, init]) => init?.method === "PATCH");

beforeEach(() => {
  fetchMock.mockReset();
  vi.stubGlobal("fetch", fetchMock);
});

afterEach(() => vi.unstubAllGlobals());

describe("TrabajoPanel: carga", () => {
  it("pide la configuración sin caché y muestra las cuatro secciones", async () => {
    await mostrar();

    expect(fetchMock.mock.calls[0]).toEqual(["/api/admin/trabajo", { cache: "no-store" }]);
    for (const titulo of ["Asignación automática", "Plazos", "Plan de trabajo por tipo", "Puntaje de complejidad"]) {
      expect(screen.getByRole("heading", { name: titulo })).toBeInTheDocument();
    }
  });

  it("dice «Cargando…» hasta que llega", () => {
    fetchMock.mockReturnValue(new Promise(() => {}));
    render(
      <LocaleProvider locale="es-AR">
        <TrabajoPanel />
      </LocaleProvider>
    );

    expect(screen.getByText("Cargando…")).toBeInTheDocument();
  });

  it("si el servidor rechaza, muestra su motivo (la migración pendiente, por ejemplo)", async () => {
    fetchMock.mockResolvedValueOnce(
      responder({ error: { code: "MIGRACION_PENDIENTE", message: "Falta aplicar la migración 0042." } }, false)
    );
    render(
      <LocaleProvider locale="es-AR">
        <TrabajoPanel />
      </LocaleProvider>
    );

    expect(await screen.findByRole("alert")).toHaveTextContent("Falta aplicar la migración 0042.");
  });

  it("sin motivo ni red, el aviso genérico", async () => {
    fetchMock.mockResolvedValueOnce({ ok: false, json: async () => Promise.reject(new Error("no json")) });
    render(
      <LocaleProvider locale="es-AR">
        <TrabajoPanel />
      </LocaleProvider>
    );

    expect(await screen.findByRole("alert")).toHaveTextContent("No se pudo cargar la configuración de trabajo.");
  });

  it("habla en inglés con el locale en-US", async () => {
    await mostrar({}, "en-US");

    expect(screen.getByRole("heading", { name: "Complexity score" })).toBeInTheDocument();
    expect(within(seccion("Automatic assignment")).getByText("Ana Pérez · 2 open")).toBeInTheDocument();
  });
});

describe("TrabajoPanel: contenido", () => {
  it("la ayuda de la asignación dice lo que hace el código: sólo el agente asigna y sin reglas no hay asignación", async () => {
    await mostrar();
    const ayuda = within(seccion("Asignación automática")).getByText(/Sólo la hace el agente/);
    expect(ayuda).toHaveTextContent(/Sin reglas, el caso queda sin asignar/);
    expect(ayuda).toHaveTextContent(/si una persona cambia el estado, la asignación queda como está/);
    cleanup();

    await mostrar({}, "en-US");
    const help = within(seccion("Automatic assignment")).getByText(/Only the agent does it/);
    expect(help).toHaveTextContent(/With no rules, the case stays unassigned/);
  });

  it("lista la carga actual de cada persona", async () => {
    await mostrar();

    const asignacion = seccion("Asignación automática");
    expect(within(asignacion).getByText("Ana Pérez · 2 abiertos")).toBeInTheDocument();
    expect(within(asignacion).getByText("Beto Gómez · 0 abiertos")).toBeInTheDocument();
  });

  it("marca «usuario inexistente» a quien las reglas nombran y ya no está en el equipo", async () => {
    await mostrar({ reglas_asignacion: { reglas: [{ personas: [ANA, FANTASMA] }, { personas: [FANTASMA] }] } });

    const asignacion = seccion("Asignación automática");
    const inexistente = within(asignacion).getAllByText(/usuario inexistente/);
    expect(inexistente).toHaveLength(1);
    expect(inexistente[0]!.closest("li")).toHaveTextContent(FANTASMA);
    expect(within(asignacion).getByText("Personas nombradas en las reglas")).toBeInTheDocument();
  });

  it("sin reglas no hay lista de personas nombradas", async () => {
    await mostrar();

    expect(screen.queryByText("Personas nombradas en las reglas")).toBeNull();
    expect(screen.queryByText(/usuario inexistente/)).toBeNull();
  });

  it("no se cae con reglas guardadas que no tienen la forma esperada", async () => {
    await mostrar({ reglas_asignacion: { reglas: [null, { personas: "ana" }, { personas: [1, ANA] }] } });

    expect(screen.queryByText(/usuario inexistente/)).toBeNull();
  });

  it("muestra los plazos de la ley como texto fijo, con los días del servidor", async () => {
    await mostrar();

    const plazos = seccion("Plazos");
    expect(within(plazos).getByText(/Denuncia del siniestro \(art\. 46\): 3 días desde el hecho hasta la denuncia/)).toBeInTheDocument();
    expect(within(plazos).getByText(/Pronunciamiento del asegurador \(art\. 56\): 30 días desde que la información está completa/)).toBeInTheDocument();
  });

  it("los pesos llevan la leyenda de desde cuándo rigen", async () => {
    await mostrar();

    expect(
      within(seccion("Puntaje de complejidad")).getByText(
        "Los pesos nuevos rigen desde la próxima extracción, confirmación o presupuesto de cada caso."
      )
    ).toBeInTheDocument();
  });

  it("dice si la sección usa los valores por defecto o una configuración propia", async () => {
    await mostrar({ plazos: [{ clave: "x" }] });

    expect(within(seccion("Plazos")).getByText("Configuración propia")).toBeInTheDocument();
    expect(within(seccion("Puntaje de complejidad")).getByText("Valores por defecto")).toBeInTheDocument();
  });

  it("sin configuración propia el texto parte de lo que rige; con una propia, de lo guardado", async () => {
    const propios = [{ clave: "informe", titulo: "Informe", dias: 10, ancla: "recibido" }];
    await mostrar({ plazos: propios });

    expect(screen.getByRole("textbox", { name: "Plan de trabajo por tipo" })).toHaveValue(
      JSON.stringify(POR_DEFECTO.plan_por_tipo, null, 2)
    );
    expect(screen.getByRole("textbox", { name: "Plazos" })).toHaveValue(JSON.stringify(propios, null, 2));
  });
});

describe("TrabajoPanel: guardar", () => {
  it("manda PATCH con el campo y el valor que se editó, y confirma", async () => {
    await mostrar();
    fetchMock.mockResolvedValueOnce(responder({ campo: "plazos", valor: [] }));

    const nuevo = [{ clave: "informe", titulo: "Informe", dias: 10, ancla: "recibido" }];
    fireEvent.change(screen.getByRole("textbox", { name: "Plazos" }), { target: { value: JSON.stringify(nuevo) } });
    fireEvent.click(within(seccion("Plazos")).getByRole("button", { name: "Guardar" }));

    expect(await within(seccion("Plazos")).findByRole("status")).toHaveTextContent("Guardado.");
    expect(patchs()).toHaveLength(1);
    expect(patchs()[0]![0]).toBe("/api/admin/trabajo");
    expect(JSON.parse(patchs()[0]![1].body)).toEqual({ campo: "plazos", valor: nuevo });
    expect(within(seccion("Plazos")).getByText("Configuración propia")).toBeInTheDocument();
  });

  it("un JSON roto no sale del navegador", async () => {
    await mostrar();

    fireEvent.change(screen.getByRole("textbox", { name: "Plazos" }), { target: { value: "[{" } });
    fireEvent.click(within(seccion("Plazos")).getByRole("button", { name: "Guardar" }));

    expect(await within(seccion("Plazos")).findByRole("status")).toHaveTextContent("El texto no es un JSON válido.");
    expect(patchs()).toHaveLength(0);
  });

  it("si el servidor rechaza, muestra por qué y deja lo escrito", async () => {
    await mostrar();
    fetchMock.mockResolvedValueOnce(
      responder({ error: { code: "VALIDATION_FAILED", message: "valor.0.clave: clave repetida o reservada" } }, false)
    );

    fireEvent.change(screen.getByRole("textbox", { name: "Plazos" }), { target: { value: '[{"clave":"art46"}]' } });
    fireEvent.click(within(seccion("Plazos")).getByRole("button", { name: "Guardar" }));

    expect(await within(seccion("Plazos")).findByRole("status")).toHaveTextContent(
      "valor.0.clave: clave repetida o reservada"
    );
    expect(screen.getByRole("textbox", { name: "Plazos" })).toHaveValue('[{"clave":"art46"}]');
    expect(within(seccion("Plazos")).getByText("Valores por defecto")).toBeInTheDocument();
  });

  it("sin red avisa que no se pudo guardar", async () => {
    await mostrar();
    fetchMock.mockRejectedValueOnce(new Error("sin red"));

    fireEvent.click(within(seccion("Plazos")).getByRole("button", { name: "Guardar" }));

    expect(await within(seccion("Plazos")).findByRole("status")).toHaveTextContent("No se pudo guardar.");
  });

  it("guardar un valor propio de reglas actualiza la lista de personas nombradas", async () => {
    await mostrar();
    fetchMock.mockResolvedValueOnce(responder({}));

    const reglas = { reglas: [{ personas: [FANTASMA] }] };
    fireEvent.change(screen.getByRole("textbox", { name: "Asignación automática" }), {
      target: { value: JSON.stringify(reglas) },
    });
    fireEvent.click(within(seccion("Asignación automática")).getByRole("button", { name: "Guardar" }));

    expect(await within(seccion("Asignación automática")).findByText(/usuario inexistente/)).toBeInTheDocument();
  });
});

describe("TrabajoPanel: volver al valor por defecto", () => {
  it("con lo por defecto el botón está apagado: no hay nada que restablecer", async () => {
    await mostrar();

    expect(within(seccion("Plazos")).getByRole("button", { name: "Volver al valor por defecto" })).toBeDisabled();
  });

  it("manda valor null, repone el texto por defecto y vuelve a decir «por defecto»", async () => {
    await mostrar({ plazos: [{ clave: "informe", titulo: "Informe", dias: 10, ancla: "recibido" }] });
    fetchMock.mockResolvedValueOnce(responder({ campo: "plazos", valor: null }));

    fireEvent.click(within(seccion("Plazos")).getByRole("button", { name: "Volver al valor por defecto" }));

    await waitFor(() => expect(within(seccion("Plazos")).getByText("Valores por defecto")).toBeInTheDocument());
    expect(JSON.parse(patchs()[0]![1].body)).toEqual({ campo: "plazos", valor: null });
    expect(screen.getByRole("textbox", { name: "Plazos" })).toHaveValue("[]");
  });
});
