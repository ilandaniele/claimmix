/**
 * `Refrescar` de /preparando y el botón de los formularios del número.
 *
 * El refresco de cada 5 s tiene que ceder cuando alguien está escribiendo el
 * código o un pedido del número va en camino: si no, pisaría lo que se escribe y
 * la respuesta que vuelve. `BotonDeEnvio` es la marca de «va en camino»
 * (`aria-busy`) y lo que impide un segundo clic.
 */

import { act, cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const h = vi.hoisted(() => ({ refresh: vi.fn() }));

vi.mock("next/navigation", () => ({ useRouter: () => ({ refresh: h.refresh }) }));

import { BotonDeEnvio } from "@/app/(app)/configuracion/BotonDeEnvio";
import { Refrescar } from "@/app/preparando/Refrescar";

beforeEach(() => {
  vi.clearAllMocks();
  vi.useFakeTimers();
});

afterEach(() => {
  cleanup();
  vi.useRealTimers();
});

const pasar = (ms: number) =>
  act(() => {
    vi.advanceTimersByTime(ms);
  });

describe("Refrescar", () => {
  it("pide la pantalla de nuevo cada 5 segundos y no dibuja nada", () => {
    const { container } = render(<Refrescar />);

    expect(container).toBeEmptyDOMElement();
    pasar(4_999);
    expect(h.refresh).not.toHaveBeenCalled();
    pasar(1);
    expect(h.refresh).toHaveBeenCalledTimes(1);
    pasar(10_000);
    expect(h.refresh).toHaveBeenCalledTimes(3);
  });

  it("al salir deja de refrescar", () => {
    const { unmount } = render(<Refrescar />);
    unmount();

    pasar(20_000);
    expect(h.refresh).not.toHaveBeenCalled();
  });

  it.each(["input", "textarea"] as const)("no refresca mientras alguien escribe en un %s, y retoma al soltarlo", (etiqueta) => {
    render(
      <>
        <Refrescar />
        {etiqueta === "input" ? <input aria-label="campo" /> : <textarea aria-label="campo" />}
      </>
    );
    const campo = screen.getByLabelText("campo");

    act(() => campo.focus());
    pasar(15_000);
    expect(h.refresh).not.toHaveBeenCalled();

    act(() => campo.blur());
    pasar(5_000);
    expect(h.refresh).toHaveBeenCalledTimes(1);
  });

  it("un botón con el foco no frena el refresco", () => {
    render(
      <>
        <Refrescar />
        <button type="button">Reintentar</button>
      </>
    );

    act(() => screen.getByRole("button", { name: "Reintentar" }).focus());
    pasar(5_000);
    expect(h.refresh).toHaveBeenCalledTimes(1);
  });

  it("no refresca mientras algo de la página está ocupado (aria-busy), y retoma cuando termina", () => {
    render(
      <>
        <Refrescar />
        <button type="submit" aria-busy="true">
          Por SMS
        </button>
      </>
    );

    pasar(15_000);
    expect(h.refresh).not.toHaveBeenCalled();

    act(() => screen.getByRole("button", { name: "Por SMS" }).setAttribute("aria-busy", "false"));
    pasar(5_000);
    expect(h.refresh).toHaveBeenCalledTimes(1);
  });
});

describe("BotonDeEnvio", () => {
  it("es un botón de envío con su nombre, su valor y su clase, sin apagar", () => {
    render(
      <form>
        <BotonDeEnvio name="metodo" value="VOICE" className="clase-x">
          Por llamada
        </BotonDeEnvio>
      </form>
    );

    const boton = screen.getByRole("button", { name: "Por llamada" });
    expect(boton).toHaveAttribute("type", "submit");
    expect(boton).toHaveAttribute("name", "metodo");
    expect(boton).toHaveAttribute("value", "VOICE");
    expect(boton).toHaveClass("clase-x");
    expect(boton).toBeEnabled();
    expect(boton).toHaveAttribute("aria-busy", "false");
  });

  it("sin nombre ni valor no escribe esos atributos", () => {
    render(
      <form>
        <BotonDeEnvio className="clase-x">Conectar</BotonDeEnvio>
      </form>
    );

    const boton = screen.getByRole("button", { name: "Conectar" });
    expect(boton).not.toHaveAttribute("name");
    expect(boton).not.toHaveAttribute("value");
  });

  it("mientras el pedido va se apaga y se marca ocupado; al volver se prende", async () => {
    let terminar: () => void = () => {};
    const accion = vi.fn(() => new Promise<void>((ok) => (terminar = ok)));
    render(
      <form action={accion}>
        <BotonDeEnvio name="metodo" value="SMS" className="clase-x">
          Por SMS
        </BotonDeEnvio>
      </form>
    );
    const boton = screen.getByRole("button", { name: "Por SMS" });

    await act(async () => {
      fireEvent.click(boton);
    });

    expect(accion).toHaveBeenCalledTimes(1);
    expect(boton).toBeDisabled();
    expect(boton).toHaveAttribute("aria-busy", "true");

    await act(async () => {
      terminar();
    });

    expect(boton).toBeEnabled();
    expect(boton).toHaveAttribute("aria-busy", "false");
  });

  it("el pedido en camino frena a Refrescar, y al volver retoma", async () => {
    let terminar: () => void = () => {};
    const accion = vi.fn(() => new Promise<void>((ok) => (terminar = ok)));
    render(
      <>
        <Refrescar />
        <form action={accion}>
          <BotonDeEnvio className="clase-x">Por SMS</BotonDeEnvio>
        </form>
      </>
    );

    await act(async () => {
      fireEvent.click(screen.getByRole("button", { name: "Por SMS" }));
    });
    pasar(15_000);
    expect(h.refresh).not.toHaveBeenCalled();

    await act(async () => {
      terminar();
    });
    pasar(5_000);
    expect(h.refresh).toHaveBeenCalledTimes(1);
  });
});
