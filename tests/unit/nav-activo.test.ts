/**
 * Qué ítem de la barra se resalta cuando dos comparten camino.
 *
 * «Escalados» pasó de ser una página que redirigía a ser un enlace directo a
 * `/bandeja?status=escalado`. Con eso, «Bandeja» y «Escalados» comparten
 * `pathname`, y decidir por `pathname` resaltaba a los dos o a ninguno. La
 * regla: gana el ítem más específico, y un filtro cualquiera sigue siendo la
 * bandeja.
 */

import { describe, it, expect } from "vitest";

import { hrefActivo } from "@/app/(app)/_components/nav-activo";

const BARRA = [
  "/bandeja",
  "/bandeja?status=escalado",
  "/clientes",
  "/metricas",
  "/admin/users",
  "/configuracion",
] as const;

const q = (s: string) => new URLSearchParams(s);

describe("hrefActivo", () => {
  it("la bandeja sin filtros resalta «Bandeja»", () => {
    expect(hrefActivo(BARRA, "/bandeja", q(""))).toBe("/bandeja");
  });

  it("la bandeja filtrada por escalados resalta «Escalados», no «Bandeja»", () => {
    expect(hrefActivo(BARRA, "/bandeja", q("status=escalado"))).toBe("/bandeja?status=escalado");
  });

  it("escalados con otro filtro encima sigue siendo «Escalados»", () => {
    // Todos los pares del href estan en la URL; los demas no importan.
    expect(hrefActivo(BARRA, "/bandeja", q("status=escalado&type=choque&page=2"))).toBe(
      "/bandeja?status=escalado"
    );
  });

  it("un filtro cualquiera que no sea escalados sigue siendo «Bandeja»", () => {
    expect(hrefActivo(BARRA, "/bandeja", q("type=choque"))).toBe("/bandeja");
    expect(hrefActivo(BARRA, "/bandeja", q("status=listo"))).toBe("/bandeja");
  });

  it("una subruta resalta a su padre por prefijo, pero solo por `/`", () => {
    expect(hrefActivo(BARRA, "/admin/users/abc", q(""))).toBe("/admin/users");
    // `/clientesx` no es hijo de `/clientes`.
    expect(hrefActivo(BARRA, "/clientesx", q(""))).toBeNull();
  });

  it("una ruta que no esta en la barra no resalta nada", () => {
    expect(hrefActivo(BARRA, "/casos/123", q(""))).toBeNull();
  });

  it("sin query actual —Suspense, primer render— no explota", () => {
    expect(hrefActivo(BARRA, "/bandeja", null)).toBe("/bandeja");
    expect(hrefActivo(BARRA, "/bandeja", undefined)).toBe("/bandeja");
  });
});
