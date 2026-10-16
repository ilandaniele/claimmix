import { spawnSync } from "node:child_process";
import { chmodSync, existsSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { delimiter, join, resolve } from "node:path";
import { describe, expect, it } from "vitest";

// Un PR que sólo toca `.md` no repite tests, CodeQL ni el ensayo de QA cuando
// el árbol del padre ya pasó. Lo decide el mismo filtro de jq en tres
// workflows; acá se fija que sea el mismo, que caiga del lado seguro y que no
// deje afuera un `.md` que algún test o script sí lee.

const leer = (nombre: string) =>
  readFileSync(resolve(process.cwd(), ".github/workflows", nombre), "utf8").replace(/\r\n/g, "\n");

const cuerpoDe = (yml: string, id: string) => {
  const lineas = yml.split("\n");
  const i = lineas.findIndex((l) => l === `  ${id}:`);
  expect(i).toBeGreaterThan(-1);
  const j = lineas.findIndex((l, k) => k > i && /^ {2}[\w-]+:\s*$/.test(l));
  return lineas.slice(i, j === -1 ? undefined : j).join("\n");
};

const pasoDe = (cuerpo: string, nombre: string) => {
  const i = cuerpo.indexOf(`- name: ${nombre}`);
  expect(i).toBeGreaterThan(-1);
  const j = cuerpo.indexOf("\n      - ", i + 1);
  return cuerpo.slice(i, j === -1 ? undefined : j);
};

const scriptDe = (paso: string) => {
  const lineas = paso.slice(paso.indexOf("run: |")).split("\n").slice(1);
  const fin = lineas.findIndex((l) => l.trim() !== "" && !l.startsWith("          "));
  return lineas
    .slice(0, fin === -1 ? undefined : fin)
    .map((l) => l.replace(/^ {10}/, ""))
    .join("\n");
};

const ci = leer("ci.yml");
const codeql = leer("codeql.yml");
const postDeploy = leer("post-deploy.yml");

const SCRIPTS = {
  ci: scriptDe(pasoDe(cuerpoDe(ci, "arbol"), "Buscar la marca")),
  codeql: scriptDe(pasoDe(cuerpoDe(codeql, "analyze"), "¿Sólo documentación?")),
  qa: scriptDe(pasoDe(cuerpoDe(postDeploy, "qa_secretos"), "¿Sólo documentación sobre un árbol ensayado?")),
};

const filtroDe = (script: string) => {
  const m = /compare\/[^"]+" --jq '([^']+)'/.exec(script);
  expect(m).not.toBeNull();
  return m![1];
};

const FILTRO = filtroDe(SCRIPTS.ci);

const correr = (programa: string, args: string[], entrada?: string, env?: NodeJS.ProcessEnv) =>
  spawnSync(programa, args, { encoding: "utf8", input: entrada, env: env ?? process.env });

const hayBash = correr("bash", ["-c", "printf ok"]).stdout === "ok";
const hayJq = correr("jq", ["-n", '"ok"'], undefined).stdout?.trim() === '"ok"';

