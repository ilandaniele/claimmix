/**
 * Quién puede crearse una cuenta.
 *
 * La lista ya la miraba `provision.ts` para decidir si le daba una fila de
 * perfil a una cuenta recién creada. Ahora la mira además el gancho
 * `user.create.before`, que puede negar la creación entera — así nadie ocupa
 * una dirección ajena aunque esa cuenta no llegue a ver nada.
 *
 * Este archivo prueba la lista, que es la regla que sostiene las dos capas.
 */

import { describe, it, expect, afterEach, beforeEach } from "vitest";

import {
  parsearPermitidos,
  puedeRegistrarse,
  enAltaDeAdmin,
  esAltaDeAdmin,
  altaHabilitada,
} from "@/lib/auth/registro-permitido";

/*
 * `ADMIN_EMAILS` se guarda y se limpia igual que la otra: la lista efectiva es
 * la suma de las dos, asi que un `ADMIN_EMAILS` cargado en el entorno de quien
 * corre los tests haria pasar «sin la variable no se registra nadie» por el
 * motivo equivocado, o lo haria fallar en una maquina y no en otra.
 */
const originales = {
  signup: process.env.SIGNUP_ALLOWED_EMAILS,
  admin: process.env.ADMIN_EMAILS,
};
beforeEach(() => {
  delete process.env.SIGNUP_ALLOWED_EMAILS;
  delete process.env.ADMIN_EMAILS;
});
afterEach(() => {
  for (const [clave, valor] of [
    ["SIGNUP_ALLOWED_EMAILS", originales.signup],
    ["ADMIN_EMAILS", originales.admin],
  ] as const) {
    if (valor === undefined) delete process.env[clave];
    else process.env[clave] = valor;
  }
});

describe("parsearPermitidos", () => {
  /*
   * El `@` adelante es lo que marca «dominio entero». Es el formato que ya
   * documentaba `.env.example` y con el que puede haber listas escritas.
   */
  it("una entrada con arroba adelante es un dominio; sin ella, una dirección", () => {
    expect(parsearPermitidos("@empresa.com, ana@otra.com")).toEqual([
      { tipo: "dominio", valor: "empresa.com" },
      { tipo: "direccion", valor: "ana@otra.com" },
    ]);
  });

  it("tolera mayúsculas y espacios, que es como se escriben estas listas", () => {
    expect(parsearPermitidos("  @EMPRESA.com ,, Ana@Otra.COM  ")).toEqual([
      { tipo: "dominio", valor: "empresa.com" },
      { tipo: "direccion", valor: "ana@otra.com" },
    ]);
  });

  it("sin variable, la lista es vacía", () => {
    expect(parsearPermitidos(undefined)).toEqual([]);
    expect(parsearPermitidos("")).toEqual([]);
  });
});

