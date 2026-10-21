import { spawnSync } from "node:child_process";
import { afterEach, describe, expect, it } from "vitest";

import {
  HOSTS_DE_BASE_REALES,
  HOSTS_WEB,
  HOST_DE_BASE_PRD,
  HOST_DE_BASE_QA,
  HOST_QA,
  conocido,
  endpointDe,
  esUrlDeQa,
  hostNormalizado,
  motivoDeVetoDeBases,
  vetadoBase,
  vetadoWeb,
} from "../../scripts/lib/hosts-vetados.mjs";

const PRD_URL_ORIGINAL = process.env.PRD_URL;
afterEach(() => {
  if (PRD_URL_ORIGINAL === undefined) delete process.env.PRD_URL;
  else process.env.PRD_URL = PRD_URL_ORIGINAL;
});

describe("hostNormalizado", () => {
  it.each([
    ["https://CLAIMMIX-dev.vercel.app/", "claimmix-dev.vercel.app"],
    ["https://claimmix.vercel.app.", "claimmix.vercel.app"],
    ["  https://claimmix.vercel.app/ruta?x=1  ", "claimmix.vercel.app"],
    ["no-es-una-url", ""],
    ["", ""],
  ])("%s -> %s", (url, esperado) => {
    expect(hostNormalizado(url)).toBe(esperado);
  });

  it("lo que no es texto no rompe", () => {
    expect(hostNormalizado(undefined as unknown as string)).toBe("");
  });
});

describe("vetadoWeb: dónde no se ataca ni se escribe", () => {
  it("la lista trae los tres alias con datos reales", () => {
    for (const host of ["claimmix.vercel.app", "claimmix-dev.vercel.app", "claimmix-prd.vercel.app"]) {
      expect(HOSTS_WEB.has(host)).toBe(true);
    }
    expect(HOSTS_WEB.has("claimmix-qa.vercel.app")).toBe(false);
  });

  it.each([
    "https://claimmix.vercel.app",
    "https://claimmix-dev.vercel.app",
    "https://claimmix-prd.vercel.app",
    "https://CLAIMMIX-dev.vercel.app/",
    "https://claimmix.vercel.app.",
    "https://claimmix.vercel.app./",
    "https://claimmix-prd.vercel.app:443/ruta",
    "https://usuario:fake-clave@claimmix.vercel.app",
  ])("%s está vetado", (url) => {
    expect(vetadoWeb(url)).toBe(true);
  });

  it.each(["https://claimmix-qa.vercel.app", "https://claimmix-qa.vercel.app/", "https://QA.example.com"])(
    "%s no está vetado",
    (url) => {
      expect(vetadoWeb(url)).toBe(false);
    },
  );

  it.each(["", "no-es-una-url", "claimmix.vercel.app", undefined as unknown as string])(
    "si la URL no se lee (%s), cuenta como vetada",
    (url) => {
      expect(vetadoWeb(url)).toBe(true);
    },
  );

  it("suma el host de PRD_URL, leído al preguntar y no al importar", () => {
    expect(vetadoWeb("https://prd.example.com")).toBe(false);
    process.env.PRD_URL = "https://PRD.example.com/";
    expect(vetadoWeb("https://prd.example.com")).toBe(true);
    expect(vetadoWeb("https://prd.example.com.")).toBe(true);
    expect(vetadoWeb("https://otro.example.com")).toBe(false);
  });

  it("un PRD_URL que no se lee no vuelve vetado cualquier cosa", () => {
    process.env.PRD_URL = "no-es-una-url";
    expect(vetadoWeb("https://claimmix-qa.vercel.app")).toBe(false);
  });
});

