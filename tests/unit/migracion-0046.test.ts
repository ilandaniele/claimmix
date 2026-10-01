/**
 * La 0046 se aplica a mano, en tres bases, y puede correr más de una vez: cada
 * sentencia tiene que poder repetirse sin error. Instala un trigger en el camino
 * de escritura de `ai_usage` y lo hace con SECURITY DEFINER, así que lo que se
 * vigila acá es lo que no se puede romper en silencio: que el trigger no se deje
 * engañar (search_path, EXECUTE, inquilino de la sesión), que no escriba en
 * ningún lado más que en el acumulador y que `claimmix_app` sólo pueda leerlo.
 */

import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";

import { describe, expect, it } from "vitest";

import { ZONA_ARGENTINA } from "@/core/fecha/dia-argentino";
import { PERMISOS_QUITADOS } from "../../scripts/lib/permisos-quitados.mjs";
import { splitSqlStatements } from "../../scripts/lib/split-sql.mjs";

const ARCHIVO = "0046_uso_de_ia_por_mes.sql";
const CRUDO = readFileSync(join(process.cwd(), "neon/migrations", ARCHIVO), "utf8");
const SQL = CRUDO.split(/\r?\n/)
  .map((l) => l.replace(/--.*$/, ""))
  .join("\n");
const sentencias: string[] = splitSqlStatements(SQL).map((s: string) => s.replace(/\s+/g, " ").trim());
const plano = sentencias.join(";\n");

const empieza = (prefijo: string) => sentencias.find((s) => s.startsWith(prefijo)) ?? "";
const posicion = (prefijo: string) => sentencias.findIndex((s) => s.startsWith(prefijo));

const TABLA = empieza("CREATE TABLE IF NOT EXISTS public.ai_usage_mensual ");
const FUNCION = empieza("CREATE OR REPLACE FUNCTION public.claimmix_ai_usage_mensual_sumar()");
const FUNCION_MES = empieza("CREATE OR REPLACE FUNCTION public.claimmix_mes_argentino(");

