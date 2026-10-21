import { spawnSync } from "node:child_process";
import { readdirSync, readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";

// Mismo criterio que `ci-secreto-de-sesion.test.ts`: sin comentarios, porque el
// workflow explica el defecto citando la expresión.
const sinComentarios = (nombre: string) =>
  readFileSync(resolve(process.cwd(), ".github/workflows", nombre), "utf8")
    .split(/\r?\n/)
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

// Todos los `run:` de un job, de una línea o de bloque.
const runsDe = (cuerpo: string) => {
  const lineas = cuerpo.split("\n");
  const runs: string[] = [];
  lineas.forEach((l, i) => {
    const m = /^( *)run:\s*(\|?)(.*)$/.exec(l);
    if (!m) return;
    if (!m[2]) return void runs.push(m[3]);
    const resto = lineas.slice(i + 1);
    const fin = resto.findIndex((s) => s.trim() !== "" && s.search(/\S/) <= m[1].length);
    runs.push(resto.slice(0, fin === -1 ? undefined : fin).join("\n"));
  });
  return runs;
};

type Job = { id: string; nombre: string; needs: string[]; condicion: string };

const jobsDe = (nombre: string): Job[] => {
  const lineas = sinComentarios(nombre).split("\n");
  const inicio = lineas.indexOf("jobs:");
  const cuerpos = new Map<string, string[]>();
  let actual: string[] | undefined;
  for (const l of lineas.slice(inicio + 1)) {
    const m = /^ {2}([\w-]+):\s*$/.exec(l);
    if (m) cuerpos.set(m[1], (actual = []));
    else if (/^\S/.test(l)) break;
    else actual?.push(l);
  }
  return [...cuerpos].map(([id, cuerpo]) => {
    const valor = (clave: string) => {
      const i = cuerpo.findIndex((l) => l.startsWith(`    ${clave}:`));
      if (i === -1) return "";
      const resto = [cuerpo[i].slice(`    ${clave}:`.length)];
      for (const l of cuerpo.slice(i + 1)) {
        if (!/^ {5,}\S/.test(l)) break;
        resto.push(l);
      }
      return resto.join("\n").trim();
    };
    const needs = valor("needs")
      .split(/[\s,[\]]+/)
      .filter((t) => t && t !== "-");
    return { id, nombre: valor("name").replace(/^["']|["']$/g, ""), needs, condicion: valor("if") };
  });
};

const checks = sinComentarios("deploy-checks.yml");
const post = sinComentarios("post-deploy.yml");
const alta = cuerpoDe(checks, "alta");
const jobAlta = jobsDe("deploy-checks.yml").find((j) => j.id === "alta")!;

describe("deploy-checks.yml: el interruptor probar_alta", () => {
  it("es un booleano que por omisión está apagado", () => {
    const m = /^ {6}probar_alta:\n((?: {8}\S.*\n)+)/m.exec(checks);
    expect(m).not.toBeNull();
    expect(m![1]).toMatch(/^ {8}type: boolean$/m);
    expect(m![1]).toMatch(/^ {8}default: false$/m);
  });

  it("sólo el job `qa` de post-deploy.yml lo enciende", () => {
    expect(cuerpoDe(post, "qa")).toContain("probar_alta: true");
    const otros = [...post.slice(post.indexOf("\njobs:")).matchAll(/^ {2}([\w-]+):\s*$/gm)]
      .map((m) => m[1])
      .filter((id) => id !== "qa");
    expect(otros).toContain("dev");
    for (const id of otros) expect(cuerpoDe(post, id), id).not.toContain("probar_alta");
  });
});

describe("el job `alta`: cuándo corre y con qué permisos", () => {
  it("existe y no se llama como un estado que un workflow publica", () => {
    expect(jobAlta).toBeDefined();
    expect(jobAlta.nombre).toBe("Alta automática en QA");
    const contextos = new Set<string>();
    for (const f of readdirSync(resolve(process.cwd(), ".github/workflows")).filter((n) => n.endsWith(".yml"))) {
      for (const m of sinComentarios(f).matchAll(/context="([^"]+)"/g)) contextos.add(m[1]);
    }
    expect(contextos.has("Post-deploy QA")).toBe(true);
    expect(contextos.has(jobAlta.nombre)).toBe(false);
  });

  it("espera al smoke, al ensayo y al pen test", () => {
    expect(jobAlta.needs).toEqual(expect.arrayContaining(["smoke", "rehearse", "pentest"]));
  });

  it("corre aunque el ensayo o el pen test fallen, pero no sin el smoke ni apagado", () => {
    expect(jobAlta.condicion).toContain("!cancelled()");
    expect(jobAlta.condicion).toContain("inputs.probar_alta");
    expect(jobAlta.condicion).toContain("needs.smoke.result == 'success'");
  });

  it("sólo lee el repositorio: nada de id-token", () => {
    expect(alta).toMatch(/^ {4}permissions:\n {6}contents: read\n(?! {6}\S)/m);
    expect(alta).not.toContain("id-token");
  });

  it("publica el resultado del paso que recorre el alta", () => {
    expect(alta).toMatch(/^ {4}outputs:\n {6}resultado: \$\{\{ steps\.probar\.outputs\.resultado \}\}$/m);
    expect(pasoDe(alta, "Recorrer el alta")).toContain("id: probar");
  });
});

describe("el job `alta`: qué le llega", () => {
  it("el primer paso después del checkout mira que la URL sea la de QA", () => {
    const pasos = alta.split("\n      - ");
    expect(pasos[1]).toMatch(/^uses: actions\/checkout@/);
    expect(pasos[2]).toContain("name: ¿Es QA?");
    expect(pasos[2]).toContain("hosts-vetados.mjs --qa");
  });

  it("los únicos secretos son los tres que el reusable ya declara", () => {
    const leidos = new Set([...alta.matchAll(/\bsecrets\.([A-Z][A-Z0-9_]*)/g)].map((m) => m[1]));
    expect([...leidos].sort()).toEqual(["CRON_SECRET", "DATABASE_URL", "DATABASE_URL_APP"]);
  });

  it("no lee la demo ni el secreto de sesión de nadie: el suyo se genera y se enmascara", () => {
    expect(alta).not.toContain("DEMO_TENANT_ID");
    expect(alta).not.toMatch(/secrets\.\w*BETTER_AUTH_SECRET/);
    expect(alta).not.toMatch(/^ +BETTER_AUTH_SECRET:/m);
    const run = runsDe(pasoDe(alta, "Recorrer el alta"))[0];
    expect(run).toContain('export BETTER_AUTH_SECRET="$(openssl rand -hex 32)"');
    expect(run).toContain('echo "::add-mask::$BETTER_AUTH_SECRET"');
    expect(run.indexOf("add-mask")).toBeLessThan(run.indexOf("pnpm alta:probar"));
  });

  it("recorre el alta con la corrida y el archivo del resultado", () => {
    const paso = pasoDe(alta, "Recorrer el alta");
    for (const v of [
      "URL: ${{ inputs.url }}",
      "CRON_SECRET: ${{ secrets.CRON_SECRET }}",
      "QA_DATABASE_URL: ${{ secrets.DATABASE_URL }}",
      "QA_DATABASE_URL_APP: ${{ secrets.DATABASE_URL_APP }}",
      "ALTA_CORRIDA: ${{ steps.corrida.outputs.corrida }}",
      "ALTA_RESULTADO: ${{ runner.temp }}/alta-resultado",
    ]) {
      expect(paso).toContain(v);
    }
    expect(runsDe(paso)[0]).toContain(
      'pnpm alta:probar --url "$URL" --corrida "$ALTA_CORRIDA" --resultado "$ALTA_RESULTADO"',
    );
    expect(runsDe(paso)[0]).toContain('echo "resultado=$(cat "$ALTA_RESULTADO")" >> "$GITHUB_OUTPUT"');
  });

  it("barre aunque lo anterior falle, sin el CRON_SECRET", () => {
    const paso = pasoDe(alta, "Barrer lo que haya quedado");
    expect(paso).toMatch(/^ {8}if: always\(\)$/m);
    expect(runsDe(paso)[0]).toContain("pnpm alta:probar");
    expect(runsDe(paso)[0]).toContain("--solo-barrer");
    expect(paso).toContain("QA_DATABASE_URL: ${{ secrets.DATABASE_URL }}");
    expect(paso).toContain("QA_DATABASE_URL_APP: ${{ secrets.DATABASE_URL_APP }}");
    expect(paso).not.toContain("CRON_SECRET");
  });

  it("si falla, dice cómo repetirlo", () => {
    const paso = pasoDe(alta, "Qué significa que esto falle");
    expect(paso).toContain("if: failure()");
    expect(paso).toMatch(/docs\/TESTING\.md/);
    expect(paso).toContain("gh run rerun <id> --failed");
  });
});

describe("el job `alta`: un aviso que aprueba no tiene lugar", () => {
  // Los avisos los imprime el guion. Acá un `::warning` con la red caída
  // dejaría el check en verde sin haber probado nada (invariante 13).
  it("no lleva ::warning ni ::notice", () => {
    expect(alta).not.toMatch(/::(?:warning|notice)\b/);
  });

  it("ningún `run:` interpola `${{` ni usa -z o -n", () => {
    const runs = runsDe(alta);
    expect(runs.length).toBeGreaterThanOrEqual(5);
    for (const r of runs) {
      expect(r).not.toContain("${{");
      expect(r).not.toMatch(/(^|\s)-[zn](\s|$)/);
    }
  });
});

describe("los jobs que miran lo que corrió", () => {
  const jobs = jobsDe("deploy-checks.yml");

  it("`carga` espera al alta: los dos tocan la base de QA", () => {
    expect(jobs.find((j) => j.id === "carga")!.needs).toContain("alta");
  });

  it("`alcance` espera al alta y escribe su fila", () => {
    expect(jobs.find((j) => j.id === "alcance")!.needs).toContain("alta");
    const alcance = cuerpoDe(checks, "alcance");
    expect(alcance).toContain("ALTA: ${{ needs.alta.result }}");
    expect(alcance).toContain("ALTA_RESULTADO: ${{ needs.alta.outputs.resultado }}");
    expect(alcance).toContain("corrió SIN PODER PROBAR");
    expect(alcance).toContain('"probar_alta"');
  });
});

describe("el paso «¿Es QA?» corre de verdad", () => {
  // Corre cuando hay un bash que pasa el entorno (el runner, Git Bash). El
  // `bash` de WSL no lo pasa y entonces se saltea.
  const hayBash =
    spawnSync("bash", ["-c", 'printf %s "$SONDA"'], { encoding: "utf8", env: { ...process.env, SONDA: "ok" } }).stdout === "ok";

  it.skipIf(!hayBash).each([
    ["https://claimmix-qa.vercel.app", 0],
    ["https://claimmix.vercel.app", 1],
    ["https://claimmix-prd.vercel.app", 1],
    ["https://claimmix-dev.vercel.app", 1],
    ["https://claimmix-qa-git-rama-equipo.vercel.app", 1],
    ["http://claimmix-qa.vercel.app", 1],
    ["no-es-una-url", 1],
  ])("URL %s: sale con %i", (url, esperado) => {
    const r = spawnSync("bash", ["-c", scriptDe(pasoDe(alta, "¿Es QA?"))], {
      encoding: "utf8",
      cwd: process.cwd(),
      env: { ...process.env, URL: url, PRD_URL: "" },
    });
    expect(r.status).toBe(esperado);
    if (esperado !== 0) expect(r.stdout).toContain("::error::");
  });
});
