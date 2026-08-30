/**
 * El formulario de contraseña nueva, y el token que no se queda en la URL.
 *
 * El token llega como `?token=…` porque así funciona un enlace por correo, y
 * eso no se puede cambiar. Lo que sí se puede es que no se quede ahí: mientras
 * está en la barra de direcciones queda en el historial del navegador, en el
 * `Referer` de cualquier pedido que salga de esta página, y a la vista de quien
 * mire la pantalla. Un token de recuperación es la credencial mientras dura.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { render, screen } from "@testing-library/react";

const { mockRestablecer } = vi.hoisted(() => ({ mockRestablecer: vi.fn() }));

vi.mock("./../../../src/app/restablecer/actions", () => ({
  restablecer: mockRestablecer,
}));

vi.mock("@/app/restablecer/actions", () => ({
  restablecer: mockRestablecer,
}));

import { RestablecerForm } from "@/app/restablecer/RestablecerForm";

const TOKEN = "token-de-recuperacion-largo-y-al-azar";

function ponerUrl(href: string) {
  window.history.replaceState(null, "", href);
}

beforeEach(() => {
  vi.clearAllMocks();
  ponerUrl(`/restablecer?token=${TOKEN}`);
});

afterEach(() => {
  ponerUrl("/");
});

describe("RestablecerForm", () => {
  it("saca el token de la URL apenas monta", () => {
    expect(window.location.search).toContain(TOKEN);

    render(<RestablecerForm token={TOKEN} />);

    expect(window.location.search).not.toContain(TOKEN);
    expect(window.location.search).not.toContain("token");
  });

  it("pero lo conserva en el formulario, o no se podría cambiar la contraseña", () => {
    // La otra mitad. Un componente que borrara el token de los dos lados
    // también pasaría el test de arriba, y dejaría el formulario inservible.
    const { container } = render(<RestablecerForm token={TOKEN} />);

    const oculto = container.querySelector('input[name="token"]') as HTMLInputElement;
    expect(oculto).not.toBeNull();
    expect(oculto.value).toBe(TOKEN);
  });

  it("no rompe el resto de la query string", () => {
    // Si mañana el enlace trae algo más, sacar el token no puede llevárselo.
    ponerUrl(`/restablecer?token=${TOKEN}&lang=es`);

    render(<RestablecerForm token={TOKEN} />);

    expect(window.location.search).toContain("lang=es");
    expect(window.location.search).not.toContain("token");
  });

  it("sin token en la URL no toca nada", () => {
    // El caso de la recarga: la URL ya está limpia y no hay nada que hacer.
    ponerUrl("/restablecer");

    render(<RestablecerForm token={TOKEN} />);

    expect(window.location.pathname).toBe("/restablecer");
  });

  it("deja los campos de contraseña listos para escribir", () => {
    // Son dos: la nueva y la repetición.
    render(<RestablecerForm token={TOKEN} />);

    expect(screen.getAllByLabelText(/contraseña/i).length).toBeGreaterThanOrEqual(1);
  });
});
