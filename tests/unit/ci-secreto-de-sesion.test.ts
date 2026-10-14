import { spawnSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";

// Mismo criterio que `scripts/check-architecture.mjs`: sin comentarios, porque
// el workflow explica el defecto citando la expresión.
const sinComentarios = (nombre: string) =>
  readFileSync(resolve(process.cwd(), ".github/workflows", nombre), "utf8")
    .split(/\r?\n/)
    .map((l) => l.replace(/(^|\s)#.*$/, "$1"))
    .join("\n");

describe("el secreto de sesión de producción no llega a los jobs de PR", () => {
  it("ci.yml no lee secrets.BETTER_AUTH_SECRET", () => {
    expect(sinComentarios("ci.yml")).not.toMatch(/\$\{\{\s*secrets\.BETTER_AUTH_SECRET\b/);
  });

  it("cada job que firma sesiones genera su propio valor", () => {
    expect(sinComentarios("ci.yml").match(/openssl rand -hex 32/g)?.length ?? 0).toBeGreaterThanOrEqual(2);
  });

  it("deploy-checks.yml no lee secrets.BETTER_AUTH_SECRET y genera el suyo", () => {
    const yml = sinComentarios("deploy-checks.yml");
    expect(yml).not.toMatch(/\$\{\{\s*secrets\.BETTER_AUTH_SECRET\b/);
    expect(yml.match(/openssl rand -hex 32/g)?.length ?? 0).toBeGreaterThanOrEqual(1);
  });

  it("post-deploy.yml no lee secrets.QA_BETTER_AUTH_SECRET", () => {
    expect(sinComentarios("post-deploy.yml")).not.toMatch(/\$\{\{\s*secrets\.QA_BETTER_AUTH_SECRET\b/);
  });
});

describe("el disparo a mano del post-deploy de producción", () => {
  it("sólo admite el alias de dev: `produccion` hereda los secretos de dev", () => {
    const yml = sinComentarios("post-deploy.yml");
    expect(yml).toContain("claimmix-dev.vercel.app) ;;");
    expect(yml).not.toContain("claimmix-qa.vercel.app) ;;");
    expect(yml).not.toContain("claimmix-prd.vercel.app) ;;");
    expect(yml).not.toContain("claimmix.vercel.app|claimmix-qa.vercel.app");
  });
});

describe("el ensayo del deploy usa los mismos topes de IA que Vercel", () => {
  it("deploy-checks.yml pasa los dos: el del inquilino y el de lo anónimo", () => {
    const yml = sinComentarios("deploy-checks.yml");
    expect(yml).toContain("AI_TENANT_DAILY_TOKEN_CAP: ${{ vars.AI_TENANT_DAILY_TOKEN_CAP");
    expect(yml).toContain("AI_ANONIMO_DAILY_TOKEN_CAP: ${{ vars.AI_ANONIMO_DAILY_TOKEN_CAP }}");
  });
});

describe("las vistas previas no reciben el CRON_SECRET de producción", () => {
  it.each(["deploy-checks.yml", "post-deploy.yml", "barrer-trabados.yml"])(
    "%s no admite el sufijo de las vistas previas",
    (nombre) => {
      expect(sinComentarios(nombre)).not.toContain("ilandaniele-3471s-projects");
    },
  );
});

describe("el disparo a mano de deploy-checks.yml", () => {
  // `workflow_dispatch` resuelve los secretos del repositorio, que son los de
  // dev: el único destino que les corresponde es el alias de dev.
  // El paso se lee crudo —con sus comentarios, que no cambian el script— para
  // poder correrlo tal como lo corre el runner.
  const pasoDestino = () => {
    const lineas = readFileSync(resolve(process.cwd(), ".github/workflows/deploy-checks.yml"), "utf8").split(/\r?\n/);
    const i = lineas.findIndex((l) => l.includes("- name: ¿A dónde apunta esto?"));
    expect(i).toBeGreaterThan(-1);
    const fin = lineas.findIndex((l, k) => k > i && /^ {6}- /.test(l));
    return lineas.slice(i, fin === -1 ? undefined : fin);
  };
  const script = () => {
    const paso = pasoDestino();
    return paso
      .slice(paso.findIndex((l) => l.trim() === "run: |") + 1)
      .map((l) => l.replace(/^ {10}/, ""))
      .join("\n");
  };

  it("el evento entra por `env:` y no interpolado en el shell", () => {
    expect(pasoDestino().join("\n")).toContain("EVENTO: ${{ github.event_name }}");
    expect(script()).not.toContain("${{");
  });

  it("por workflow_dispatch corta todo host que no sea el alias de dev", () => {
    expect(script()).toMatch(
      /\[ "\$EVENTO" = "workflow_dispatch" \] && \[ "\$HOST" != "claimmix-dev\.vercel\.app" \]/,
    );
  });

  it("el job `qa` del post-deploy llama sólo por deployment_status, así que el corte no lo alcanza", () => {
    const yml = sinComentarios("post-deploy.yml");
    const desde = yml.indexOf("\n  qa:\n");
    expect(desde).toBeGreaterThan(-1);
    const llamada = yml.slice(desde, yml.indexOf("uses: ./.github/workflows/deploy-checks.yml", desde));
    expect(llamada).toContain("github.event.deployment_status.state == 'success'");
    expect(llamada).not.toContain("workflow_dispatch");
  });

  // El script corre de verdad cuando hay un bash que pasa el entorno (el
  // runner, Git Bash). El `bash` de WSL no lo pasa y entonces se saltea.
  const hayBash =
    spawnSync("bash", ["-c", 'printf %s "$SONDA"'], { encoding: "utf8", env: { ...process.env, SONDA: "ok" } }).stdout === "ok";

  it.skipIf(!hayBash).each([
    ["workflow_dispatch", "https://claimmix-dev.vercel.app", 0],
    ["workflow_dispatch", "https://claimmix-qa.vercel.app", 1],
    ["workflow_dispatch", "https://claimmix.vercel.app", 1],
    ["workflow_dispatch", "https://claimmix-prd.vercel.app", 1],
    ["workflow_dispatch", "https://claimmix-git-rama-equipo.vercel.app", 1],
    ["workflow_dispatch", "https://claimmix-dev.vercel.app/ruta", 1],
    ["deployment_status", "https://claimmix-dev.vercel.app", 0],
    ["deployment_status", "https://claimmix-qa.vercel.app", 0],
    ["deployment_status", "https://claimmix-git-rama-equipo.vercel.app", 1],
    ["deployment_status", "http://claimmix-dev.vercel.app", 1],
  ])("evento %s, URL %s: sale con %i", (evento, url, esperado) => {
    const r = spawnSync("bash", ["-c", script()], {
      encoding: "utf8",
      env: { ...process.env, EVENTO: evento, URL: url },
    });
    expect(r.status).toBe(esperado);
    if (esperado !== 0) expect(r.stdout).toContain("::error::");
  });
});