describe("conocido: los hosts de ClaimMix", () => {
  it.each([
    "https://claimmix.vercel.app",
    "https://claimmix-dev.vercel.app",
    "https://claimmix-prd.vercel.app",
    "https://claimmix-qa.vercel.app",
    "https://CLAIMMIX-QA.vercel.app/",
  ])("%s lo es", (url) => {
    expect(conocido(url)).toBe(true);
  });

  it.each([
    ["http://claimmix-dev.vercel.app", "sin https"],
    ["https://claimmix-dev.vercel.app:8443", "con puerto"],
    ["https://usuario:fake-clave@claimmix-dev.vercel.app", "con credenciales"],
    ["https://claimmix-x-ilandaniele-3471s-projects.vercel.app", "una vista previa"],
    ["https://claimmix-dev.vercel.app.example.com", "otro dominio que empieza igual"],
    ["https://example.com", "ajeno"],
    ["", "vacía"],
  ])("%s no lo es (%s)", (url) => {
    expect(conocido(url)).toBe(false);
  });

  it("el host de PRD_URL también", () => {
    expect(conocido("https://prd.example.com")).toBe(false);
    process.env.PRD_URL = "https://prd.example.com";
    expect(conocido("https://prd.example.com")).toBe(true);
  });
});

describe("esUrlDeQa: el único origen contra el que se prueba el alta", () => {
  it("HOST_QA es el alias de QA", () => {
    expect(HOST_QA).toBe("claimmix-qa.vercel.app");
  });

  it.each(["https://claimmix-qa.vercel.app", "https://claimmix-qa.vercel.app/", "https://CLAIMMIX-QA.vercel.app."])(
    "%s lo es",
    (url) => {
      expect(esUrlDeQa(url)).toBe(true);
    },
  );

  it.each([
    ["https://claimmix.vercel.app", "prd"],
    ["https://claimmix-dev.vercel.app", "dev"],
    ["https://claimmix-prd.vercel.app", "alias de prd"],
    ["https://claimmix-qa-git-x-ilandaniele-3471s-projects.vercel.app", "una vista previa"],
    ["https://claimmix-qa.vercel.app.example.com", "otro dominio que empieza igual"],
    ["http://claimmix-qa.vercel.app", "sin https"],
    ["https://claimmix-qa.vercel.app:8443", "con puerto"],
    ["https://usuario:fake-clave@claimmix-qa.vercel.app", "con credenciales"],
    ["http://", "sin host"],
    ["claimmix-qa.vercel.app", "sin esquema"],
    ["", "vacía"],
    [undefined as unknown as string, "sin texto"],
  ])("%s no lo es (%s)", (url) => {
    expect(esUrlDeQa(url)).toBe(false);
  });

  it("el host de PRD_URL no es QA aunque sea de ClaimMix", () => {
    process.env.PRD_URL = "https://prd.example.com";
    expect(esUrlDeQa("https://prd.example.com")).toBe(false);
    expect(esUrlDeQa("https://claimmix-qa.vercel.app")).toBe(true);
  });
});

describe("endpointDe: la primera etiqueta del host, sin -pooler", () => {
  it.each([
    ["postgresql://u:fake-clave@ep-wispy-flower-abc123.us-east-2.aws.neon.tech/neondb", "ep-wispy-flower-abc123"],
    ["postgresql://u:fake-clave@ep-wispy-flower-abc123-pooler.us-east-2.aws.neon.tech/neondb", "ep-wispy-flower-abc123"],
    ["postgres://u:fake-clave@EP-Wispy-Flower-ABC123.us-east-2.aws.neon.tech/neondb", "ep-wispy-flower-abc123"],
    ["no-es-una-url", ""],
  ])("%s -> %s", (cadena, esperado) => {
    expect(endpointDe(cadena)).toBe(esperado);
  });
});

describe("vetadoBase: qué cadenas de Postgres son las de datos reales", () => {
  it("la lista trae la base viva", () => {
    expect(HOSTS_DE_BASE_REALES.has("ep-proud-resonance")).toBe(true);
  });

  it.each([
    "postgresql://u:fake-clave@ep-proud-resonance-acbz9jqu.us-east-2.aws.neon.tech/neondb",
    "postgresql://u:fake-clave@ep-proud-resonance-acbz9jqu-pooler.us-east-2.aws.neon.tech/neondb?sslmode=require",
    "postgres://u:fake-clave@EP-PROUD-RESONANCE-test.example.com/neondb",
    "postgresql://u:fake-clave@ep-otra-cosa.example.com/neondb?host=ep-proud-resonance-test.example.com",
    "ep-proud-resonance-test.example.com",
  ])("%s es la viva", (cadena) => {
    expect(vetadoBase(cadena)).toBe(true);
  });

  it.each([
    "postgresql://u:fake-clave@ep-ensayo-qa.example.com/neondb",
    "postgresql://u:ep-proud-resonance@ep-ensayo-qa.example.com/neondb",
    "postgresql://ep-proud-resonance:fake-clave@ep-ensayo-qa.example.com/neondb",
    "",
    undefined,
  ])("%s no lo es", (cadena) => {
    expect(vetadoBase(cadena)).toBe(false);
  });
});