describe("migración 0046", () => {
  it("lleva el prefijo 0046 y es la única con ese número", () => {
    const con0046 = readdirSync(join(process.cwd(), "neon/migrations")).filter((f) => f.startsWith("0046_"));
    expect(con0046).toEqual([ARCHIVO]);
  });

  it("la cabecera dice que se aplica a mano, en qué orden y cómo se deshace", () => {
    expect(CRUDO).toContain("A MANO");
    expect(CRUDO).toContain("El código NO puede llegar antes");
    expect(CRUDO).toContain("42P01");
    expect(CRUDO).toContain("Vuelta atrás");
    expect(CRUDO).toContain("EXCEPT");
    // QA primero, después la viva y por último la rama de Veltra.
    const qa = CRUDO.indexOf("ep-wispy-flower");
    const viva = CRUDO.indexOf("ep-proud-resonance");
    const veltra = CRUDO.indexOf("Veltra");
    expect(qa).toBeGreaterThan(-1);
    expect(viva).toBeGreaterThan(qa);
    expect(veltra).toBeGreaterThan(viva);
  });

  it("recomponer el acumulador es volver a aplicar la migración entera, nunca el backfill suelto", () => {
    // Suelto no lleva el LOCK ni la transacción: con autocommit, el DELETE queda
    // confirmado y un INSERT que choca con el trigger (23505) deja el acumulador vacío.
    const receta = CRUDO.slice(CRUDO.indexOf("Qué NO atrapa"), CRUDO.indexOf("Costo en la escritura"));
    expect(receta).toContain("node scripts/migrate.mjs --env <VAR> --forget 0046 --apply");
    expect(receta).toContain("node scripts/migrate.mjs --env <VAR> --apply");
    expect(receta).toMatch(/No se corre suelta la sección de «Backfill»/);
    expect(receta).toContain("LOCK");
    expect(CRUDO).not.toMatch(/corriendo (de nuevo )?(la sección de «Backfill»|el backfill)/);
    expect(CRUDO).toMatch(/COMMENT ON TABLE public.ai_usage_mensual IS[^']*'[^']*volviendo a aplicar la 0046 entera/);
  });

  it("ai_usage_mensual: una fila por inquilino, mes, usuario y modelo, sin FK y con el usuario nulo como un valor más", () => {
    expect(TABLA).toMatch(/tenant_id uuid NOT NULL,/);
    expect(TABLA).toMatch(/mes date NOT NULL,/);
    expect(TABLA).toMatch(/user_id uuid,/);
    expect(TABLA).toMatch(/model text NOT NULL,/);
    expect(TABLA).toMatch(/calls bigint NOT NULL DEFAULT 0,/);
    expect(TABLA).toMatch(/prompt_tokens bigint NOT NULL DEFAULT 0,/);
    expect(TABLA).toMatch(/completion_tokens bigint NOT NULL DEFAULT 0,/);
    expect(TABLA).toMatch(/cost_usd numeric NOT NULL DEFAULT 0,/);
    expect(TABLA).toMatch(/UNIQUE NULLS NOT DISTINCT \(tenant_id, mes, user_id, model\)/);
    expect(TABLA).not.toMatch(/REFERENCES/);
  });

  it("fuerza RLS en el acumulador con la política del inquilino, y sólo si no estaba", () => {
    expect(plano).toMatch(/ALTER TABLE public\.ai_usage_mensual ENABLE ROW LEVEL SECURITY/);
    expect(plano).toMatch(/ALTER TABLE public\.ai_usage_mensual FORCE ROW LEVEL SECURITY/);
    const bloque = empieza("DO $$ BEGIN IF NOT EXISTS ( SELECT 1 FROM pg_policies");
    expect(bloque).toMatch(/tablename = 'ai_usage_mensual' AND policyname = 'claimmix_tenant_isolation'/);
    expect(bloque).toMatch(
      /CREATE POLICY claimmix_tenant_isolation ON public\.ai_usage_mensual USING \(public\.claimmix_tenant_matches\(tenant_id\)\) WITH CHECK \(public\.claimmix_tenant_matches\(tenant_id\)\)/
    );
    expect(plano.match(/CREATE POLICY/g)).toHaveLength(1);
  });

  it("claimmix_app sólo lee el acumulador, y sólo si el rol existe", () => {
    const bloque = sentencias.find((s) => s.includes("pg_roles WHERE rolname = 'claimmix_app'")) ?? "";
    expect(bloque).toMatch(/GRANT SELECT ON public\.ai_usage_mensual TO claimmix_app/);
    expect(bloque).toMatch(/REVOKE INSERT, UPDATE, DELETE, TRUNCATE ON public\.ai_usage_mensual FROM claimmix_app/);
    expect(bloque).not.toMatch(/GRANT[^;]*(INSERT|UPDATE|DELETE)/);
  });

  it("coincide con la lista que sostienen create-app-role y pnpm permisos", () => {
    expect(PERMISOS_QUITADOS.ai_usage_mensual).toEqual(["INSERT", "UPDATE", "DELETE"]);
  });

  it("corta antes de crear nada si el rol no puede saltear RLS", () => {
    const aviso = empieza("DO $$ BEGIN IF NOT EXISTS ( SELECT 1 FROM pg_roles WHERE rolname = current_user");
    expect(aviso).toMatch(/rolbypassrls/);
    expect(aviso).toMatch(/RAISE EXCEPTION/);
    expect(posicion("DO $$ BEGIN IF NOT EXISTS ( SELECT 1 FROM pg_roles WHERE rolname = current_user")).toBe(0);
  });

  it("claimmix_mes_argentino cuenta el mes en la misma zona que el código", () => {
    expect(FUNCION_MES).toMatch(/RETURNS date/);
    expect(FUNCION_MES).toMatch(/\bIMMUTABLE\b/);
    expect(FUNCION_MES).toContain(`ts AT TIME ZONE '${ZONA_ARGENTINA}'`);
    expect(FUNCION_MES).toMatch(/date_trunc\('month', ts AT TIME ZONE '[^']+'\)::date/);
  });

  describe("el trigger", () => {
    it("es SECURITY DEFINER, con el search_path fijo, y nadie puede ejecutarlo directo", () => {
      expect(FUNCION).toMatch(/RETURNS trigger/);
      expect(FUNCION).toMatch(/\bSECURITY DEFINER\b/);
      expect(FUNCION).toMatch(/SET search_path = pg_catalog, public\b/);
      expect(sentencias).toContain(
        "REVOKE EXECUTE ON FUNCTION public.claimmix_ai_usage_mensual_sumar() FROM PUBLIC"
      );
    });

    it("toma el inquilino de la fila y nunca de la sesión", () => {
      expect(FUNCION).not.toMatch(/current_setting|claimmix_current_tenant_id|claimmix_tenant_matches/);
      expect(FUNCION).toMatch(/WHERE tenant_id = OLD\.tenant_id/);
      expect(FUNCION).toMatch(/\(NEW\.tenant_id, /);
    });

    it("todo lo que nombra está calificado con su esquema", () => {
      expect(FUNCION).not.toMatch(/(?<!DISTINCT\s)\b(FROM|INTO|JOIN)\s+(?!public\.)\w/);
      expect(FUNCION).toMatch(/public\.claimmix_mes_argentino\(OLD\.created_at\)/);
      expect(FUNCION).toMatch(/public\.claimmix_mes_argentino\(NEW\.created_at\)/);
    });

    it("el UPDATE y el DELETE restan la fila vieja; sólo el INSERT y el UPDATE suman la nueva", () => {
      expect(FUNCION).toMatch(
        /IF TG_OP IN \('UPDATE', 'DELETE'\) THEN UPDATE public\.ai_usage_mensual SET calls = calls - 1, prompt_tokens = prompt_tokens - OLD\.prompt_tokens, completion_tokens = completion_tokens - OLD\.completion_tokens, cost_usd = cost_usd - OLD\.cost_usd WHERE tenant_id = OLD\.tenant_id AND mes = public\.claimmix_mes_argentino\(OLD\.created_at\) AND user_id IS NOT DISTINCT FROM OLD\.user_id AND model = OLD\.model; END IF;/
      );
      expect(FUNCION).toMatch(/IF TG_OP IN \('INSERT', 'UPDATE'\) THEN INSERT INTO public\.ai_usage_mensual/);
      // Un DELETE nunca llega al INSERT: la única inserción de la función está en esa rama.
      expect(FUNCION.match(/INSERT INTO/g)).toHaveLength(1);
    });

    it("el upsert apunta a la misma clave única de la tabla y suma lo que entra", () => {
      expect(FUNCION).toMatch(/ON CONFLICT \(tenant_id, mes, user_id, model\) DO UPDATE/);
      expect(FUNCION).toMatch(/calls = m\.calls \+ 1/);
      expect(FUNCION).toMatch(/prompt_tokens = m\.prompt_tokens \+ EXCLUDED\.prompt_tokens/);
      expect(FUNCION).toMatch(/completion_tokens = m\.completion_tokens \+ EXCLUDED\.completion_tokens/);
      expect(FUNCION).toMatch(/cost_usd = m\.cost_usd \+ EXCLUDED\.cost_usd/);
      expect(TABLA).toMatch(/UNIQUE NULLS NOT DISTINCT \(tenant_id, mes, user_id, model\)/);
    });

    it("se crea después de la función, se reemplaza si ya estaba y dispara por fila en los tres casos", () => {
      const baja = posicion("DROP TRIGGER IF EXISTS trg_ai_usage_mensual ON public.ai_usage");
      const alta = posicion("CREATE TRIGGER trg_ai_usage_mensual");

      expect(baja).toBeGreaterThan(posicion("CREATE OR REPLACE FUNCTION public.claimmix_ai_usage_mensual_sumar()"));
      expect(alta).toBe(baja + 1);
      expect(sentencias[alta]).toBe(
        "CREATE TRIGGER trg_ai_usage_mensual AFTER INSERT OR UPDATE OR DELETE ON public.ai_usage FOR EACH ROW EXECUTE FUNCTION public.claimmix_ai_usage_mensual_sumar()"
      );
      expect(plano.match(/CREATE TRIGGER/g)).toHaveLength(1);
    });
  });

  describe("el backfill", () => {
    it("traba las escrituras de ai_usage antes de crear el trigger y de contar la historia", () => {
      const candado = posicion("LOCK TABLE public.ai_usage IN SHARE ROW EXCLUSIVE MODE");

      expect(candado).toBeGreaterThan(-1);
      expect(sentencias[candado]).toBe("LOCK TABLE public.ai_usage IN SHARE ROW EXCLUSIVE MODE");
      expect(candado).toBeLessThan(posicion("DROP TRIGGER IF EXISTS"));
      expect(candado).toBeLessThan(posicion("DELETE FROM public.ai_usage_mensual"));
      expect(candado).toBeLessThan(posicion("INSERT INTO public.ai_usage_mensual"));
    });

    it("borra todo el acumulador y lo vuelve a contar entero, así que se puede repetir", () => {
      const borrado = posicion("DELETE FROM public.ai_usage_mensual");
      const conteo = posicion("INSERT INTO public.ai_usage_mensual");

      expect(sentencias[borrado]).toBe("DELETE FROM public.ai_usage_mensual");
      expect(conteo).toBeGreaterThan(borrado);
      expect(sentencias[conteo]).toMatch(
        /SELECT tenant_id, public\.claimmix_mes_argentino\(created_at\), user_id, model, count\(\*\), sum\(prompt_tokens\), sum\(completion_tokens\), sum\(cost_usd\) FROM public\.ai_usage GROUP BY 1, 2, 3, 4$/
      );
    });

    it("el backfill va después del trigger: nada que se escriba entre uno y otro se pierde", () => {
      expect(posicion("CREATE TRIGGER trg_ai_usage_mensual")).toBeLessThan(posicion("DELETE FROM public.ai_usage_mensual"));
    });
  });

  describe("lo que no hace", () => {
    it("sólo escribe en el acumulador: nunca en ai_usage ni en otra tabla", () => {
      const destinos = [
        ...plano.matchAll(/\bINSERT\s+INTO\s+([\w.]+)/gi),
        ...plano.matchAll(/\bDELETE\s+FROM\s+([\w.]+)/gi),
        ...plano.matchAll(/\bUPDATE\s+([\w.]+)\s+SET\b/gi),
      ].map((m) => m[1]);

      expect(destinos.length).toBeGreaterThan(0);
      for (const d of destinos) expect(d).toBe("public.ai_usage_mensual");
    });

    it("no vacía, no borra tablas ni copia datos, y no usa CONCURRENTLY", () => {
      expect(plano.replace(/REVOKE[^;]*;/gi, "")).not.toMatch(/\bTRUNCATE\b/i);
      expect(plano).not.toMatch(/\b(DROP\s+(TABLE|COLUMN|INDEX|POLICY|CONSTRAINT|FUNCTION)|COPY|CONCURRENTLY)\b/i);
    });
  });

  it("cada sentencia se puede repetir", () => {
    for (const s of sentencias) {
      const repetible =
        /^CREATE TABLE IF NOT EXISTS /.test(s) ||
        /^CREATE OR REPLACE FUNCTION /.test(s) ||
        /^DO \$\$ BEGIN IF (NOT )?EXISTS /.test(s) ||
        /^ALTER TABLE \S+ (ENABLE|FORCE) ROW LEVEL SECURITY$/.test(s) ||
        /^REVOKE EXECUTE ON FUNCTION /.test(s) ||
        s === "LOCK TABLE public.ai_usage IN SHARE ROW EXCLUSIVE MODE" ||
        /^DROP TRIGGER IF EXISTS /.test(s) ||
        /^CREATE TRIGGER trg_ai_usage_mensual /.test(s) || // va pegado al DROP TRIGGER IF EXISTS
        s === "DELETE FROM public.ai_usage_mensual" ||
        /^INSERT INTO public\.ai_usage_mensual .* GROUP BY 1, 2, 3, 4$/.test(s) || // viene después del DELETE
        /^COMMENT ON /.test(s);
      expect(repetible, s.slice(0, 80)).toBe(true);
    }
  });
});
