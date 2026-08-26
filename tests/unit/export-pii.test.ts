/**
 * Qué datos personales salen del sistema cuando alguien exporta.
 *
 * Esta es la única función del producto que puede sacar datos de damnificados
 * hacia afuera —un archivo que se descarga y después vive en la computadora de
 * alguien— y no la probaba nada.
 *
 * Lo que se mira acá no es que enmascare "algo", sino tres cosas que se rompen
 * distinto:
 *
 *   1. Que ningún secreto salga NUNCA, en ningún modo. Una clave de API en un
 *      export es una credencial en la carpeta de descargas de alguien.
 *   2. Que enmascarar deje el dato inútil. Un DNI con los ocho dígitos y un
 *      asterisco al final sigue siendo el DNI.
 *   3. Que la recursión no tenga fondo. Los datos anidados —una lista de casos
 *      adentro de una configuración— son justamente donde un sanitizador
 *      superficial deja pasar todo.
 *
 * Y una cuarta, aparte: quién tiene permiso de pedir qué.
 */
import { describe, it, expect } from "vitest";
import {
  sanitizeExportPayload,
  canExportAgentData,
  normalizeAgentExportFormat,
} from "@/server/agents/export";

/** El payload completo, como texto, para buscar filtraciones. */
const texto = (v: unknown) => JSON.stringify(v);

describe("los secretos no salen en ningún modo", () => {
  const conSecretos = {
    gemini_api_key_encrypted: "cifrado:AIzaSyD-clave-real",
    refresh_token: "1//0gRefreshTokenDeVerdad",
    client_secret: "GOCSPX-secreto",
    webhook_secret: "whsec_abc123",
    password: "Analyst123!",
    nombre_del_modelo: "gemini-2.5-flash",
  };

  for (const modo of ["masked", "excluded", "full_admin_only"] as const) {
    it(`no salen con piiMode=${modo}, ni siendo admin`, () => {
      // `canExportFullPii` en true es el caso más permisivo que existe: un
      // dueño pidiendo todo. Ni ahí salen los secretos, porque un secreto no
      // es un dato personal que se pueda "autorizar": es una llave.
      const salida = sanitizeExportPayload(conSecretos, modo, true);

      expect(texto(salida)).not.toContain("AIzaSyD");
      expect(texto(salida)).not.toContain("1//0gRefresh");
      expect(texto(salida)).not.toContain("GOCSPX");
      expect(texto(salida)).not.toContain("whsec_");
      expect(texto(salida)).not.toContain("Analyst123");

      // Y lo que no es secreto sigue estando: un sanitizador que borra todo
      // deja un export vacío, que se arregla desactivándolo.
      expect((salida as Record<string, unknown>).nombre_del_modelo).toBe("gemini-2.5-flash");
    });
  }

  it("los borra por completo, no los enmascara", () => {
    const salida = sanitizeExportPayload({ api_key: "secreto" }, "masked", true) as Record<
      string,
      unknown
    >;
    // Dejar `api_key: "****"` diría que la clave existe y dónde buscarla.
    expect(salida).not.toHaveProperty("api_key");
  });
});

