/**
 * La 0049 se aplica a mano, en tres bases, y puede correr más de una vez. Trae una
 * sola cosa: la función con la que el inquilino conecta su número de WhatsApp por
 * código. Lo que se vigila es lo que la hace segura: SECURITY DEFINER con el
 * search_path fijo, el contexto tiene que ser el inquilino, la fila se bloquea
 * antes de escribir, el id de la plataforma no se asigna, y la función queda
 * cerrada a PUBLIC y abierta sólo para claimmix_app. No toca tenants ni inserta
 * números: el alta es de la 0048 y el panel del operador.
 */

import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";

import { describe, expect, it } from "vitest";

import { splitSqlStatements } from "../../scripts/lib/split-sql.mjs";

const CARPETA = join(process.cwd(), "neon/migrations");
const ARCHIVO = "0049_numero_por_codigo.sql";
const CRUDO = readFileSync(join(CARPETA, ARCHIVO), "utf8");
const SQL = CRUDO.split(/\r?\n/)
  .map((l) => l.replace(/--.*$/, ""))
  .join("\n");
const FIRMA = "public.claimmix_numero_automatico(uuid, uuid, text, text, text, text, inet)";

describe("migración 0049: número de WhatsApp por código", () => {
  it("es la única con el número 0049, y viene justo después de la 0048", () => {
    const archivos = readdirSync(CARPETA).filter((f) => f.endsWith(".sql"));

    expect(archivos.filter((f) => f.startsWith("0049_"))).toEqual([ARCHIVO]);
    expect(archivos.some((f) => f.startsWith("0048_"))).toBe(true);
  });

  it("nombra las tres bases en el orden en que se aplica", () => {
    const orden = ["ep-wispy-flower", "ep-proud-resonance", "STAGING_DATABASE_URL"].map((b) => CRUDO.indexOf(b));

    expect(orden.every((i) => i >= 0)).toBe(true);
    expect([...orden].sort((a, b) => a - b)).toEqual(orden);
  });

  it("trae escrita la vuelta atrás, que es soltar la función y olvidar su registro", () => {
    expect(CRUDO).toContain(`--   DROP FUNCTION IF EXISTS ${FIRMA};`);
    expect(CRUDO).toContain("--   node scripts/migrate.mjs --env <VAR> --forget 0049");
  });

  it("es una función, el REVOKE y el GRANT: nada más", () => {
    const sentencias = splitSqlStatements(SQL).map((s: string) => s.replace(/\s+/g, " ").trim());

    expect(sentencias.map((s: string) => s.split(" ").slice(0, 2).join(" "))).toEqual([
      "DO $$",
      "CREATE OR",
      "REVOKE ALL",
      "DO $$",
    ]);
  });

  it("es SECURITY DEFINER, con el search_path fijo y el contexto como único inquilino", () => {
    expect(SQL).toContain("SECURITY DEFINER");
    expect(SQL).toContain("SET search_path = pg_catalog, public");
    expect(SQL).toContain("ERRCODE = '42501'");
    expect(SQL).toContain("claimmix_current_tenant_id()");
  });

  it("serializa y bloquea la fila antes de escribirla", () => {
    expect(SQL).toContain("pg_advisory_xact_lock");
    expect(SQL).toContain("FOR UPDATE");
  });

  it("exige el rol dueño: la función escribe con sus privilegios", () => {
    expect(SQL).toContain("rolbypassrls");
  });

  it("queda cerrada a PUBLIC y abierta sólo para claimmix_app", () => {
    expect(SQL).toContain(`REVOKE ALL ON FUNCTION ${FIRMA} FROM PUBLIC`);
    expect(SQL).toContain("GRANT EXECUTE ON FUNCTION public.claimmix_numero_automatico");
    expect(SQL).toContain("TO claimmix_app");
  });

  it("no usa CONCURRENTLY ni borra, ni toca tenants, ni inserta números", () => {
    expect(SQL).not.toContain("CONCURRENTLY");
    expect(SQL).not.toContain("DROP ");
    expect(SQL).not.toContain("UPDATE public.tenants");
    expect(SQL).not.toContain("INSERT INTO public.whatsapp_numeros");
    expect(SQL).not.toMatch(/\b(DELETE|TRUNCATE|ALTER)\b/);
  });

  it("no agrega columnas: la retoma tras un corte se apoya en intentos_de_extraccion", () => {
    expect(CRUDO).not.toContain("extraccion_cortada");
    expect(SQL).not.toContain("ADD COLUMN");
  });

  it("nunca asigna el número de la plataforma ni conecta uno que no se agregó antes", () => {
    expect(SQL).toContain("p_phone_number_id = btrim(p_id_plataforma)");
    expect(SQL).toContain("p_paso = 'conectado' AND v_actual IS DISTINCT FROM p_phone_number_id");
  });

  it("'conectado' repetido con el mismo id contesta ok antes de rechazar por estado", () => {
    const repetido = "p_paso = 'conectado' AND v_estado = 'conectado' AND v_actual = p_phone_number_id";

    expect(SQL).toContain(repetido);
    expect(SQL.indexOf(repetido)).toBeLessThan(SQL.indexOf("v_estado <> 'pedido'"));
  });

  it("deja asiento de cada paso", () => {
    expect(SQL).toContain("'whatsapp.numero_agregado'");
    expect(SQL).toContain("'whatsapp.numero_conectado'");
  });
});
