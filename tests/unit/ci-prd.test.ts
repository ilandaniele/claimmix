// @vitest-environment node
import { spawnSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";

// Mismo criterio que `ci-secreto-de-sesion.test.ts`: sin comentarios, porque los
// workflows explican el defecto citando la expresión.
const leer = (nombre: string) =>
  readFileSync(resolve(process.cwd(), ".github/workflows", nombre), "utf8").replace(/\r\n/g, "\n");

const sinComentarios = (nombre: string) =>
  leer(nombre)
    .split("\n")
    .map((l) => l.replace(/(^|\s)#.*$/, "$1"))
    .join("\n");

// El cuerpo de un job: desde `  id:` hasta el siguiente job.
const cuerpoDe = (yml: string, id: string) => {
  const lineas = yml.split("\n");
  const i = lineas.findIndex((l) => l === `  ${id}:`);
  expect(i).toBeGreaterThan(-1);
  const j = lineas.findIndex((l, k) => k > i && /^ {2}[\w-]+:\s*$/.test(l));
  return lineas.slice(i, j === -1 ? undefined : j).join("\n");
};

// Un paso por su nombre, hasta el siguiente.
const pasoDe = (cuerpo: string, nombre: string) => {
  const i = cuerpo.indexOf(`- name: ${nombre}`);
  expect(i).toBeGreaterThan(-1);
  const j = cuerpo.indexOf("\n      - ", i + 1);
  return cuerpo.slice(i, j === -1 ? undefined : j);
};

// El script de un paso `run: |`, sin la sangría, tal como lo corre el runner.
const scriptDe = (paso: string) => {
  const lineas = paso.slice(paso.indexOf("run: |")).split("\n").slice(1);
  const fin = lineas.findIndex((l) => l.trim() !== "" && !l.startsWith("          "));
  return lineas
    .slice(0, fin === -1 ? undefined : fin)
    .map((l) => l.replace(/^ {10}/, ""))
    .join("\n");
};

// El `if: >` de un job, o el `group: >-` del workflow: texto plegado de Actions.
const plegado = (yml: string, patron: RegExp) => {
  const m = patron.exec(yml);
  expect(m).not.toBeNull();
  return m![1].replace(/\n/g, " ");
};

// Las expresiones de estos workflows son JavaScript con otras funciones: se
// evalúan con los nombres del contexto reemplazados por variables.
const evaluar = (expresion: string, entorno: string, evento: string) => {
  const js = expresion
    .replace(/\$\{\{|\}\}/g, "")
    .replace(/format\('post-deploy-sin-cola-\{0\}', github\.run_id\)/g, "'sin-cola'")
    .replace(/!cancelled\(\)|always\(\)/g, "true")
    .replace(/needs\.validar_url\.result/g, "'skipped'")
    .replace(/github\.event\.deployment_status\.state/g, "'success'")
    .replace(/github\.event\.deployment\.environment/g, "entorno")
    .replace(/github\.event_name/g, "evento");
  return new Function(
    "entorno",
    "evento",
    "startsWith",
    "endsWith",
    `return (${js});`,
  )(
    entorno,
    evento,
    (a: string, b: string) => a.startsWith(b),
    (a: string, b: string) => a.endsWith(b),
  );
};

const DEV = "Production – claimmix";
const QA = "Production – claimmix-qa";
const PRD = "Production – claimmix-prd";
const PREVIEW = "Preview – claimmix";

const hayBash =
  spawnSync("bash", ["-c", 'printf %s "$SONDA"'], { encoding: "utf8", env: { ...process.env, SONDA: "ok" } }).stdout === "ok";

describe("lo previo al merge no se dispara con prd", () => {
  it.each(["ci.yml", "codeql.yml", "secrets.yml"])("%s: pull_request sólo hacia main y qa", (nombre) => {
    const m = /pull_request:\s*branches:\s*\[([^\]]*)\]/.exec(sinComentarios(nombre));
    expect(m).not.toBeNull();
    const ramas = m![1].split(",").map((r) => r.trim());
    expect(ramas).toEqual(["main", "qa"]);
    expect(ramas).not.toContain("prd");
  });
});

describe("post-deploy.yml: cada job mira el nombre de su entorno", () => {
  const yml = sinComentarios("post-deploy.yml");
  const condicion = (id: string) => plegado(cuerpoDe(yml, id) + "\n", /^ {4}if: >-?\n((?: {6,}\S.*\n)+)/m);

  // [job, dev, qa, prd, vista previa]
  it.each([
    ["produccion", true, false, false, false],
    ["qa_secretos", false, true, false, false],
    ["qa", false, true, false, false],
    ["qa_veredicto", false, true, false, false],
    ["prd", false, false, true, false],
  ])("%s corre en dev=%s, qa=%s, prd=%s, preview=%s", (id, dev, qa, prd, preview) => {
    const si = condicion(id as string);
    expect(evaluar(si, DEV, "deployment_status")).toBe(dev);
    expect(evaluar(si, QA, "deployment_status")).toBe(qa);
    expect(evaluar(si, PRD, "deployment_status")).toBe(prd);
    expect(evaluar(si, PREVIEW, "deployment_status")).toBe(preview);
  });

  it("un disparo a mano sólo entra a `produccion`, el de dev", () => {
    expect(evaluar(condicion("produccion"), "", "workflow_dispatch")).toBe(true);
    for (const id of ["qa_secretos", "qa", "prd"]) {
      expect(evaluar(condicion(id), "", "workflow_dispatch")).toBe(false);
    }
  });

  it("el grupo de concurrencia es el mismo reparto, con una cola por base", () => {
    const grupo = plegado(yml, /^concurrency:\n {2}group: >-\n((?: {4}\S.*\n)+)/m);
    expect(evaluar(grupo, DEV, "deployment_status")).toBe("post-deploy-contra-produccion");
    expect(evaluar(grupo, QA, "deployment_status")).toBe("post-deploy-contra-qa");
    expect(evaluar(grupo, PRD, "deployment_status")).toBe("post-deploy-contra-prd");
    expect(evaluar(grupo, PREVIEW, "deployment_status")).toBe("sin-cola");
    expect(evaluar(grupo, "", "workflow_dispatch")).toBe("post-deploy-contra-produccion");
  });

  it("el job de prd sólo mira la salud: nada que escriba ni heredado", () => {
    const prd = cuerpoDe(yml, "prd");
    expect(prd).toContain("/api/health?deep=1");
    expect(prd).toContain("bases.desfase");
    expect(prd).toContain("pnpm smoke");
    expect(prd).toContain("secrets.PRD_CRON_SECRET");
    expect(prd).toContain("vars.PRD_URL");
    expect(prd).not.toContain("deploy-checks.yml");
    expect(prd).not.toContain("secrets: inherit");
    expect(prd).not.toMatch(/pnpm (rehearse|pentest|knock|tenancy|capa-datos)/);
    expect(prd).not.toMatch(/DATABASE_URL|secrets\.CRON_SECRET|QA_/);
  });

  it("las URLs por defecto son las de dev", () => {
    expect(yml).not.toContain("https://claimmix.vercel.app");
    expect(yml.match(/https:\/\/claimmix-dev\.vercel\.app/g)?.length ?? 0).toBeGreaterThanOrEqual(3);
  });
});

describe("las URLs por defecto de los workflows ya no son producción", () => {
  it.each(["post-deploy.yml", "deploy-checks.yml", "barrer-trabados.yml", "load-tests.yml"])(
    "%s no nombra https://claimmix.vercel.app",
    (nombre) => {
      expect(sinComentarios(nombre)).not.toContain("https://claimmix.vercel.app");
    },
  );
});

describe("deploy-checks.yml: el freno del pen test usa la lista de hosts vetados", () => {
  const pentest = cuerpoDe(sinComentarios("deploy-checks.yml"), "pentest");
  const paso = pasoDe(pentest, "¿Se escribe donde no se debe?");

  it("lleva PRD_URL por `env:` para que su host también cuente", () => {
    expect(paso).toContain("PRD_URL: ${{ vars.PRD_URL }}");
  });

  const PRD_HOST = "https://claimmix-prd.vercel.app";
  it.skipIf(!hayBash).each([
    ["https://claimmix-dev.vercel.app", "true", "false", 1],
    ["https://claimmix-dev.vercel.app", "false", "true", 1],
    ["https://CLAIMMIX-dev.vercel.app/", "true", "false", 1],
    ["https://claimmix.vercel.app.", "false", "true", 1],
    [PRD_HOST, "true", "true", 1],
    ["no-es-una-url", "true", "false", 1],
    ["https://claimmix-qa.vercel.app", "true", "true", 0],
    ["https://claimmix-dev.vercel.app", "false", "false", 0],
  ])("URL %s, atacar_agente=%s, pared_propia=%s: sale con %i", (url, agente, pared, esperado) => {
    const r = spawnSync("bash", ["-c", scriptDe(paso)], {
      encoding: "utf8",
      cwd: process.cwd(),
      env: { ...process.env, URL: url, ATACAR_AGENTE: agente, PARED_PROPIA: pared, PRD_URL: "" },
    });
    expect(r.status).toBe(esperado);
    if (esperado !== 0) expect(r.stdout).toContain("::error::");
  });
});

describe("barrer-trabados.yml: prd tiene su cron, su cola y su secreto", () => {
  const yml = sinComentarios("barrer-trabados.yml");
  const CRON_PRD = "23 */2 * * *";

  it("el cron de prd se suma al de dev", () => {
    expect(yml).toContain(`- cron: "${CRON_PRD}"`);
    expect(yml).toContain('- cron: "*/15 * * * *"');
  });

  it("la cola de prd es otra", () => {
    expect(yml).toMatch(/concurrency:\n {2}group: .*'barrer-trabados-prd'.*'barrer-trabados'/);
  });

  it("los jobs de dev no corren con el cron de prd", () => {
    for (const id of ["barrer", "salud"]) {
      expect(cuerpoDe(yml, id)).toContain(`if: github.event.schedule != '${CRON_PRD}'`);
    }
  });

  it("el job de prd corre sólo con su cron y sólo si hay vars.PRD_URL", () => {
    const prd = cuerpoDe(yml, "prd");
    expect(prd).toContain(`if: github.event.schedule == '${CRON_PRD}' && vars.PRD_URL != ''`);
    expect(prd).toContain("secrets.PRD_CRON_SECRET");
    expect(prd).toContain("vars.PRD_URL");
    expect(prd).toContain("scripts/lib/hosts-vetados.mjs --conocido");
    expect(prd).not.toMatch(/secrets\.(CRON_SECRET|QA_CRON_SECRET)/);
  });

  it("los jobs de dev no tocan el secreto ni la URL de prd", () => {
    for (const id of ["barrer", "salud"]) {
      expect(cuerpoDe(yml, id)).not.toMatch(/PRD_/);
    }
  });
});

describe("scripts/sync-vercel-env.mjs: prd no se carga con el .env.local de dev", () => {
  const correr = (...args: string[]) =>
    spawnSync(process.execPath, ["scripts/sync-vercel-env.mjs", ...args], {
      cwd: process.cwd(),
      encoding: "utf8",
    });

  it.each([
    [["--project", "claimmix-prd"]],
    [["--project", "claimmix-prd", "--archivo", ".env.local"]],
    [["--project", "claimmix-prd", "--archivo", "./scripts/../.env.local"]],
  ])("se niega con %j", (args) => {
    const r = correr(...args);
    expect(r.status).toBe(1);
    expect(r.stderr).toContain("claimmix-prd no se carga desde .env.local");
  });

  it("se niega a un nombre de proyecto que no es un nombre", () => {
    const r = correr("--project", "claimmix; echo fake");
    expect(r.status).toBe(1);
    expect(r.stderr).toContain("el nombre no es válido");
  });
});
