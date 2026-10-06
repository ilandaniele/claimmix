/**
 * El cambio de contraseña en /configuracion.
 *
 * Le pega directo a la ruta de Better Auth en vez de usar su cliente. Acá se
 * afirma que el pedido es el mismo que hacía el cliente —en particular
 * `revokeOtherSessions: true`, que cierra las sesiones de quien haya entrado— y
 * que una respuesta de error no se lee como éxito.
 */

import { fireEvent, render } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { ConfiguracionClient } from "../../src/app/(app)/configuracion/ConfiguracionClient";

function completar(container: HTMLElement) {
  const campo = (id: string) => container.querySelector(`#${id}`) as HTMLInputElement;
  fireEvent.change(campo("current_password"), { target: { value: "fake-actual-123" } });
  fireEvent.change(campo("new_password"), { target: { value: "fake-nueva-456" } });
  fireEvent.change(campo("confirm_password"), { target: { value: "fake-nueva-456" } });
  fireEvent.submit(container.querySelector("form")!);
}

describe("ConfiguracionClient — cambio de contraseña", () => {
  const fetchMock = vi.fn();

  beforeEach(() => {
    fetchMock.mockReset();
    vi.stubGlobal("fetch", fetchMock);
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("manda el pedido de Better Auth y cierra las otras sesiones", async () => {
    fetchMock.mockResolvedValue(new Response("{}", { status: 200 }));
    const { container, findByText } = render(<ConfiguracionClient />);
    completar(container);

    await findByText(/Contraseña actualizada|Password updated/);
    expect(fetchMock).toHaveBeenCalledOnce();
    const [url, init] = fetchMock.mock.calls[0];
    expect(url).toBe("/api/auth/change-password");
    expect(init.method).toBe("POST");
    expect(JSON.parse(init.body)).toEqual({
      currentPassword: "fake-actual-123",
      newPassword: "fake-nueva-456",
      revokeOtherSessions: true,
    });
  });

  it("una respuesta de error no se muestra como éxito", async () => {
    fetchMock.mockResolvedValue(new Response('{"code":"INVALID_PASSWORD"}', { status: 400 }));
    const { container, findByText } = render(<ConfiguracionClient />);
    completar(container);

    await findByText(/contraseña actual sea correcta|current password is correct/i);
  });

  it("un 429 dice que esperen, no que el cambio falló", async () => {
    fetchMock.mockResolvedValue(new Response('{"message":"Too many requests"}', { status: 429 }));
    const { container, findByText, queryByText } = render(<ConfiguracionClient />);
    completar(container);

    await findByText(/Demasiados intentos|Too many attempts/);
    expect(queryByText(/contraseña actual sea correcta|current password is correct/i)).toBeNull();
  });
});
