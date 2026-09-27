/**
 * La serie de actividad de /metricas, dibujada.
 *
 * Las barras son clases y no `style`, por la CSP (ver `anchoDeBarra`): lo que se
 * afirma es que la clase refleje la proporción contra el máximo de las TRES
 * series, y que cambiar de unidad sea un enlace y no estado en el navegador.
 */

import { describe, it, expect, vi, afterEach } from "vitest";
import { render, screen, within } from "@testing-library/react";

const enlace = vi.hoisted(() => ({ pending: false }));

// El Link de verdad no deja `scroll` en el DOM: el doble lo muestra.
vi.mock("next/link", async () => {
  const { createElement } = await import("react");
  return {
    default: ({ scroll, ...props }: { scroll?: boolean }) =>
      createElement("a", { ...props, "data-scroll": String(scroll) }),
    useLinkStatus: () => ({ pending: enlace.pending }),
  };
});

import { SerieDeActividad } from "@/app/(app)/metricas/_components/SerieDeActividad";

const SERIE = [
  { clave: "2026-07", reclamos: 0, whatsapps: 0, mails: 0, reclamos_whatsapp: 0, reclamos_mail: 0 },
  { clave: "2026-08", reclamos: 2, whatsapps: 10, mails: 5, reclamos_whatsapp: 1, reclamos_mail: 1 },
  { clave: "2026-09", reclamos: 4, whatsapps: 0, mails: 1, reclamos_whatsapp: 3, reclamos_mail: 1 },
];

function dibujar() {
  render(<SerieDeActividad serie={SERIE} unidad="mes" locale="es-AR" />);
  return screen.getByTestId("serie-actividad");
}

