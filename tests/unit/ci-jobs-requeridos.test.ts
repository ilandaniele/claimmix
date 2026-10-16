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

// Los checks que bloquean el merge son los de la tabla de `docs/PROMOCION.md`.
const requeridos = (): Set<string> => {
  const md = readFileSync(resolve(process.cwd(), "docs/PROMOCION.md"), "utf8").split(/\r?\n/);
  const desde = md.findIndex((l) => l.startsWith("### Antes de mergear"));
  const hasta = md.findIndex((l, i) => i > desde && l.startsWith("### "));
  const nombres = md
    .slice(desde + 1, hasta)
    .filter((l) => l.startsWith("|"))
    .flatMap((l) => [...(l.split("|")[1] ?? "").matchAll(/`([^`]+)`/g)].map((m) => m[1]));
  return new Set(nombres);
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

const workflows = () =>
  readdirSync(resolve(process.cwd(), ".github/workflows")).filter((f) => f.endsWith(".yml"));

describe("un check requerido no queda skipped porque falló uno que no lo es", () => {
  // GitHub cuenta un job salteado como pasado. Si un job requerido depende de
  // uno que no lo es y no declara `!cancelled()` o `always()`, un PR con el
  // otro en rojo muestra todos los requeridos en verde sin haberlo corrido.
  // Depender de otro requerido no abre el hueco: ese rojo ya bloquea el merge.
  const delRepo = requeridos();

  it("la tabla de PROMOCION.md nombra los requeridos de ci.yml", () => {
    for (const n of ["Tipos y lint", "Build", "Tests E2E", "Aislamiento de tenants", "Pen test local"]) {
      expect(delRepo.has(n)).toBe(true);
    }
    expect(delRepo.has("Tests de integración")).toBe(false);
  });

  it("todo job requerido que espera a uno que no lo es declara `!cancelled()` o `always()`", () => {
    const revisados: string[] = [];
    const sinCondicion: string[] = [];
    for (const archivo of workflows()) {
      const jobs = jobsDe(archivo);
      const nombreDe = new Map(jobs.map((j) => [j.id, j.nombre]));
      for (const job of jobs) {
        if (!delRepo.has(job.nombre)) continue;
        if (!job.needs.some((id) => !delRepo.has(nombreDe.get(id) ?? ""))) continue;
        revisados.push(job.id);
        if (!/!cancelled\(\)|\balways\(\)/.test(job.condicion)) sinCondicion.push(`${archivo}:${job.id}`);
      }
    }
    // Que el recorrido encontró lo que tenía que encontrar y no pasa en vacío.
    expect(revisados).toEqual(expect.arrayContaining(["tenencia-capa-datos", "e2e-tests"]));
    expect(sinCondicion).toEqual([]);
  });
});

describe("ningún job se llama como un estado que un workflow publica", () => {
  // Cada corrida deja un check run con el nombre del job sobre el SHA, aun las
  // que lo saltean, y GitHub cuenta un salteado como aprobado: un job con el
  // nombre del estado lo muestra verde antes de que el estado exista, o junto a
  // un estado rojo.
  it("los contextos de `gh api …/statuses` no coinciden con el `name` de ningún job", () => {
    const contextos = new Set<string>();
    const nombres = new Map<string, string>();
    for (const archivo of workflows()) {
      for (const m of sinComentarios(archivo).matchAll(/context="([^"]+)"/g)) contextos.add(m[1]);
      for (const job of jobsDe(archivo)) if (job.nombre) nombres.set(`${archivo}:${job.id}`, job.nombre);
    }
    // Que el recorrido encontró lo que tenía que encontrar y no pasa en vacío.
    expect(contextos.has("Post-deploy QA")).toBe(true);
    const repetidos = [...nombres].filter(([, nombre]) => contextos.has(nombre)).map(([id]) => id);
    expect(repetidos).toEqual([]);
  });
});

describe("con la base del ensayo presente, un secreto vacío corta en vez de saltear", () => {
  const ci = sinComentarios("ci.yml");
  const paso = (nombre: string) => {
    const i = ci.indexOf(`- name: ${nombre}`);
    expect(i).toBeGreaterThan(-1);
    const j = ci.indexOf("\n      - ", i + 1);
    return ci.slice(i, j === -1 ? undefined : j);
  };

  it("el sembrado exige las cuatro contraseñas antes de `pnpm sembrar`", () => {
    const run = paso("Sembrar la base del ensayo");
    const antes = run.slice(0, run.indexOf("pnpm sembrar"));
    for (const v of ["TEST", "ADMIN", "LOGIN", "E2E"]) expect(antes).toContain(`INTEGRATION_${v}_PASSWORD`);
    expect(antes).toContain("exit 1");
  });

  it("los e2e exigen cuentas, casos y R2 antes de `pnpm test:e2e`", () => {
    const run = paso("Run E2E tests");
    const antes = run.slice(0, run.indexOf("pnpm test:e2e"));
    for (const v of [
      "PLAYWRIGHT_ADMIN_PASSWORD",
      "PLAYWRIGHT_EMAIL_CASE_ID",
      "PLAYWRIGHT_EMPTY_CASE_ID",
      "TEST_ANALYST_PASSWORD",
      "R2_BUCKET",
    ]) {
      expect(antes).toContain(v);
    }
    expect(antes).toContain("exit 1");
  });

  it("`pnpm sembrar` tira bajo CI=true si falta una contraseña, sin tocar la base", () => {
    // Falta una de las cuatro cada vez, así que nunca llega a conectarse.
    const claves = {
      INTEGRATION_TEST_PASSWORD: "fake-clave",
      INTEGRATION_ADMIN_PASSWORD: "fake-clave",
      INTEGRATION_LOGIN_PASSWORD: "fake-clave",
      INTEGRATION_E2E_PASSWORD: "fake-clave",
    };
    for (const falta of ["INTEGRATION_TEST_PASSWORD", "INTEGRATION_LOGIN_PASSWORD", "INTEGRATION_E2E_PASSWORD"]) {
      const r = spawnSync(process.execPath, ["--import", "tsx", "scripts/sembrar-para-integracion.mts"], {
        cwd: process.cwd(),
        encoding: "utf8",
        env: {
          ...process.env,
          ...claves,
          [falta]: "",
          CI: "true",
          SEED_DATABASE_URL: "postgresql://fake:fake@localhost/fake",
          TSX_TSCONFIG_PATH: "tsconfig.rehearsal.json",
        },
      });
      expect(r.status).not.toBe(0);
      expect(r.stderr).toContain(`Falta ${falta}`);
    }
  }, 60_000);
});
