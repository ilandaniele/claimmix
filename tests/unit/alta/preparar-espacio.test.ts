/**
 * `prepararEspacio`: adónde va quien tiene su espacio recién creado.
 *
 * Apagada `BASE_POR_CLIENTE` el destino es el de siempre y no se toca nada.
 * Encendida, se lanza la preparación de la base del espacio nuevo y la persona
 * espera en /preparando; si el lanzamiento falla, igual va ahí (que sabe reintentar).
 */
import { beforeEach, describe, expect, it, vi } from "vitest";

const h = vi.hoisted(() => ({ iniciarBase: vi.fn(), error: vi.fn() }));

vi.mock("server-only", () => ({}));
vi.mock("next/server", () => ({ after: vi.fn() }));
vi.mock("@/server/alta/aviso-operador", () => ({ avisarAlOperador: vi.fn(), llegoAlAviso: vi.fn() }));
vi.mock("@/server/bases/iniciar", () => ({ iniciarBase: h.iniciarBase }));
vi.mock("@/lib/observability/logger", () => ({
  logger: { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: h.error },
}));

import { prepararEspacio } from "@/server/alta/crear-espacio";
import { PRIMEROS_PASOS } from "@/server/alta/pasos-hechos";

const TENANT = "aaaaaaaa-0000-4000-8000-00000000000a";
const ALTA = { resultado: "ok" as const, tenantId: TENANT, creadas24h: 1, tope: 20 };

beforeEach(() => {
  vi.clearAllMocks();
  delete process.env.BASE_POR_CLIENTE;
  h.iniciarBase.mockResolvedValue(undefined);
});

describe("prepararEspacio", () => {
  it("apagada la bandera devuelve el destino y no prepara nada", async () => {
    expect(await prepararEspacio(ALTA, PRIMEROS_PASOS)).toBe(PRIMEROS_PASOS);
    expect(h.iniciarBase).not.toHaveBeenCalled();
  });

  it("encendida lanza la base del espacio nuevo y manda a /preparando", async () => {
    process.env.BASE_POR_CLIENTE = "1";

    expect(await prepararEspacio(ALTA, PRIMEROS_PASOS)).toBe("/preparando");
    expect(h.iniciarBase).toHaveBeenCalledTimes(1);
    expect(h.iniciarBase).toHaveBeenCalledWith(TENANT);
  });

  it("si el lanzamiento falla lo anota (sin el mensaje) y manda igual a /preparando", async () => {
    process.env.BASE_POR_CLIENTE = "1";
    h.iniciarBase.mockRejectedValue(new Error("Failed query: params: ana@example.com"));

    expect(await prepararEspacio(ALTA, PRIMEROS_PASOS)).toBe("/preparando");
    expect(h.error).toHaveBeenCalledWith({ error: "Error", tenantId: TENANT }, "alta.base_no_arranco");
  });
});