describe("motivoDeVetoDeBases: dónde pueden correr los scripts de bases por cliente", () => {
  const ENSAYO = "postgresql://u:fake-clave@ep-ensayo-bases-123.example.com/neondb";
  const STAGING = "postgresql://u:fake-clave@ep-staging-uno-456.example.com/neondb";

  it("la lista de datos reales no guarda un null cuando prd todavía no tiene endpoint", () => {
    expect([...HOSTS_DE_BASE_REALES].every((h) => typeof h === "string" && h !== "")).toBe(true);
    if (HOST_DE_BASE_PRD) expect(HOSTS_DE_BASE_REALES.has(HOST_DE_BASE_PRD)).toBe(true);
  });

  it.each([
    ENSAYO,
    "postgresql://u:fake-clave@ep-ensayo-bases-123-pooler.example.com/neondb?sslmode=require",
  ])("ensayo acepta %s", (cadena) => {
    expect(motivoDeVetoDeBases("ensayo", cadena, {})).toBeNull();
  });

  it.each([
    ["dev", "postgresql://u:fake-clave@ep-proud-resonance-acbz9jqu.example.com/neondb"],
    ["dev con -pooler", "postgresql://u:fake-clave@ep-proud-resonance-acbz9jqu-pooler.example.com/neondb"],
    ["QA", "postgresql://u:fake-clave@ep-wispy-flower-abc123.example.com/neondb"],
    ["QA con -pooler", "postgresql://u:fake-clave@ep-wispy-flower-abc123-pooler.example.com/neondb"],
    ["dev por ?host=", "postgresql://u:fake-clave@ep-ensayo-bases-123.example.com/neondb?host=ep-proud-resonance-acbz9jqu.example.com"],
  ])("ensayo y prd rechazan la base de %s", (_nombre, cadena) => {
    for (const ambiente of ["ensayo", "prd"]) {
      expect(motivoDeVetoDeBases(ambiente, cadena, {})).toContain("otro ambiente");
    }
  });

  it("staging no tiene host fijo: se rechaza el endpoint de las variables de staging y QA del entorno, con o sin -pooler", () => {
    const pooler = "postgresql://u:fake-clave@ep-staging-uno-456-pooler.example.com/neondb";
    for (const variable of ["STAGING_DATABASE_URL", "STAGING_DATABASE_URL_APP", "QA_DATABASE_URL", "QA_DATABASE_URL_APP"]) {
      for (const cadena of [STAGING, pooler]) {
        expect(motivoDeVetoDeBases("ensayo", cadena, { [variable]: STAGING })).toContain("otro ambiente");
      }
    }
    expect(motivoDeVetoDeBases("ensayo", STAGING, {})).toBeNull();
    expect(motivoDeVetoDeBases("ensayo", ENSAYO, { STAGING_DATABASE_URL: STAGING })).toBeNull();
  });

  it.each(["", "no-es-una-url", undefined])("una cadena que no se lee (%s) se rechaza", (cadena) => {
    expect(motivoDeVetoDeBases("ensayo", cadena, {})).toContain("no se lee");
  });

  it("el motivo no lleva la contraseña ni la cadena", () => {
    for (const cadena of [ENSAYO, STAGING, "postgresql://u:fake-clave@ep-proud-resonance-acbz9jqu.example.com/neondb"]) {
      const motivo = motivoDeVetoDeBases("prd", cadena, { STAGING_DATABASE_URL: STAGING }) ?? "";
      expect(motivo).not.toContain("fake-clave");
      expect(motivo).not.toContain("example.com");
    }
  });

  it("prd sólo acepta el endpoint de claimmix-prd, y mientras no esté cargado no acepta ninguno", () => {
    const propia = `postgresql://u:fake-clave@${HOST_DE_BASE_PRD ?? "ep-prd-ejemplo-789"}.example.com/neondb`;
    const motivo = motivoDeVetoDeBases("prd", propia, {});
    if (HOST_DE_BASE_PRD) expect(motivo).toBeNull();
    else expect(motivo).toContain("HOST_DE_BASE_PRD");
    expect(motivoDeVetoDeBases("prd", ENSAYO, {})).not.toBeNull();
  });

  it("un ambiente que no existe se rechaza", () => {
    expect(motivoDeVetoDeBases("produccion", ENSAYO, {})).toContain("desconocido");
  });

  describe("qa: lista blanca de un solo endpoint", () => {
    const deQa = (host: string, resto = "") => `postgres://u:fake-clave@${host}/neondb${resto}`;
    const QA = deQa("ep-wispy-flower-abc123.us-east-2.aws.neon.tech");
    const QA_POOLER = deQa("ep-wispy-flower-abc123-pooler.us-east-2.aws.neon.tech");

    it("HOST_DE_BASE_QA es el endpoint de QA", () => {
      expect(HOST_DE_BASE_QA).toBe("ep-wispy-flower");
    });

    it.each([
      ["el endpoint de QA", QA],
      ["su forma -pooler", QA_POOLER],
      ["sin sufijo", deQa("ep-wispy-flower.us-east-2.aws.neon.tech")],
      ["con mayúsculas", deQa("EP-WISPY-FLOWER-ABC123.us-east-2.aws.neon.tech")],
      ["con ?sslmode", `${QA_POOLER}?sslmode=require`],
      [
        "con ?host= del mismo endpoint",
        deQa("ep-wispy-flower-abc123-pooler.us-east-2.aws.neon.tech", "?host=ep-wispy-flower-abc123.us-east-2.aws.neon.tech"),
      ],
    ])("acepta %s", (_nombre, cadena) => {
      expect(motivoDeVetoDeBases("qa", cadena, {})).toBeNull();
    });

    it.each([
      ["prd", deQa("ep-sweet-salad-abc123.us-east-2.aws.neon.tech")],
      ["prd con -pooler", deQa("ep-sweet-salad-abc123-pooler.us-east-2.aws.neon.tech")],
      ["dev", deQa("ep-proud-resonance-abc123.us-east-2.aws.neon.tech")],
      ["dev con -pooler", deQa("ep-proud-resonance-abc123-pooler.us-east-2.aws.neon.tech")],
      ["staging", deQa("ep-damp-meadow-abc123.us-east-2.aws.neon.tech")],
      ["staging con -pooler", deQa("ep-damp-meadow-abc123-pooler.us-east-2.aws.neon.tech")],
      ["otro endpoint cualquiera", deQa("ep-ensayo-bases-123.us-east-2.aws.neon.tech")],
      ["un endpoint que sólo empieza igual", deQa("ep-wispy-flowerx-abc123.us-east-2.aws.neon.tech")],
      ["QA como subdominio de otro host", deQa("evil.ep-wispy-flower-abc123.us-east-2.aws.neon.tech")],
      ["QA en un dominio que no es de Neon", deQa("ep-wispy-flower-abc123.example.com")],
      ["QA con puerto", deQa("ep-wispy-flower-abc123.us-east-2.aws.neon.tech:5432")],
      [
        "?host= a otro endpoint",
        deQa("ep-wispy-flower-abc123.us-east-2.aws.neon.tech", "?host=ep-damp-meadow-abc123.us-east-2.aws.neon.tech"),
      ],
      [
        "?host= a prd",
        deQa("ep-wispy-flower-abc123.us-east-2.aws.neon.tech", "?host=ep-sweet-salad-abc123.us-east-2.aws.neon.tech"),
      ],
      [
        "?host= a dev",
        deQa("ep-wispy-flower-abc123.us-east-2.aws.neon.tech", "?host=ep-proud-resonance-abc123.us-east-2.aws.neon.tech"),
      ],
      ["QA sólo en la contraseña", "postgres://u:ep-wispy-flower-abc123@ep-damp-meadow-abc123.us-east-2.aws.neon.tech/neondb"],
      ["un host suelto", "ep-wispy-flower-abc123.us-east-2.aws.neon.tech"],
    ])("rechaza %s", (_nombre, cadena) => {
      expect(motivoDeVetoDeBases("qa", cadena, {})).not.toBeNull();
    });

    it.each(["", "no-es-una-url", undefined])("una cadena que no se lee (%s) se rechaza", (cadena) => {
      expect(motivoDeVetoDeBases("qa", cadena, {})).toContain("no se lee");
    });

    it("ignora el entorno: QA_DATABASE_URL igual a la cadena no la vuelve ajena", () => {
      const entorno = { QA_DATABASE_URL: QA, QA_DATABASE_URL_APP: QA_POOLER, STAGING_DATABASE_URL: QA };
      expect(motivoDeVetoDeBases("qa", QA, entorno)).toBeNull();
      expect(motivoDeVetoDeBases("qa", QA_POOLER, entorno)).toBeNull();
      expect(motivoDeVetoDeBases("qa", deQa("ep-damp-meadow-abc123.us-east-2.aws.neon.tech"), entorno)).not.toBeNull();
    });

    it("el motivo no lleva la contraseña ni la cadena", () => {
      for (const cadena of [
        QA,
        deQa("ep-damp-meadow-abc123.us-east-2.aws.neon.tech"),
        deQa("ep-proud-resonance-abc123.example.com"),
      ]) {
        const motivo = motivoDeVetoDeBases("qa", cadena, {}) ?? "";
        expect(motivo).not.toContain("fake-clave");
        expect(motivo).not.toContain("neon.tech");
        expect(motivo).not.toContain("example.com");
      }
    });

    it("no cambia a prd ni a ensayo: QA sigue siendo de otro ambiente para ellos", () => {
      for (const ambiente of ["prd", "ensayo"]) {
        expect(motivoDeVetoDeBases(ambiente, QA, {})).toContain("otro ambiente");
      }
    });
  });
});

