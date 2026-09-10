/**
 * El panel de filtros de la bandeja.
 *
 * Lo que se fija acá es, sobre todo, lo que se rompe solo cuando veinte chips
 * se meten atrás de un botón:
 *
 *  · que el estado siga viviendo en la URL y no en un `useState` del panel. De
 *    esa URL cuelgan el permalink, el botón atrás, el enlace «Escalados» de la
 *    barra lateral, el sondeo en vivo y el href del CSV. Un filtro que no llega
 *    a la URL los rompe a los cinco sin que falle nada;
 *  · que cambiar un filtro borre `page`, que es el detalle que `useFilterParam`
 *    ya documenta: filtrar desde la página 4 sin borrarlo deja a alguien en la
 *    página 4 de un conjunto que ahora tiene una;
 *  · que lo que está puesto se lea SIN abrir el panel. Un panel que se traga el
 *    estado es peor que los veinte chips que reemplaza;
 *  · que «Limpiar» sea una sola navegación y no cuatro. De a una, cada llamada
 *    arma su URL sobre la de antes y las tres últimas se pisan.
 */

import { fireEvent, render, screen } from "@testing-library/react";
import { vi, describe, it, expect, beforeEach } from "vitest";
import {
  BotonDeFiltros,
  MarcasDeFiltros,
} from "../../../src/app/(app)/bandeja/components/PanelDeFiltros";
import { NavegacionPendienteProvider } from "../../../src/app/(app)/bandeja/components/navegacion-pendiente";
import { LocaleProvider } from "../../../src/lib/i18n/LocaleContext";

const push = vi.hoisted(() => vi.fn());
const buscados = vi.hoisted(() => ({ actual: "" }));
const cuentas = vi.hoisted(() => ({ actual: {} as Record<string, number> }));

vi.mock("next/navigation", () => ({
  useRouter: () => ({ push, replace: vi.fn(), prefetch: vi.fn() }),
  useSearchParams: () => new URLSearchParams(buscados.actual),
  usePathname: () => "/bandeja",
}));

function montar(query = "", conCuentas: Record<string, number> = {}) {
  buscados.actual = query;
  cuentas.actual = conCuentas;
  return render(
    <LocaleProvider locale="es-AR">
      <NavegacionPendienteProvider>
        {/*
          * Los dos juntos: el botón subió al encabezado de la tarjeta y las
          * marcas quedaron en su franja, pero comparten la URL y el foco. Un
          * test que montara sólo uno no vería lo que se rompe entre ellos.
          */}
        <BotonDeFiltros cuentas={cuentas.actual} />
        <MarcasDeFiltros />
      </NavegacionPendienteProvider>
    </LocaleProvider>
  );
}

/** La URL que se empujó, como parámetros. */
function ultimaUrl(): URLSearchParams {
  const url = push.mock.calls.at(-1)?.[0] as string;
  const i = url.indexOf("?");
  return new URLSearchParams(i === -1 ? "" : url.slice(i + 1));
}

const boton = () => screen.getByTestId("filtros-boton");

describe("PanelDeFiltros", () => {
  beforeEach(() => {
    push.mockClear();
  });

  it("sin filtros puestos no muestra ninguna marca ni el contador", () => {
    montar();
    expect(boton().querySelector(".cifra")).toBeNull();
    expect(document.querySelectorAll("[data-marca]")).toHaveLength(0);
  });

  it("el panel está cerrado hasta que se lo abre", () => {
    montar();
    expect(boton()).toHaveAttribute("aria-expanded", "false");
    expect(screen.queryByRole("dialog")).toBeNull();

    fireEvent.click(boton());
    expect(boton()).toHaveAttribute("aria-expanded", "true");
    expect(screen.getByRole("dialog")).toBeTruthy();
  });

  it("elegir un chip escribe el parámetro en la URL y borra page", () => {
    montar("status=listo&page=4");
    fireEvent.click(boton());
    fireEvent.click(screen.getByRole("button", { name: "Granizo" }));

    const url = ultimaUrl();
    expect(url.get("type")).toBe("granizo");
    // El estado no lo toca el panel: las pestañas viven afuera.
    expect(url.get("status")).toBe("listo");
    expect(url.get("page")).toBeNull();
  });

  it("apretar de nuevo el chip encendido saca el filtro", () => {
    montar("type=granizo");
    fireEvent.click(boton());

    const chip = screen.getByRole("button", { name: "Granizo" });
    expect(chip).toHaveAttribute("aria-pressed", "true");

    fireEvent.click(chip);
    expect(ultimaUrl().get("type")).toBeNull();
  });

  it("lo que está puesto se lee sin abrir el panel", () => {
    montar("type=granizo&severity=critical");

    expect(screen.queryByRole("dialog")).toBeNull();
    expect(boton().querySelector(".cifra")?.textContent).toBe("2");

    const marcas = Array.from(document.querySelectorAll("[data-marca]"));
    expect(marcas.map((m) => m.getAttribute("aria-label"))).toEqual([
      "Quitar filtro Tipo: Granizo",
      "Quitar filtro Severidad: Crítico",
    ]);
  });

  it("la marca saca su propio filtro y deja los otros", () => {
    montar("type=granizo&severity=critical&status=listo");

    fireEvent.click(screen.getByLabelText("Quitar filtro Tipo: Granizo"));

    const url = ultimaUrl();
    expect(url.get("type")).toBeNull();
    expect(url.get("severity")).toBe("critical");
    expect(url.get("status")).toBe("listo");
  });

  it("«Limpiar» borra los CINCO filtros en UNA sola navegación", () => {
    montar("type=granizo&severity=critical&channel=whatsapp&is_claim=true&status=listo&page=3");

    fireEvent.click(screen.getByRole("button", { name: "Limpiar" }));

    expect(push).toHaveBeenCalledTimes(1);
    const url = ultimaUrl();
    /*
     * `status` ahora se limpia con el resto, y antes no.
     *
     * Era la pestaña de estado, que vivía afuera del panel, así que «Limpiar»
     * la respetaba a propósito. Desde que el estado es un grupo más, dejarla
     * puesta sería decir «limpié todo» y devolver una lista igual de recortada
     * que antes de apretar.
     */
    for (const p of ["status", "type", "severity", "channel", "is_claim", "page"]) {
      expect(url.get(p)).toBeNull();
    }
  });

  it("con un solo filtro puesto no aparece «Limpiar»: la marca ya lo saca", () => {
    montar("type=granizo");
    expect(screen.queryByRole("button", { name: "Limpiar" })).toBeNull();
  });

  it("ofrece los cuatro canales, WhatsApp incluido", () => {
    montar();
    fireEvent.click(boton());

    for (const canal of ["Email", "WhatsApp", "Simulación", "WhatsApp simulado"]) {
      expect(screen.getByRole("button", { name: canal })).toBeTruthy();
    }
  });

  it("un valor que no existe en la URL no inventa una marca", () => {
    // La URL la escribe cualquiera a mano. Una marca «Tipo: meteorito» no se
    // podría sacar, porque no hay chip que la apague.
    montar("type=meteorito");
    expect(document.querySelectorAll("[data-marca]")).toHaveLength(0);
    expect(boton().querySelector(".cifra")).toBeNull();
  });

  it("Escape cierra el panel y devuelve el foco al botón", () => {
    montar();
    boton().focus();
    fireEvent.click(boton());
    expect(screen.getByRole("dialog")).toBeTruthy();

    fireEvent.keyDown(document, { key: "Escape" });

    expect(screen.queryByRole("dialog")).toBeNull();
    expect(document.activeElement).toBe(boton());
  });
});
