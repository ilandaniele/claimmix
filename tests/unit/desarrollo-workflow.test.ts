// @vitest-environment node
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";

// El workflow es un script con `await` y `return` al tope, sin módulo: se lo corre
// como cuerpo de una función async con un `agent` de mentira que anota las opciones.
const FUENTE = readFileSync(resolve(__dirname, "../../.claude/workflows/desarrollo.js"), "utf8").replace(
  "export const meta =",
  "const meta =",
);
const AsyncFunction = Object.getPrototypeOf(async () => {}).constructor as new (
  ...a: string[]
) => (...v: unknown[]) => Promise<unknown>;

type Llamada = { label: string; model?: string };

async function correr(args: unknown, { checkFalla = false } = {}) {
  const llamadas: Llamada[] = [];
  let checks = 0;
  const agent = async (_pedido: string, opciones: Llamada & Record<string, unknown>) => {
    llamadas.push({ label: opciones.label, model: opciones.model });
    const l = opciones.label;
    if (l === "explorar") return { zonas: [{ nombre: "z", archivos: [], pregunta: "?" }], invariantes: [], tests_existentes: [] };
    if (l.startsWith("leer:")) return { zona: "z", como_funciona: "", donde_se_enchufa: "", que_se_rompe: [], tests: [] };
    if (l.startsWith("diseño:")) return { clave: l.slice(7), resumen: "", archivos: [], pasos: [], tests: [], riesgos: [] };
    if (l.startsWith("juez:")) return { puntajes: [], mejor: "minimo", injertos: [] };
    if (l === "síntesis") return { resumen: "plan", archivos: [], pasos: [], tests: [], riesgos: [], no_hacer: [] };
    if (l === "implementar" || l.startsWith("corregir:")) return { archivos_tocados: [], tests_agregados: [], como_se_probo: "", dudas: [] };
    if (l === "revisar:correccion:ronda1") {
      return { hallazgos: [{ titulo: "algo", archivo: "a.ts", por_que: "porque", gravedad: "baja" }] };
    }
    if (l.startsWith("revisar:")) return { hallazgos: [] };
    if (l.startsWith("refutar:")) return { refutado: false, por_que: "" };
    if (l === "check" || l === "check:2") {
      checks++;
      const ok = !(checkFalla && checks === 1);
      return { capas: [{ nombre: "tipos", ok, detalle: "" }], transcripto_suena_bien: true, observaciones: [] };
    }
    if (l === "pr") return { commit: "c", pr_url: "u", resumen: "" };
    throw new Error(`label inesperado: ${l}`);
  };
  const fn = new AsyncFunction("args", "agent", "phase", "parallel", "log", FUENTE);
  await fn(args, agent, () => {}, (fns: Array<() => unknown>) => Promise.all(fns.map((f) => f())), () => {});
  return llamadas;
}

const modeloDe = (llamadas: Llamada[], label: string) => llamadas.filter((l) => l.label === label).map((l) => l.model);

describe("desarrollo.js: quién edita corre en Sonnet", () => {
  it("implementar y las dos correcciones van en sonnet sin args.editar", async () => {
    const llamadas = await correr({ tarea: "t" }, { checkFalla: true });
    expect(modeloDe(llamadas, "implementar")).toEqual(["sonnet"]);
    expect(modeloDe(llamadas, "corregir:ronda1")).toEqual(["sonnet"]);
    expect(modeloDe(llamadas, "corregir:check")).toEqual(["sonnet"]);
  });

  it("args.editar pide otro modelo para las tres etapas", async () => {
    const llamadas = await correr({ tarea: "t", editar: "opus" }, { checkFalla: true });
    expect(modeloDe(llamadas, "implementar")).toEqual(["opus"]);
    expect(modeloDe(llamadas, "corregir:ronda1")).toEqual(["opus"]);
    expect(modeloDe(llamadas, "corregir:check")).toEqual(["opus"]);
  });

  it("check, check:2 y pr siguen en sonnet, y entender y diseñar no fijan modelo", async () => {
    const llamadas = await correr({ tarea: "t", editar: "opus" }, { checkFalla: true });
    for (const l of ["check", "check:2", "pr"]) expect(modeloDe(llamadas, l)).toEqual(["sonnet"]);
    for (const l of ["explorar", "síntesis", "revisar:correccion:ronda1"]) expect(modeloDe(llamadas, l)).toEqual([undefined]);
  });

  it("los refutadores no cambian: sonnet, y fable con opus de respaldo sólo en seguridad", async () => {
    const llamadas = await correr({ tarea: "t", editar: "opus" });
    expect(modeloDe(llamadas, "refutar:algo")).toEqual(["sonnet"]);
    expect(modeloDe(llamadas, "revisar:seguridad:ronda1")).toEqual(["fable"]);
  });
});