describe("el filtro de sólo docs", () => {
  it("es el mismo en los tres workflows", () => {
    expect(filtroDe(SCRIPTS.codeql)).toBe(FILTRO);
    expect(filtroDe(SCRIPTS.qa)).toBe(FILTRO);
  });

  // Un `.md` que un test lee es código para este propósito: cambiarlo puede
  // poner rojo un test que el salto no correría.
  it("deja afuera todo `.md` que un test o script lee", () => {
    const leidos = new Set<string>();
    for (const dir of ["tests", "scripts", "src"]) {
      for (const archivo of readdirSync(dir, { recursive: true, encoding: "utf8" })) {
        if (!/\.(m?[jt]sx?|sh)$/.test(archivo) || archivo.endsWith("ci-solo-docs.test.ts")) continue;
        const texto = readFileSync(join(dir, archivo), "utf8");
        for (const m of texto.matchAll(/["'`]([\w@./()-]+\.md)["'`]/g)) {
          if (existsSync(resolve(process.cwd(), m[1]))) leidos.add(m[1]);
        }
      }
    }
    expect(leidos.size).toBeGreaterThan(0);
    for (const md of leidos) expect(FILTRO).toContain(`. != "${md}"`);
  });

  const caso = (archivos: unknown) => JSON.stringify({ files: archivos });
  it.skipIf(!hayJq).each([
    ["sólo docs", caso([{ filename: "docs/PROJECT_STATUS.md" }, { filename: "README.md" }]), "0"],
    ["un test", caso([{ filename: "docs/TESTING.md" }, { filename: "tests/unit/a.test.ts" }]), "1"],
    ["el `.md` que leen los tests", caso([{ filename: "docs/PROMOCION.md" }]), "1"],
    ["código renombrado a `.md`", caso([{ filename: "docs/x.md", previous_filename: "src/x.ts" }]), "1"],
    ["sin lista de archivos", JSON.stringify({}), "1"],
    ["lista truncada", caso(Array.from({ length: 300 }, (_, i) => ({ filename: `docs/${i}.md` }))), "1"],
  ])("%s", (_, entrada, otros) => {
    const r = correr("jq", [FILTRO], entrada);
    expect(r.status).toBe(0);
    expect(r.stdout.trim()).toBe(otros);
  });
});

// Un `gh` falso que contesta según la ruta. Cada llamada sale con
// FALSO_SALIDA, como si la API fallara.
const conGhFalso = (script: string, falso: Record<string, string>) => {
  const dir = mkdtempSync(join(tmpdir(), "gh-falso-"));
  const gh = join(dir, "gh");
  writeFileSync(
    gh,
    [
      "#!/bin/sh",
      'case "$2" in',
      '  *git/commits/padre-sha) echo "$FALSO_ARBOL_PADRE" ;;',
      '  *git/commits/*) echo "$FALSO_ARBOL" ;;',
      '  repos/fake/repo/commits/*) echo "$FALSO_PADRE" ;;',
      '  *verde-arbol-padre*) echo "$FALSO_HAY_PADRE" ;;',
      '  *actions/artifacts*) echo "$FALSO_HAY" ;;',
      '  *compare/*) echo "$FALSO_OTROS" ;;',
      "esac",
      'exit "${FALSO_SALIDA:-0}"',
      "",
    ].join("\n"),
  );
  chmodSync(gh, 0o755);
  const salida = join(dir, "salida");
  writeFileSync(salida, "");
  const r = spawnSync("bash", ["-c", script], {
    encoding: "utf8",
    env: {
      ...process.env,
      PATH: `${dir}${delimiter}${process.env.PATH}`,
      FALSO_ARBOL: "arbol-nuevo",
      FALSO_PADRE: "padre-sha",
      FALSO_ARBOL_PADRE: "arbol-padre",
      FALSO_HAY: "0",
      FALSO_HAY_PADRE: "1",
      FALSO_OTROS: "0",
      GITHUB_OUTPUT: salida,
      GITHUB_STEP_SUMMARY: join(dir, "resumen"),
      GITHUB_REPOSITORY: "fake/repo",
      GITHUB_REPOSITORY_ID: "1",
      GITHUB_SHA: "fake-sha",
      SHA: "fake-sha",
      EVENTO: "pull_request",
      AUTOR: "alguien",
      ...falso,
    },
  });
  const out = readFileSync(salida, "utf8");
  rmSync(dir, { recursive: true, force: true });
  expect(r.status).toBe(0);
  return out;
};

// Lo que no es «sólo docs sobre un árbol aprobado» corre todo.
const SEGURO: [string, Record<string, string>][] = [
  ["otros archivos", { FALSO_OTROS: "2" }],
  ["el padre sin marca", { FALSO_HAY_PADRE: "0" }],
  ["sin padre", { FALSO_PADRE: "" }],
  ["la API falla", { FALSO_SALIDA: "1" }],
  ["respuesta rara", { FALSO_OTROS: "basura" }],
];

describe("ci.yml: `arbol` hereda la marca del padre", () => {
  it.skipIf(!hayBash)("sólo docs sobre un árbol probado: saltea y marca el árbol nuevo", () => {
    expect(conGhFalso(SCRIPTS.ci, {})).toBe("arbol=arbol-nuevo\nsaltear=true\nsolo_docs=true\n");
  });

  it.skipIf(!hayBash)("con su propia marca saltea sin mirar el padre", () => {
    expect(conGhFalso(SCRIPTS.ci, { FALSO_HAY: "1", FALSO_OTROS: "9" })).toContain("saltear=true\nsolo_docs=false\n");
  });

  it.skipIf(!hayBash).each([...SEGURO, ["un disparo a mano", { EVENTO: "workflow_dispatch" }]] as const)(
    "%s: corre todo",
    (_, falso) => {
      expect(conGhFalso(SCRIPTS.ci, falso)).toContain("saltear=false\nsolo_docs=false\n");
    },
  );

  it("la marca del árbol de sólo docs no la deja un fork", () => {
    const cuerpo = cuerpoDe(ci, "arbol");
    const subida = cuerpo.slice(cuerpo.indexOf("- name: Marca del árbol de sólo docs"));
    const condiciones = subida.match(/^ {6}(?:- | {2})if: .*$/gm) ?? [];
    expect(condiciones).toHaveLength(2);
    for (const c of condiciones) {
      expect(c).toContain("steps.buscar.outputs.solo_docs == 'true'");
      expect(c).toContain("github.event.pull_request.head.repo.fork != true");
    }
    expect(subida).toContain("name: ci-verde-${{ steps.buscar.outputs.arbol }}");
  });
});

describe("codeql.yml: un PR de sólo docs no analiza", () => {
  it.skipIf(!hayBash)("sólo docs: avisa", () => {
    expect(conGhFalso(SCRIPTS.codeql, {})).toBe("solo=true\n");
  });

  // CodeQL no necesita marca: un `.md` no cambia lo que analiza.
  it.skipIf(!hayBash).each(SEGURO.filter(([n]) => n !== "el padre sin marca"))("%s: analiza", (_, falso) => {
    expect(conGhFalso(SCRIPTS.codeql, falso)).toBe("");
  });

  it("el aviso sólo corre en PRs, y todo lo demás depende de él", () => {
    const cuerpo = cuerpoDe(codeql, "analyze");
    expect(pasoDe(cuerpo, "¿Sólo documentación?")).toContain("if: github.event_name == 'pull_request'");
    const pasos = cuerpo.split("\n      - ").slice(2);
    expect(pasos.length).toBeGreaterThan(3);
    for (const paso of pasos) expect(paso).toContain("if: steps.docs.outputs.solo != 'true'");
  });
});

describe("post-deploy.yml: QA no repite el ensayo de un árbol de sólo docs", () => {
  it.skipIf(!hayBash)("sólo docs sobre un árbol ensayado: no ensaya", () => {
    expect(conGhFalso(SCRIPTS.qa, {})).toBe("solo_docs=true\n");
  });

  it.skipIf(!hayBash).each(SEGURO)("%s: ensaya", (_, falso) => {
    expect(conGhFalso(SCRIPTS.qa, falso)).toBe("solo_docs=false\n");
  });

  it("busca la marca de QA, y sólo de este repo", () => {
    expect(SCRIPTS.qa).toContain("actions/artifacts?name=ensayo-verde-$arbol_padre");
    expect(SCRIPTS.qa).toContain(".workflow_run.head_repository_id == $GITHUB_REPOSITORY_ID");
  });

  it("apaga sólo el ensayo; el veredicto sigue exigiendo todo lo demás", () => {
    const qa = cuerpoDe(postDeploy, "qa");
    expect(qa).toContain(
      "correr_ensayo: ${{ needs.qa_secretos.outputs.ensayo == '1' && needs.qa_secretos.outputs.solo_docs != 'true' }}",
    );
    expect(qa).toContain("correr_pentest: true");
    const veredicto = cuerpoDe(postDeploy, "qa_veredicto");
    expect(veredicto).toContain("SOLO_DOCS: ${{ needs.qa_secretos.outputs.solo_docs }}");
    const run = scriptDe(pasoDe(veredicto, "Publicar el veredicto sobre el commit"));
    const exito = run.indexOf("estado=success");
    expect(run.lastIndexOf('[ "$SECRETOS" = "success" ] && [ "$QA" = "success" ]', exito)).toBeGreaterThan(-1);
    expect(run.lastIndexOf('[ "$ENSAYO" = "1" ]', exito)).toBeGreaterThan(-1);
    const docs = run.slice(run.indexOf('if [ "$SOLO_DOCS"'));
    expect(docs.slice(0, docs.indexOf("fi")).includes("estado=")).toBe(false);
  });

  it("`qa_secretos` puede leer artefactos", () => {
    expect(cuerpoDe(postDeploy, "qa_secretos")).toMatch(/permissions:\n {6}actions: read\n {6}contents: read\n/);
  });
});