describe("la CLI de los workflows", () => {
  const correr = (...args: string[]) =>
    spawnSync(process.execPath, ["scripts/lib/hosts-vetados.mjs", ...args], {
      cwd: process.cwd(),
      encoding: "utf8",
      env: { ...process.env, PRD_URL: "" },
    });

  it.each([
    ["--veto", "https://claimmix-dev.vercel.app", 1],
    ["--veto", "https://CLAIMMIX-dev.vercel.app/", 1],
    ["--veto", "https://claimmix.vercel.app.", 1],
    ["--veto", "https://claimmix-prd.vercel.app", 1],
    ["--veto", "no-es-una-url", 1],
    ["--veto", "https://claimmix-qa.vercel.app", 0],
    ["--conocido", "https://claimmix-qa.vercel.app", 0],
    ["--conocido", "https://claimmix-dev.vercel.app", 0],
    ["--conocido", "https://claimmix-dev.vercel.app:8443", 1],
    ["--conocido", "https://example.com", 1],
    ["--qa", "https://claimmix-qa.vercel.app", 0],
    ["--qa", "https://CLAIMMIX-qa.vercel.app/", 0],
    ["--qa", "https://claimmix.vercel.app", 1],
    ["--qa", "https://claimmix-dev.vercel.app", 1],
    ["--qa", "https://claimmix-prd.vercel.app", 1],
    ["--qa", "https://claimmix-qa-git-x-ilandaniele-3471s-projects.vercel.app", 1],
    ["--qa", "http://", 1],
    ["--qa", "http://claimmix-qa.vercel.app", 1],
    ["--qa", "https://claimmix-qa.vercel.app:8443", 1],
    ["--qa", "https://usuario:fake-clave@claimmix-qa.vercel.app", 1],
    ["--qa", "no-es-una-url", 1],
  ])("%s %s sale con %i", (modo, url, esperado) => {
    expect(correr(modo, url).status).toBe(esperado);
  });

  it("--qa explica el rechazo en stderr sin repetir la URL", () => {
    const r = correr("--qa", "https://usuario:fake-clave@claimmix-dev.vercel.app");
    expect(r.status).toBe(1);
    expect(r.stderr).not.toBe("");
    expect(r.stderr).not.toContain("fake-clave");
    expect(r.stderr).not.toContain("claimmix-dev");
  });

  it("sin argumentos o con un modo desconocido, sale con 2 y explica el uso", () => {
    for (const args of [[], ["--veto"], ["--qa"], ["--otro", "https://claimmix-qa.vercel.app"]]) {
      const r = correr(...args);
      expect(r.status).toBe(2);
      expect(r.stderr).toContain("Uso:");
    }
  });
});
