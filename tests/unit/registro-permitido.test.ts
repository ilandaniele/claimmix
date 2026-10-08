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
  enAlta,
  enIngresoPorSso,
  ingresoPorSso,
  altaHabilitada,
  altaAbierta,
  altaEnCursoPorServidor,
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

  /*
   * Las puertas del servidor (el enlace del mail, la invitación) las abre quien
   * llama a `signUpEmail`, y el gancho de alta las reconoce por su cuenta. Ninguna
   * le abre la lista a una dirección de afuera: un admin invita, no da de alta.
   */
  it("una puerta del servidor no abre la lista", async () => {
    delete process.env.SIGNUP_ALLOWED_EMAILS;
    for (const camino of ["correo", "invitacion"] as const) {
      await enAlta(camino, async () => {
        expect(altaHabilitada("de.afuera@cualquiera.com")).toBe(false);
      });
    }
  });

  it("la puerta no se escapa del pedido que la abrió", async () => {
    await enAlta("invitacion", async () => {
      expect(altaEnCursoPorServidor()).toBe("invitacion");
    });
    expect(altaEnCursoPorServidor()).toBeUndefined();
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

describe("altaHabilitada dentro de un ingreso por SSO", () => {
  const T = "11111111-1111-4111-8111-111111111111";
  const ingreso = { tenantId: T, dominio: "empresa.com" };

  it("el dominio verificado del inquilino hace de allowlist, sin variable alguna", async () => {
    delete process.env.SIGNUP_ALLOWED_EMAILS;
    await enIngresoPorSso(ingreso, async () => {
      expect(altaHabilitada("quien.sea@empresa.com")).toBe(true);
      expect(altaHabilitada("Quien.Sea@EMPRESA.com")).toBe(true);
    });
  });

  it("otro dominio, un subdominio o un dominio que termina igual no entran", async () => {
    process.env.SIGNUP_ALLOWED_EMAILS = "@otra.com";
    await enIngresoPorSso(ingreso, async () => {
      for (const mal of ["x@otra.com", "x@sub.empresa.com", "x@malaempresa.com", "x@empresa.com@malicioso.com"]) {
        expect(altaHabilitada(mal)).toBe(false);
      }
    });
  });

  it("no se escapa del pedido: después, el mismo mail vuelve a pedir la lista", async () => {
    delete process.env.SIGNUP_ALLOWED_EMAILS;
    await enIngresoPorSso(ingreso, async () => {
      expect(ingresoPorSso()).toEqual(ingreso);
    });
    expect(ingresoPorSso()).toBeUndefined();
    expect(altaHabilitada("quien.sea@empresa.com")).toBe(false);
  });

  it("dos ingresos de inquilinos distintos a la vez no se contaminan", async () => {
    delete process.env.SIGNUP_ALLOWED_EMAILS;
    const visto: string[] = [];
    await Promise.all([
      enIngresoPorSso({ tenantId: "a", dominio: "uno.com" }, async () => {
        await new Promise((r) => setTimeout(r, 5));
        visto.push(`a:${ingresoPorSso()?.tenantId}:${altaHabilitada("x@uno.com")}:${altaHabilitada("x@dos.com")}`);
      }),
      enIngresoPorSso({ tenantId: "b", dominio: "dos.com" }, async () => {
        await new Promise((r) => setTimeout(r, 1));
        visto.push(`b:${ingresoPorSso()?.tenantId}:${altaHabilitada("x@dos.com")}:${altaHabilitada("x@uno.com")}`);
      }),
    ]);
    expect(visto.sort()).toEqual(["a:a:true:false", "b:b:true:false"]);
  });
});

describe("altaAbierta", () => {
  const original = process.env.ALTA_AUTOMATICA;
  afterEach(() => {
    if (original === undefined) delete process.env.ALTA_AUTOMATICA;
    else process.env.ALTA_AUTOMATICA = original;
  });

  it("apagada y sin lista, no se abre para nadie", () => {
    delete process.env.ALTA_AUTOMATICA;
    expect(altaAbierta("quien.sea@example.com")).toBe(false);
  });

  it("apagada, se abre sólo para la lista", () => {
    delete process.env.ALTA_AUTOMATICA;
    process.env.SIGNUP_ALLOWED_EMAILS = "@example.com";
    expect(altaAbierta("ana@example.com")).toBe(true);
    expect(altaAbierta("ana@otra.example.org")).toBe(false);
  });

  it("con ALTA_AUTOMATICA=1 se abre para cualquiera", () => {
    process.env.ALTA_AUTOMATICA = "1";
    expect(altaAbierta("quien.sea@example.com")).toBe(true);
  });

  it.each(["0", "true", "yes", "", " 1"])("%j no la abre: es exactamente «1»", (valor) => {
    process.env.ALTA_AUTOMATICA = valor;
    expect(altaAbierta("quien.sea@example.com")).toBe(false);
  });
});