describe("modo enmascarado: el dato queda inútil", () => {
  it("un DNI conserva a lo sumo los últimos cuatro dígitos", () => {
    const salida = sanitizeExportPayload({ dni: "30.145.882" }, "masked", false) as Record<
      string,
      string
    >;
    expect(salida.dni).toBe("****5882");
    expect(salida.dni).not.toContain("301");
  });

  it("un correo conserva el dominio y una letra", () => {
    // El dominio se deja a propósito: sirve para saber de qué aseguradora
    // vino sin identificar a la persona.
    const salida = sanitizeExportPayload(
      { email: "roberto.paz@ejemplo.com.ar" },
      "masked",
      false
    ) as Record<string, string>;
    expect(salida.email).toBe("r***@ejemplo.com.ar");
    expect(salida.email).not.toContain("roberto");
  });

  it("un teléfono conserva el prefijo y los últimos cuatro", () => {
    const salida = sanitizeExportPayload(
      { phone: "+54 9 291 642-6930" },
      "masked",
      false
    ) as Record<string, string>;
    // El prefijo son los primeros cuatro caracteres cuando empieza con "+":
    // "+549" es el código de país más el 9 de celular argentino.
    expect(salida.phone).toBe("+549****6930");
    expect(salida.phone).not.toContain("291");
  });

  it("una dirección desaparece entera", () => {
    // No hay forma de enmascarar una dirección y que siga sirviendo para algo:
    // media dirección en una ciudad chica es la dirección.
    const salida = sanitizeExportPayload(
      { address: "Alem 1234, Bahía Blanca" },
      "masked",
      false
    ) as Record<string, string>;
    expect(salida.address).toBe("[address_masked]");
  });

  it("un nombre desaparece entero", () => {
    const salida = sanitizeExportPayload(
      { policyholder_name: "Roberto Paz" },
      "masked",
      false
    ) as Record<string, string>;
    expect(salida.policyholder_name).toBe("[name_masked]");
  });

  it("los datos bancarios desaparecen", () => {
    const salida = sanitizeExportPayload(
      { cbu: "0170099220000067797", cuenta_destino: "123-456789/0" },
      "masked",
      false
    ) as Record<string, string>;
    expect(salida.cbu).toBe("[bank_data_masked]");
    expect(salida.cuenta_destino).toBe("[bank_data_masked]");
  });
});

describe("los datos escondidos adentro de texto libre", () => {
  it("encuentra un DNI en el medio de una frase", () => {
    // Éste es el caso que un sanitizador por nombre de campo no ve: la clave
    // se llama `summary`, no `dni`, y el DNI está adentro del texto.
    const salida = sanitizeExportPayload(
      { summary: "El asegurado dijo que su DNI es 30.145.882 y su mail roberto@ej.com" },
      "masked",
      false
    ) as Record<string, string>;

    expect(salida.summary).not.toContain("30.145.882");
    expect(salida.summary).not.toContain("roberto@ej.com");
    expect(salida.summary).toContain("El asegurado dijo");
  });

  it("encuentra un número de póliza suelto", () => {
    const salida = sanitizeExportPayload(
      { nota: "Corresponde a POL-4471-A según el sistema" },
      "masked",
      false
    ) as Record<string, string>;
    expect(salida.nota).not.toContain("POL-4471-A");
    expect(salida.nota).toContain("según el sistema");
  });
});

describe("modo excluido: ni siquiera queda el rastro", () => {
  it("saca los campos sensibles en vez de enmascararlos", () => {
    const salida = sanitizeExportPayload(
      { dni: "30145882", email: "a@b.com", claim_type: "choque" },
      "excluded",
      false
    ) as Record<string, unknown>;

    expect(salida).not.toHaveProperty("dni");
    expect(salida).not.toHaveProperty("email");
    // Lo que no identifica a nadie se queda: es el dato que hace útil al export.
    expect(salida.claim_type).toBe("choque");
  });

  it("reemplaza lo que aparece dentro de texto libre", () => {
    const salida = sanitizeExportPayload(
      { summary: "Mail de contacto: roberto@ej.com" },
      "excluded",
      false
    ) as Record<string, string>;
    expect(salida.summary).toBe("Mail de contacto: [email_excluded]");
  });
});

describe("modo completo: sólo para quien está autorizado", () => {
  it("deja el dato tal cual si la autorización está", () => {
    const salida = sanitizeExportPayload({ dni: "30145882" }, "full_admin_only", true) as Record<
      string,
      string
    >;
    expect(salida.dni).toBe("30145882");
  });

  it("enmascara igual si la autorización NO está", () => {
    // El modo lo pide quien llama; el permiso lo decide el servidor. Si pedir
    // el modo alcanzara, cualquiera se exportaría la base en claro.
    const salida = sanitizeExportPayload({ dni: "30145882" }, "full_admin_only", false) as Record<
      string,
      string
    >;
    expect(salida.dni).not.toBe("30145882");
    expect(salida.dni).toBe("****5882");
  });
});

