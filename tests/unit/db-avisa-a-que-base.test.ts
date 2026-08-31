/**
 * En desarrollo, la capa de datos dice a qué base se conectó. Sin la contraseña.
 *
 * `next dev` lee `.env.local`, donde vive la cadena de PRODUCCIÓN, y eso está
 * bien: hay un solo ambiente desplegado. Lo que no estaba bien es que no se
 * notara — un `pnpm dev` olvidado contra la base de los clientes se ve igual que
 * uno contra el ensayo.
 *
 * Lo que este archivo cuida es lo que puede salir mal con el aviso mismo:
 * que aparezca en producción, que ensucie la suite, o que imprima el secreto
 * que vino a hacer visible.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

const CADENA = "postgresql://neondb_owner:UNA-CLAVE-SECRETA@ep-ensayo-123.us-east-2.aws.neon.tech/neondb";

const entornoOriginal = { ...process.env };

/** Importa la capa de datos de cero y devuelve lo que imprimió. */
async function conectarYEscuchar(): Promise<string[]> {
  const dichos: string[] = [];
  const espia = vi.spyOn(console, "info").mockImplementation((...args) => {
    dichos.push(args.map(String).join(" "));
  });

  vi.resetModules();
  const { getDb } = await import("@/lib/db");
  getDb();

  espia.mockRestore();
  return dichos;
}

beforeEach(() => {
  process.env.DATABASE_URL = CADENA;
  // Vitest pone NODE_ENV=test, que es justamente uno de los casos a probar.
  delete process.env.VITEST;
});

afterEach(() => {
  process.env = { ...entornoOriginal };
  vi.restoreAllMocks();
});

describe("el aviso de a qué base se conectó", () => {
  it("en desarrollo nombra el host", async () => {
    vi.stubEnv("NODE_ENV", "development");

    const dichos = await conectarYEscuchar();

    expect(dichos.join("\n")).toContain("ep-ensayo-123.us-east-2.aws.neon.tech");
  });

  it("NUNCA imprime la contraseña, que es la mitad del punto", async () => {
    /*
     * El host y la contraseña viajan en la misma cadena. Imprimirla entera
     * habría puesto el secreto en la terminal, en el log de CI y en cualquier
     * captura de pantalla — cambiando un problema de visibilidad por uno peor.
     */
    vi.stubEnv("NODE_ENV", "development");

    const dichos = await conectarYEscuchar();

    expect(dichos.join("\n")).not.toContain("UNA-CLAVE-SECRETA");
    expect(dichos.join("\n")).not.toContain("neondb_owner");
  });

  it("en producción no dice nada", async () => {
    // Una línea por arranque en frío de cada instancia serverless, contando algo
    // que ahí no le sirve a nadie.
    vi.stubEnv("NODE_ENV", "production");

    expect(await conectarYEscuchar()).toEqual([]);
  });

  it("bajo vitest tampoco", async () => {
    // Serían ciento sesenta líneas por corrida, una por archivo de test.
    vi.stubEnv("NODE_ENV", "development");
    vi.stubEnv("VITEST", "true");

    expect(await conectarYEscuchar()).toEqual([]);
  });

  it("con una cadena inválida el que se planta es el driver, no el aviso", async () => {
    /*
     * Escribí este test al revés: esperaba que la conexión sobreviviera. No
     * sobrevive, y está bien que no sobreviva — el driver revisa la cadena antes
     * de que el aviso llegue a mirarla, y su mensaje dice qué pasa con la
     * conexión, que es de lo que se trata.
     *
     * Lo que el test tiene que cuidar es que el error siga siendo el del driver:
     * si algún día el aviso se adelantara y tirara su propio `TypeError` al
     * parsear la URL, taparía el diagnóstico con uno peor.
     */
    vi.stubEnv("NODE_ENV", "development");
    process.env.DATABASE_URL = "esto-no-es-una-url";

    await expect(conectarYEscuchar()).rejects.toThrow(/connection string/i);
  });
});