describe("puedeRegistrarse", () => {
  const lista = parsearPermitidos("@empresa.com, ana@casilla-compartida.example");

  it("deja pasar al dominio de la lista", () => {
    expect(puedeRegistrarse("quien.sea@empresa.com", lista)).toBe(true);
  });

  it("deja pasar a una dirección exacta aunque su dominio no esté", () => {
    expect(puedeRegistrarse("ana@casilla-compartida.example", lista)).toBe(true);
  });

  /*
   * El caso que hace inútil a la mitad de estas listas.
   *
   * Los seis usuarios de produccion estan TODOS en el mismo correo gratuito.
   * Una lista de dominios que los incluya deja entrar al planeta, y por eso la
   * lista acepta direcciones exactas: la de Ana esta, la del vecino no, aunque
   * compartan dominio.
   */
  it("una dirección permitida NO habilita a su dominio entero", () => {
    expect(puedeRegistrarse("otro@casilla-compartida.example", lista)).toBe(false);
  });

  /*
   * El error clasico de estas listas: `endsWith("empresa.com")` deja entrar a
   * `malaempresa.com`, que es un dominio que cualquiera puede comprar.
   */
  it("un dominio que TERMINA igual no alcanza", () => {
    expect(puedeRegistrarse("x@malaempresa.com", lista)).toBe(false);
    expect(puedeRegistrarse("x@empresa.com.ar", lista)).toBe(false);
    expect(puedeRegistrarse("x@noempresa.com", lista)).toBe(false);
  });

  it("no distingue mayúsculas", () => {
    expect(puedeRegistrarse("Quien.Sea@EMPRESA.com", lista)).toBe(true);
  });

  it("con lista vacía no entra nadie", () => {
    expect(puedeRegistrarse("quien.sea@empresa.com", [])).toBe(false);
  });

  it("una dirección sin forma de dirección no entra", () => {
    for (const mala of ["", "@empresa.com", "sinarroba", "x@", "  "]) {
      expect(puedeRegistrarse(mala, lista)).toBe(false);
    }
  });

  /*
   * Con varias arrobas gana la ULTIMA, que es donde termina el dominio real.
   * Leyendo la primera, `victima@empresa.com@malicioso.com` pasaria como si
   * fuera de `empresa.com` cuando el correo lo entrega `malicioso.com`.
   */
  it("con varias arrobas, el dominio es el de la última", () => {
    expect(puedeRegistrarse("victima@empresa.com@malicioso.com", lista)).toBe(false);
  });
});

describe("altaHabilitada", () => {
  it("sin la variable no se registra nadie", () => {
    delete process.env.SIGNUP_ALLOWED_EMAILS;
    expect(altaHabilitada("quien.sea@empresa.com")).toBe(false);
  });

  it("con la variable, entra quien está en la lista", () => {
    process.env.SIGNUP_ALLOWED_EMAILS = "@empresa.com";
    expect(altaHabilitada("quien.sea@empresa.com")).toBe(true);
    expect(altaHabilitada("quien.sea@otra.com")).toBe(false);
  });

  it("un admin da de alta a quien quiera, incluso sin variable", async () => {
    delete process.env.SIGNUP_ALLOWED_EMAILS;
    await enAltaDeAdmin(async () => {
      expect(altaHabilitada("de.afuera@cualquiera.com")).toBe(true);
    });
  });

  /*
   * La marca no puede sobrevivir al pedido que la puso: si quedara colgada, el
   * registro de un desconocido que llega despues entraria como si lo hubiera
   * pedido un admin.
   */
  it("la marca de admin no se escapa del pedido que la puso", async () => {
    await enAltaDeAdmin(async () => {
      expect(esAltaDeAdmin()).toBe(true);
    });
    expect(esAltaDeAdmin()).toBe(false);

    delete process.env.SIGNUP_ALLOWED_EMAILS;
    expect(altaHabilitada("de.afuera@cualquiera.com")).toBe(false);
  });

  it("dos pedidos a la vez no se contaminan", async () => {
    delete process.env.SIGNUP_ALLOWED_EMAILS;
    let deAdentro = false;
    let deAfuera = true;
    await Promise.all([
      enAltaDeAdmin(async () => {
        await new Promise((r) => setTimeout(r, 5));
        deAdentro = altaHabilitada("x@cualquiera.com");
      }),
      (async () => {
        await new Promise((r) => setTimeout(r, 1));
        deAfuera = altaHabilitada("y@cualquiera.com");
      })(),
    ]);
    expect(deAdentro).toBe(true);
    expect(deAfuera).toBe(false);
  });

  /*
   * `ADMIN_EMAILS` tambien habilita. Es la politica que ya estaba y no la
   * cambio: quien opera el producto tiene que poder entrar la primera vez sin
   * que otro le abra la puerta.
   */
  it("ADMIN_EMAILS también habilita, sin estar en SIGNUP_ALLOWED_EMAILS", () => {
    process.env.ADMIN_EMAILS = "quien.opera@claimmix.com";
    expect(altaHabilitada("quien.opera@claimmix.com")).toBe(true);
    expect(altaHabilitada("otro@claimmix.com")).toBe(false);
  });
});