describe("datos anidados", () => {
  it("baja por objetos y listas hasta el fondo", () => {
    const anidado = {
      configuracion: {
        casos: [
          { id: "1", customer: { dni: "30145882", email: "a@ej.com" } },
          { id: "2", customer: { dni: "27888101", email: "b@ej.com" } },
        ],
        credenciales: { api_key: "AIzaSyD-secreta" },
      },
    };

    const salida = sanitizeExportPayload(anidado, "masked", false);
    const t = texto(salida);

    expect(t).not.toContain("30145882");
    expect(t).not.toContain("27888101");
    expect(t).not.toContain("a@ej.com");
    expect(t).not.toContain("AIzaSyD");
    // La forma se mantiene: los dos casos siguen ahí, con su id.
    expect(t).toContain('"id":"1"');
    expect(t).toContain('"id":"2"');
  });

  it("no rompe con null ni con tipos que no son texto", () => {
    const salida = sanitizeExportPayload(
      { n: 42, b: true, nulo: null, lista: [1, null, "a@b.com"] },
      "masked",
      false
    ) as Record<string, unknown>;

    expect(salida.n).toBe(42);
    expect(salida.b).toBe(true);
    expect(salida.nulo).toBeNull();
    expect(texto(salida.lista)).not.toContain("a@b.com");
  });
});

describe("quién puede pedir qué", () => {
  it("owner y admin pueden todo", () => {
    for (const rol of ["owner", "admin"] as const) {
      expect(
        canExportAgentData(rol, {
          exportType: "full",
          piiMode: "full_admin_only",
          format: "json",
        }),
        rol
      ).toBe(true);
    }
  });

  it("un specialist no puede pedir datos en claro", () => {
    expect(
      canExportAgentData("specialist", {
        exportType: "memory_only",
        piiMode: "full_admin_only",
        format: "csv_summary",
      })
    ).toBe(false);
  });

  it("un specialist sólo puede la memoria, y en dos formatos", () => {
    expect(
      canExportAgentData("specialist", {
        exportType: "memory_only",
        piiMode: "masked",
        format: "csv_summary",
      })
    ).toBe(true);
    // La configuración incluye reglas y ajustes del inquilino: no es memoria
    // de entrenamiento y no le corresponde.
    expect(
      canExportAgentData("specialist", {
        exportType: "config_only",
        piiMode: "masked",
        format: "json",
      })
    ).toBe(false);
    expect(
      canExportAgentData("specialist", {
        exportType: "memory_only",
        piiMode: "masked",
        format: "json",
      })
    ).toBe(false);
  });

  it("analyst y viewer no pueden exportar nada", () => {
    for (const rol of ["analyst", "viewer"] as const) {
      expect(
        canExportAgentData(rol, {
          exportType: "memory_only",
          piiMode: "masked",
          format: "csv_summary",
        }),
        rol
      ).toBe(false);
    }
  });
});

describe("el formato pedido", () => {
  it("acepta los nombres cortos y los largos", () => {
    expect(normalizeAgentExportFormat("jsonl")).toBe("jsonl_approved_examples");
    expect(normalizeAgentExportFormat("csv")).toBe("csv_summary");
    expect(normalizeAgentExportFormat("json")).toBe("json");
  });

  it("devuelve null con cualquier otra cosa", () => {
    // Devolver un formato por omisión ante algo desconocido es cómo se
    // termina exportando en un formato que nadie pidió.
    expect(normalizeAgentExportFormat("xlsx")).toBeNull();
    expect(normalizeAgentExportFormat("")).toBeNull();
    expect(normalizeAgentExportFormat(null)).toBeNull();
  });
});