describe("SerieDeActividad", () => {
  it("cambia de unidad con enlaces, y marca la actual", () => {
    const serie = dibujar();

    const enlaces = within(serie).getAllByRole("link");
    expect(enlaces.map((a) => a.getAttribute("href"))).toEqual([
      "/metricas?serie=dia",
      "/metricas?serie=mes",
      "/metricas?serie=anio",
    ]);
    expect(within(serie).getByRole("link", { current: "page" })).toHaveTextContent("Por mes");
    expect(enlaces.filter((a) => a.hasAttribute("aria-current"))).toHaveLength(1);
  });

  describe("mientras el servidor dibuja la unidad nueva", () => {
    afterEach(() => {
      enlace.pending = false;
    });

    // Cambiar `?serie=` no vuelve a mostrar el loading de `(app)`: sin esto,
    // con Neon en frío, la unidad vieja queda marcada unos segundos sin señal.
    it("cada enlace lleva la señal, reservada y apagada mientras no se navega", () => {
      for (const a of within(dibujar()).getAllByRole("link")) {
        expect(within(a).getByTestId("en-camino")).toHaveClass("invisible");
      }
    });

    it("la señal se ve mientras el enlace está en camino", () => {
      enlace.pending = true;

      for (const a of within(dibujar()).getAllByRole("link")) {
        const senal = within(a).getByTestId("en-camino");
        expect(senal).not.toHaveClass("invisible");
        expect(senal).toHaveClass("animate-pulse");
      }
    });
  });

  it("cambiar de unidad no sube la página: la serie está al final", () => {
    const enlaces = within(dibujar()).getAllByRole("link");

    for (const a of enlaces) expect(a).toHaveAttribute("data-scroll", "false");
  });

  it("dice por qué los reclamos pueden no coincidir con el total del mes", () => {
    expect(within(dibujar()).getByText(/sin simulaciones/)).toBeInTheDocument();
  });

  it("rotula los días en el orden de cada idioma, sin correrlos al anterior", () => {
    const dia = [
      { clave: "2026-08-31", reclamos: 1, whatsapps: 0, mails: 0, reclamos_whatsapp: 0, reclamos_mail: 0 },
    ];

    const { unmount } = render(<SerieDeActividad serie={dia} unidad="dia" locale="es-AR" />);
    expect(screen.getByText("31/08/2026")).toBeInTheDocument();
    unmount();

    render(<SerieDeActividad serie={dia} unidad="dia" locale="en-US" />);
    expect(screen.getByText("08/31/2026")).toBeInTheDocument();
    expect(screen.getByRole("link", { current: "page" })).toHaveTextContent("By day");
  });

  it("en inglés, los meses también", () => {
    render(<SerieDeActividad serie={SERIE} unidad="mes" locale="en-US" />);

    expect(screen.getByText("August 2026")).toBeInTheDocument();
    expect(screen.getByText(/no simulations/)).toBeInTheDocument();
  });

  it("dibuja tres barras por período", () => {
    const serie = dibujar();

    expect(within(serie).getAllByTestId("barra")).toHaveLength(SERIE.length * 3);
  });

  it("la barra más larga es el máximo de las tres series, y el cero no se dibuja", () => {
    const barras = within(dibujar()).getAllByTestId("barra");

    // Orden: por período, y adentro reclamos, whatsapps, mails.
    const [julio, agosto, septiembre] = [0, 3, 6].map((i) => barras.slice(i, i + 3));
    expect(agosto[1]).toHaveClass("w-full");
    expect(agosto[2]).toHaveClass("w-[50%]");
    expect(septiembre[0]).toHaveClass("w-[40%]");
    expect(septiembre[1]).toHaveClass("w-0");
    for (const b of julio) expect(b).toHaveClass("w-0");
  });

  it("rotula los meses con su nombre y cada número con su serie", () => {
    const serie = dibujar();

    expect(within(serie).getByText(/agosto de 2026/i)).toBeInTheDocument();
    expect(within(serie).getAllByText(/WhatsApps atendidos/).length).toBeGreaterThan(SERIE.length);
  });

  it("el resumen de arriba: el período actual es el último punto de la serie", () => {
    const resumen = within(dibujar()).getByTestId("resumen-actual");
    // Orden del `<dl>`: reclamos, whatsapps, mails — el mismo de `ColumnaResumen`.
    const valores = within(resumen).getAllByRole("definition").map((el) => el.textContent);

    expect(within(resumen).getByText("Este mes")).toBeInTheDocument();
    expect(valores).toEqual(["4", "0", "1"]);
    expect(within(resumen).getByText("3 por WhatsApp · 1 por mail")).toBeInTheDocument();
  });

  it("el resumen de arriba: la ventana entera es la suma de todos los puntos", () => {
    const resumen = within(dibujar()).getByTestId("resumen-ventana");
    const valores = within(resumen).getAllByRole("definition").map((el) => el.textContent);

    expect(within(resumen).getByText("Últimos 12 meses")).toBeInTheDocument();
    expect(valores).toEqual(["6", "10", "6"]);
    expect(within(resumen).getByText("4 por WhatsApp · 2 por mail")).toBeInTheDocument();
  });

  it("el resumen cambia de rótulo con la unidad", () => {
    render(<SerieDeActividad serie={SERIE} unidad="dia" locale="es-AR" />);
    expect(screen.getByTestId("resumen-actual")).toHaveTextContent("Hoy");
    expect(screen.getByTestId("resumen-ventana")).toHaveTextContent("Últimos 30 días");
  });

  it("el resumen también se traduce", () => {
    render(<SerieDeActividad serie={SERIE} unidad="anio" locale="en-US" />);
    expect(screen.getByTestId("resumen-actual")).toHaveTextContent("This year");
    expect(screen.getByTestId("resumen-ventana")).toHaveTextContent("Last 5 years");
    expect(screen.getByTestId("resumen-actual")).toHaveTextContent("3 via WhatsApp · 1 via email");
  });

  it("sin actividad no divide por cero", () => {
    render(
      <SerieDeActividad
        serie={[
          { clave: "2026", reclamos: 0, whatsapps: 0, mails: 0, reclamos_whatsapp: 0, reclamos_mail: 0 },
        ]}
        unidad="anio"
        locale="en-US"
      />
    );

    for (const b of screen.getAllByTestId("barra")) expect(b).toHaveClass("w-0");
    expect(screen.getByText("2026")).toBeInTheDocument();
    expect(screen.getByRole("link", { current: "page" })).toHaveTextContent("By year");
  });
});
