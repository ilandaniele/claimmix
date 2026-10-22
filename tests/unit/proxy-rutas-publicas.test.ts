/**
 * Qué páginas se ven sin sesión, recorriendo las que existen.
 *
 * `isPublic` comparaba con `startsWith` sin mirar dónde termina el segmento:
 * `/demo` dejaba pasar `/demostracion`, `/login` a `/loginx`. Hoy nadie tiene
 * esas rutas, pero el que la agregue no va a mirar el proxy. Por eso la lista
 * de públicas vive acá dos veces: la que el proxy conoce y la que una persona
 * escribió a mano. Una página nueva que caiga en una pública sin estar en la
 * segunda lista pone este test en rojo.
 */

import { readdirSync } from "node:fs";
import { resolve } from "node:path";

import { NextRequest } from "next/server";
import { beforeEach, describe, expect, it, vi } from "vitest";

const h = vi.hoisted(() => ({ getSession: vi.fn() }));
vi.mock("@/lib/auth", () => ({ auth: { api: { getSession: h.getSession } } }));

import { proxy } from "@/proxy";

/** Las que una persona decidió que se ven sin cuenta. Los parámetros van como `x`. */
const PUBLICAS = [
  "/login",
  "/registro",
  "/recuperar",
  "/restablecer",
  "/alta/correo",
  "/invitacion",
  "/demo",
  "/denuncia/x",
  "/privacy",
  "/terms",
  "/legal/x/x",
];

/** Cada `page.tsx` bajo `src/app`, como la ruta que Next le da. */
function rutasDeLaApp(): string[] {
  const base = resolve(__dirname, "../../src/app");
  return readdirSync(base, { recursive: true, encoding: "utf8" })
    .filter((f) => /(^|[\\/])page\.tsx$/.test(f))
    .map((f) => {
      const segmentos = f
        .replace(/\\/g, "/")
        .split("/")
        .slice(0, -1)
        .filter((s) => !/^\(.*\)$/.test(s))
        .map((s) => (/^\[.*\]$/.test(s) ? "x" : s));
      return `/${segmentos.join("/")}`;
    });
}

async function sinSesion(ruta: string) {
  return proxy(new NextRequest(`https://claimmix.example.com${ruta}`));
}

beforeEach(() => {
  h.getSession.mockResolvedValue({ headers: new Headers(), response: null });
});

describe("las páginas que existen, sin sesión", () => {
  const rutas = rutasDeLaApp();

  it("hay páginas que recorrer, y las públicas de la lista existen", () => {
    expect(rutas.length).toBeGreaterThan(10);
    for (const publica of PUBLICAS) expect(rutas).toContain(publica);
  });

  it.each(PUBLICAS)("%s se ve sin cuenta", async (ruta) => {
    const r = await sinSesion(ruta);
    expect(r.status).toBe(200);
  });

  it("todas las demás mandan al login", async () => {
    const privadas = rutas.filter((r) => !PUBLICAS.includes(r));
    expect(privadas).toContain("/");
    expect(privadas).toContain("/bandeja");
    for (const ruta of privadas) {
      const r = await sinSesion(ruta);
      expect(r.status, ruta).toBe(307);
      expect(new URL(r.headers.get("location")!).pathname, ruta).toBe("/login");
    }
  });
});

describe("el prefijo termina donde termina el segmento", () => {
  it.each(["/demostracion", "/loginx", "/registros", "/termsandconditions", "/alta/correos", "/alta"])(
    "%s no es pública por parecerse a una",
    async (ruta) => {
      const r = await sinSesion(ruta);
      expect(r.status).toBe(307);
    }
  );

  it.each(["/legal", "/denuncia"])("%s sin barra final sigue pidiendo sesión", async (ruta) => {
    const r = await sinSesion(ruta);
    expect(r.status).toBe(307);
  });

  it.each(["/demo/", "/demo/algo", "/login/", "/legal/espacio/privacidad"])("%s cuelga de una pública", async (ruta) => {
    const r = await sinSesion(ruta);
    expect(r.status).toBe(200);
  });
});
