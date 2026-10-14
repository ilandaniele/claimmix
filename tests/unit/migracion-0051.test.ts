/**
 * La 0051 se aplica a mano, en tres bases, y puede correr más de una vez. Trae la
 * tabla `whatsapp_wabas` (el vínculo de cada inquilino con su WABA, por Embedded
 * Signup o con su propia app de Meta) y la función `claimmix_waba_propia`, la única
 * puerta con la que la app la escribe. Lo que se vigila es lo que la hace segura:
 * SECURITY DEFINER con el search_path fijo, el contexto tiene que ser el inquilino,
 * las filas se bloquean antes de escribir, cada UPDATE lleva las transiciones
 * permitidas en el WHERE, ni la WABA, ni el número ni la app de la plataforma se
 * asignan, cada origen tiene sus columnas y ningún paso escribe sobre una fila del
 * otro, la tabla queda de sólo lectura para claimmix_app y el esquema de Drizzle
 * dice lo mismo que el SQL.
 */

import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";

import { getTableColumns } from "drizzle-orm";
import { describe, expect, it } from "vitest";

import {
  ESPEJADAS_DE_SOLO_LECTURA,
  TABLAS_DE_CONTROL,
  TABLAS_SOLO_DE_CONTROL,
  sentenciasDelRol,
  sentenciasPerfilCliente,
  sentenciasPerfilControl,
} from "../../scripts/lib/permisos-por-perfil.mjs";
import { PERMISOS_QUITADOS } from "../../scripts/lib/permisos-quitados.mjs";
import { splitSqlStatements } from "../../scripts/lib/split-sql.mjs";
import { AuditEvent } from "@/lib/audit/log";
import { whatsappWabas } from "@/lib/db/schema";
import { cifrar, cifrarConClave } from "@/lib/security/cifrado";
import { reconectando } from "@/server/alta/waba-resultados";

const CARPETA = join(process.cwd(), "neon/migrations");
const ARCHIVO = "0051_waba_propia.sql";
const CRUDO = readFileSync(join(CARPETA, ARCHIVO), "utf8");
const SQL = CRUDO.split(/\r?\n/)
  .map((l) => l.replace(/--.*$/, ""))
  .join("\n");
const PLANO = SQL.replace(/\s+/g, " ");
const FIRMA = "public.claimmix_waba_propia(uuid, uuid, text, jsonb, text, text, text, inet)";

const ESTADOS = ["armando", "cancelada", "vinculada", "suscripta", "falta_codigo", "falta_pin", "conectada", "falla", "revocada"];

/** Las columnas que sólo tiene la app propia y que valen NULL en Embedded Signup. */
const COLUMNAS_DE_LA_APP = [
  "app_id",
  "app_secreto_cifrado",
  "ruta_webhook",
  "webhook_app_verificado_en",
  "datos_app_en",
  "primer_mensaje_en",
  "primera_respuesta_en",
  "slug_legal",
  "razon_social",
  "cuit",
  "acuerdo_version",
  "recordatorio_en",
  "puede_enviar",
  "categoria_perfil",
];

/** Lo que la rama armando de `app_iniciar` deja en NULL al volver a armar una fila cancelada o revocada. */
const SE_VACIA_AL_VOLVER_A_ARMAR = [
  "app_id",
  "app_secreto_cifrado",
  "webhook_app_verificado_en",
  "datos_app_en",
  "primer_mensaje_en",
  "primera_respuesta_en",
  "recordatorio_en",
  "puede_enviar",
  "categoria_perfil",
  "waba_id",
  "business_id",
  "fb_user_id",
  "paso_cancelado",
  "falla",
  "pin_cifrado",
];

/** Los nombres de columna que declara el CREATE TABLE de `tabla` (las restricciones con nombre no cuentan). */
function columnasDelSql(tabla: string): string[] {
  const desde = SQL.indexOf(`CREATE TABLE IF NOT EXISTS public.${tabla} (`);
  const cuerpo = SQL.slice(desde, SQL.indexOf("\n);", desde));
  return cuerpo
    .split("\n")
    .map((l) => /^\s{2}(\w+) /.exec(l)?.[1])
    .filter((c): c is string => c !== undefined && c !== "CONSTRAINT");
}

/** Los literales de una lista `IN ('a', 'b')`. */
function literales(lista: string): string[] {
  return [...lista.matchAll(/'([^']+)'/g)].map((m) => m[1]);
}

/** Cada UPDATE de `tabla` dentro de la función, en una sola línea. */
function actualizaciones(tabla: string): string[] {
  // nosemgrep
  return [...PLANO.matchAll(new RegExp(`UPDATE public\\.${tabla} SET .*?;`, "g"))].map((m) => m[0]);
}

/** Los estados que deja pasar el WHERE de un UPDATE: la lista de `AND estado IN (...)`. */
function estadosDelWhere(update: string): string[] {
  const lista = /WHERE .*?estado IN \(([^)]*)\)/.exec(update)?.[1] ?? "";
  return literales(lista);
}

/** Los UPDATE de whatsapp_wabas cuyo SET empieza con `prefijo`, en el orden de la función. */
function actualizacionesQueEmpiezan(prefijo: string): string[] {
  return actualizaciones("whatsapp_wabas").filter((u) => u.startsWith(`UPDATE public.whatsapp_wabas SET ${prefijo}`));
}

/** El SET de un UPDATE, sin el WHERE. */
function soloElSet(update: string): string {
  return update.slice(0, update.indexOf(" WHERE "));
}

const PASOS_EN_ORDEN = [
  "iniciar",
  "cancelar",
  "vincular",
  "aceptar_numero",
  "estado",
  "conectar",
  "app_iniciar",
  "app_credenciales",
  "app_token",
  "desconectar",
] as const;

/** El texto de un paso de la función, de su rama hasta la siguiente. `desconectar` es el ELSE final. */
function bloque(paso: (typeof PASOS_EN_ORDEN)[number]): string {
  const marca = (p: string) => (p === "desconectar" ? "ELSE IF NOT v_hay_fila OR" : `p_paso = '${p}' THEN`);
  const desde = PLANO.indexOf(marca(paso));
  const siguiente = PASOS_EN_ORDEN[PASOS_EN_ORDEN.indexOf(paso) + 1];
  const hasta = siguiente ? PLANO.indexOf(marca(siguiente), desde) : PLANO.indexOf("IF v_evento IS NOT NULL THEN", desde);
  expect(desde).toBeGreaterThan(0);
  expect(hasta).toBeGreaterThan(desde);
  return PLANO.slice(desde, hasta);
}

describe("migración 0051: WABA propia", () => {
  it("es la única con el número 0051, y viene justo después de la 0050", () => {
    const archivos = readdirSync(CARPETA).filter((f) => f.endsWith(".sql"));

    expect(archivos.filter((f) => f.startsWith("0051_"))).toEqual([ARCHIVO]);
    expect(archivos.some((f) => f.startsWith("0050_"))).toBe(true);
  });

  it("nombra las tres bases en el orden en que se aplica", () => {
    const orden = ["ep-wispy-flower", "ep-proud-resonance", "STAGING_DATABASE_URL"].map((b) => CRUDO.indexOf(b));

    expect(orden.every((i) => i >= 0)).toBe(true);
    expect([...orden].sort((a, b) => a - b)).toEqual(orden);
  });

  it("trae escrita la vuelta atrás, que es soltar la función de ocho argumentos, la tabla y el registro", () => {
    expect(CRUDO).toContain(`--   DROP FUNCTION IF EXISTS ${FIRMA};`);
    expect(CRUDO).toContain("--   DROP TABLE IF EXISTS public.whatsapp_wabas;");
    expect(CRUDO).toContain("--   node scripts/migrate.mjs --env <VAR> --forget 0051");
  });

  it("es aditiva e idempotente: la tabla, sus índices, RLS, la función y los permisos", () => {
    const sentencias = splitSqlStatements(SQL).map((s: string) => s.replace(/\s+/g, " ").trim());

    expect(sentencias.map((s: string) => s.split(" ").slice(0, 2).join(" "))).toEqual([
      "DO $$",
      "CREATE TABLE",
      "CREATE UNIQUE",
      "CREATE INDEX",
      "CREATE UNIQUE",
      "CREATE UNIQUE",
      "CREATE UNIQUE",
      "ALTER TABLE",
      "ALTER TABLE",
      "DO $$",
      "CREATE OR",
      "REVOKE ALL",
      "REVOKE ALL",
      "DO $$",
    ]);
    expect(PLANO).not.toContain("CONCURRENTLY");
    expect(PLANO).not.toContain("DROP ");
    expect(PLANO).not.toMatch(/\b(DELETE FROM|ADD COLUMN)\b/);
    expect(PLANO.match(/CREATE (TABLE|INDEX|UNIQUE INDEX) IF NOT EXISTS/g)).toHaveLength(6);
  });

  it("exige el rol dueño: la función escribe con sus privilegios", () => {
    expect(SQL).toContain("rolbypassrls");
    expect(SQL.indexOf("rolbypassrls")).toBeLessThan(SQL.indexOf("CREATE TABLE"));
  });

  it("whatsapp_wabas: una fila por inquilino, se va con él, y los 9 estados", () => {
    expect(PLANO).toContain("tenant_id uuid PRIMARY KEY REFERENCES public.tenants(id) ON DELETE CASCADE");

    const checkEstado = /estado text NOT NULL CHECK \(estado IN \(([^)]*)\)\)/.exec(PLANO)?.[1] ?? "";
    expect(literales(checkEstado)).toEqual(ESTADOS);
    expect(whatsappWabas.estado.enumValues).toEqual(ESTADOS);
    expect(whatsappWabas.estado.enumValues[0]).toBe("armando");
  });

  it("whatsapp_wabas: cada id y cada texto de Meta tiene su forma", () => {
    expect(PLANO).toContain("falla text CHECK (falla ~ '^[a-z_]{1,40}$')");
    expect(PLANO).toContain("business_id text CHECK (business_id ~ '^[0-9]{6,20}$')");
    expect(PLANO).toContain("waba_id text CHECK (waba_id ~ '^[0-9]{6,20}$')");
    expect(PLANO).toContain("fb_user_id text CHECK (fb_user_id ~ '^[0-9]{1,30}$')");
    expect(PLANO).toContain("numero_meta text CHECK (numero_meta ~ '^\\+[1-9][0-9]{7,14}$')");
    expect(PLANO).toContain("nombre_estado text CHECK (nombre_estado ~ '^[A-Z_]{1,30}$')");
    expect(PLANO).toContain("numero_aceptado boolean NOT NULL DEFAULT false");
    expect(PLANO).toContain("intentos integer NOT NULL DEFAULT 0");
    expect(PLANO).toContain("pin_cifrado text,");

    const pasos = /paso_cancelado text CHECK \(paso_cancelado IN \(([^)]*)\)\)/.exec(PLANO)?.[1] ?? "";
    expect(literales(pasos)).toEqual(whatsappWabas.paso_cancelado.enumValues);
    expect(literales(pasos)).toHaveLength(7);
  });

  it("whatsapp_wabas: la app propia suma quince columnas con la forma de cada dato", () => {
    expect(PLANO).toContain("origen text NOT NULL DEFAULT 'embedded_signup' CHECK (origen IN ('embedded_signup', 'app_propia'))");
    expect(PLANO).toContain("app_id text CHECK (app_id ~ '^[0-9]{6,20}$')");
    expect(PLANO).toContain("app_secreto_cifrado text CHECK (length(app_secreto_cifrado) <= 512)");
    expect(PLANO).toContain("ruta_webhook text CHECK (ruta_webhook ~ '^[A-Za-z0-9_-]{22}$')");
    expect(PLANO).toContain("slug_legal text CHECK (slug_legal ~ '^[a-z0-9]{16}$')");
    expect(PLANO).toContain("razon_social text CHECK (char_length(razon_social) BETWEEN 1 AND 120)");
    expect(PLANO).toContain("cuit text CHECK (cuit ~ '^[0-9]{11}$')");
    expect(PLANO).toContain("acuerdo_version text CHECK (acuerdo_version ~ '^[0-9]{4}-[0-9]{2}$')");
    expect(PLANO).toContain("puede_enviar text CHECK (puede_enviar IN ('AVAILABLE', 'LIMITED', 'BLOCKED'))");
    expect(PLANO).toContain("categoria_perfil text CHECK (categoria_perfil ~ '^[A-Z_]{3,20}$')");
    for (const c of ["webhook_app_verificado_en", "datos_app_en", "primer_mensaje_en", "primera_respuesta_en", "recordatorio_en"]) {
      expect(PLANO).toContain(`${c} timestamptz,`);
    }
    // Ninguna se agrega con ALTER: la tabla nace así, y el test de idempotencia ya prohíbe ADD COLUMN.
    expect(columnasDelSql("whatsapp_wabas").slice(14, 29)).toEqual(["origen", ...COLUMNAS_DE_LA_APP]);
  });

  it("Drizzle: origen con su valor por omisión, la app propia opcional y los enum del SQL", () => {
    const columnas = new Map(Object.entries(getTableColumns(whatsappWabas)));

    expect(columnas.get("origen")?.notNull).toBe(true);
    expect(columnas.get("origen")?.default).toBe("embedded_signup");
    expect(whatsappWabas.origen.enumValues).toEqual(["embedded_signup", "app_propia"]);
    expect(whatsappWabas.puede_enviar.enumValues).toEqual(["AVAILABLE", "LIMITED", "BLOCKED"]);
    for (const c of COLUMNAS_DE_LA_APP) expect(columnas.get(c)?.notNull).toBe(false);
  });

  it("el origen manda: Embedded Signup no tiene nada de la app propia ni está armando, y la app propia viva trae sus datos", () => {
    const restriccion = /CONSTRAINT whatsapp_wabas_por_origen CHECK \(CASE origen WHEN 'embedded_signup' THEN (.*?) END\)/.exec(PLANO)?.[1] ?? "";
    const [embedded, propia] = restriccion.split(" ELSE ");

    expect(restriccion).not.toBe("");
    for (const c of COLUMNAS_DE_LA_APP) expect(embedded).toContain(`${c} IS NULL`);
    expect(embedded).toContain("estado <> 'armando'");

    // La app propia: sus datos legales y la ruta desde que arma; app y secreto desde que vincula; cancelada y revocada no piden nada.
    expect(propia).toContain(
      "(estado IN ('cancelada', 'revocada') OR (ruta_webhook IS NOT NULL AND razon_social IS NOT NULL AND cuit IS NOT NULL AND acuerdo_version IS NOT NULL))"
    );
    expect(propia).toContain(
      "(estado IN ('armando', 'cancelada', 'revocada') OR (app_id IS NOT NULL AND app_secreto_cifrado IS NOT NULL))"
    );
    // El operador puede despublicar las páginas legales en cualquier estado: el slug no es obligatorio (R3).
    expect(propia).not.toContain("slug_legal");
  });

  it("una WABA es de un solo inquilino vivo: revocada y cancelada la sueltan", () => {
    expect(PLANO).toContain(
      "CREATE UNIQUE INDEX IF NOT EXISTS whatsapp_wabas_waba_viva ON public.whatsapp_wabas (waba_id) " +
        "WHERE waba_id IS NOT NULL AND estado NOT IN ('revocada', 'cancelada')"
    );
    expect(PLANO).toContain("ON public.whatsapp_wabas (fb_user_id) WHERE fb_user_id IS NOT NULL");
  });

  it("una app de Meta es de un solo inquilino vivo; la ruta y el slug no se repiten nunca", () => {
    expect(PLANO).toContain(
      "CREATE UNIQUE INDEX IF NOT EXISTS whatsapp_wabas_app_viva ON public.whatsapp_wabas (app_id) " +
        "WHERE app_id IS NOT NULL AND estado NOT IN ('revocada', 'cancelada')"
    );
    expect(PLANO).toContain(
      "CREATE UNIQUE INDEX IF NOT EXISTS whatsapp_wabas_ruta ON public.whatsapp_wabas (ruta_webhook) WHERE ruta_webhook IS NOT NULL"
    );
    expect(PLANO).toContain(
      "CREATE UNIQUE INDEX IF NOT EXISTS whatsapp_wabas_slug_legal ON public.whatsapp_wabas (slug_legal) WHERE slug_legal IS NOT NULL"
    );
  });

  it("RLS forzada y la política de siempre, creada una sola vez", () => {
    expect(PLANO).toContain("ALTER TABLE public.whatsapp_wabas ENABLE ROW LEVEL SECURITY");
    expect(PLANO).toContain("ALTER TABLE public.whatsapp_wabas FORCE ROW LEVEL SECURITY");
    expect(PLANO).toContain("policyname = 'claimmix_tenant_isolation'");
    expect(PLANO).toContain(
      "CREATE POLICY claimmix_tenant_isolation ON public.whatsapp_wabas " +
        "USING (public.claimmix_tenant_matches(tenant_id)) WITH CHECK (public.claimmix_tenant_matches(tenant_id))"
    );
  });

  it("la tabla queda cerrada a PUBLIC y de sólo lectura para claimmix_app; sin el rol sólo avisa", () => {
    expect(PLANO).toContain("REVOKE ALL ON TABLE public.whatsapp_wabas FROM PUBLIC");
    expect(PLANO).toContain("rolname = 'claimmix_app'");
    expect(PLANO).toContain("REVOKE INSERT, UPDATE, DELETE, TRUNCATE ON public.whatsapp_wabas FROM claimmix_app");
    expect(PLANO).toContain("GRANT SELECT ON public.whatsapp_wabas TO claimmix_app");
    expect(PLANO).toContain("RAISE NOTICE");
  });

  it("la función es SECURITY DEFINER, con el search_path fijo y el contexto como único inquilino", () => {
    expect(SQL).toContain(`CREATE OR REPLACE FUNCTION public.claimmix_waba_propia(`);
    expect(SQL).toContain("SECURITY DEFINER");
    expect(SQL).toContain("SET search_path = pg_catalog, public");
    expect(SQL).toContain("ERRCODE = '42501'");
    expect(PLANO).toContain("p_tenant_id IS DISTINCT FROM public.claimmix_current_tenant_id()");
    expect(PLANO).toContain("p_ip inet DEFAULT NULL ) RETURNS jsonb");
  });

  it("la firma tiene ocho argumentos, con la app de la plataforma antes de la IP, y no queda ninguna de siete", () => {
    expect(PLANO).toContain(
      "claimmix_waba_propia( p_tenant_id uuid, p_user_id uuid, p_paso text, p_datos jsonb, p_waba_plataforma text, " +
        "p_id_plataforma text, p_app_plataforma text, p_ip inet DEFAULT NULL )"
    );
    expect(PLANO.match(/CREATE OR REPLACE FUNCTION/g)).toHaveLength(1);
    // Con la firma vieja, CREATE OR REPLACE dejaría una sobrecarga al lado y las dos con permisos de la app.
    expect(CRUDO).not.toContain("uuid, uuid, text, jsonb, text, text, inet");
  });

  it("la función queda cerrada a PUBLIC y abierta sólo para claimmix_app", () => {
    expect(SQL).toContain(`REVOKE ALL ON FUNCTION ${FIRMA} FROM PUBLIC`);
    expect(SQL).toContain(`GRANT EXECUTE ON FUNCTION ${FIRMA} TO claimmix_app`);
  });

  it("serializa con el flujo viejo (mismo candado que la 0049) y bloquea las dos filas antes de escribir", () => {
    expect(PLANO).toContain("pg_advisory_xact_lock(hashtext('claimmix_numero'))");
    expect(PLANO.match(/FOR UPDATE/g)).toHaveLength(2);
    expect(PLANO.indexOf("pg_advisory_xact_lock")).toBeLessThan(PLANO.indexOf("FOR UPDATE"));
    expect(PLANO.indexOf("FOR UPDATE")).toBeLessThan(PLANO.indexOf("INSERT INTO public.whatsapp_wabas"));
  });

  it("sólo el inquilino del alta automática, owner o admin, con prueba vigente o plan activo", () => {
    expect(PLANO).toContain("t.id = p_tenant_id AND t.autoalta");
    expect(PLANO).toContain("t.billing_status IN ('trial', 'active')");
    expect(PLANO).toContain("t.billing_status <> 'trial' OR t.trial_ends_at IS NULL OR t.trial_ends_at > now()");
    expect(PLANO).toContain("u.id = p_user_id AND u.tenant_id = p_tenant_id AND u.role IN ('owner', 'admin')");
  });

  it("desconectar no pide plan vigente: un cliente con la prueba vencida también borra su token", () => {
    expect(PLANO).toContain("p_paso = 'desconectar' OR ( t.billing_status IN ('trial', 'active')");
  });

  it("los diez pasos son los únicos que acepta", () => {
    const pasos = /p_paso NOT IN \(([^)]*)\)/.exec(PLANO)?.[1] ?? "";

    expect(literales(pasos)).toEqual([
      "iniciar",
      "cancelar",
      "vincular",
      "aceptar_numero",
      "estado",
      "conectar",
      "desconectar",
      "app_iniciar",
      "app_credenciales",
      "app_token",
    ]);
    expect(PLANO).toContain("jsonb_typeof(v_datos) <> 'object'");
    // Cada paso tiene su rama, y desconectar es el ELSE final.
    for (const p of PASOS_EN_ORDEN.filter((x) => x !== "desconectar")) expect(PLANO).toContain(`p_paso = '${p}' THEN`);
  });

  it("contesta con los trece resultados del plano y ninguno más", () => {
    const usados = new Set([...PLANO.matchAll(/jsonb_build_object\('resultado', '(\w+)'/g)].map((m) => m[1]));

    expect([...usados].sort()).toEqual(
      [
        "apagado",
        "app_ocupada",
        "cupo",
        "datos_invalidos",
        "de_la_plataforma",
        "id_ocupado",
        "no_aplica",
        "numero_ocupado",
        "ok",
        "otra_app",
        "transicion",
        "webhook_pendiente",
        "ya_conectado",
      ].sort()
    );
  });

  it("nunca guarda un token en claro: sólo el sobre iv.tag.ct de base64url, acotado", () => {
    expect(PLANO).toContain("'^[A-Za-z0-9_-]+[.][A-Za-z0-9_-]+[.][A-Za-z0-9_-]+$'");
    expect(PLANO).toContain("coalesce(v_token, '') !~ c_sobre OR char_length(v_token) > 4096");
    expect(PLANO).toContain("coalesce(v_pin, '') !~ c_sobre OR char_length(v_pin) > 4096");
    expect(PLANO).toContain("v_pin IS NOT NULL AND (v_pin !~ c_sobre OR char_length(v_pin) > 4096)");
  });

  it("el App Secret sólo entra como sobre v2 (v2.<kid>.<iv>.<tag>.<ct>), acotado a 512, y el de verdad lo cumple", () => {
    const SOBRE_V2 = /^v2[.][a-z0-9]{1,16}[.][A-Za-z0-9_-]+[.][A-Za-z0-9_-]+[.][A-Za-z0-9_-]+$/;
    const SOBRE_V1 = /^[A-Za-z0-9_-]+[.][A-Za-z0-9_-]+[.][A-Za-z0-9_-]+$/;
    const antes = { wa1: process.env.WHATSAPP_APP_SECRETS_KEY, gmail: process.env.GMAIL_TOKEN_ENCRYPTION_KEY };
    process.env.WHATSAPP_APP_SECRETS_KEY = "test-wa1-key";
    process.env.GMAIL_TOKEN_ENCRYPTION_KEY = "test-gmail-key";
    try {
      expect(PLANO).toContain(`c_sobre_secreto CONSTANT text := '${SOBRE_V2.source}'`);
      expect(PLANO).toContain("coalesce(v_secreto, '') !~ c_sobre_secreto OR char_length(v_secreto) > 512");

      const secreto = "fake-" + "a".repeat(27);
      const largo = cifrarConClave("wa1", "fake-" + "b".repeat(200), "tenant-1:app-1");
      const v2 = cifrarConClave("wa1", secreto, "tenant-1:app-1");
      expect(v2).toMatch(SOBRE_V2);
      expect(v2.length).toBeLessThan(512);
      expect(largo).toMatch(SOBRE_V2);

      // Un token o un PIN (v1) no pasa por secreto, y un secreto v2 no pasa por token ni por PIN.
      expect(cifrar("fake-token")).not.toMatch(SOBRE_V2);
      expect(v2).not.toMatch(SOBRE_V1);
    } finally {
      if (antes.wa1 === undefined) delete process.env.WHATSAPP_APP_SECRETS_KEY;
      else process.env.WHATSAPP_APP_SECRETS_KEY = antes.wa1;
      if (antes.gmail === undefined) delete process.env.GMAIL_TOKEN_ENCRYPTION_KEY;
      else process.env.GMAIL_TOKEN_ENCRYPTION_KEY = antes.gmail;
    }
  });

  it("nunca asigna la WABA, el número ni la app de la plataforma, ni sale a desconectar la de la plataforma", () => {
    expect(PLANO).toContain("IF v_phone = v_id_plat OR v_waba = v_waba_plat THEN RETURN jsonb_build_object('resultado', 'de_la_plataforma')");
    expect(PLANO).toContain(
      "IF v_phone = v_id_plat OR (v_hay_fila AND v_fila.waba_id = v_waba_plat) THEN RETURN jsonb_build_object('resultado', 'de_la_plataforma')"
    );
    expect(PLANO).toContain(
      "IF v_fila.waba_id = v_waba_plat THEN RETURN jsonb_build_object('resultado', 'de_la_plataforma')"
    );
    expect(PLANO).toContain("IF v_app_id = v_app_plat THEN RETURN jsonb_build_object('resultado', 'de_la_plataforma')");
    expect(PLANO.match(/'de_la_plataforma'/g)).toHaveLength(4);
    expect(PLANO).toContain("v_id_plat IS NULL");
  });

  it("id_ocupado: otro inquilino vivo, la cuarentena de 30 días de la baja y la WABA de otra fila viva", () => {
    expect(PLANO).toContain("q.phone_number_id = v_phone AND q.tenant_id <> p_tenant_id");
    expect(PLANO).toContain("q.estado <> 'baja' OR q.actualizado_en > now() - make_interval(days => 30)");
    expect(PLANO).toContain("o.waba_id = v_waba AND o.tenant_id <> p_tenant_id AND o.estado NOT IN ('revocada', 'cancelada')");
  });

  it("numero_ocupado compara el E.164 sin el 9 de los móviles argentinos, como el índice de la 0048", () => {
    expect(PLANO).toContain("regexp_replace(o.numero_e164, '^[+]549', '+54') = regexp_replace(v_meta, '^[+]549', '+54')");
    expect(PLANO).toContain(
      "regexp_replace(o.numero_e164, '^[+]549', '+54') = regexp_replace(v_fila.numero_meta, '^[+]549', '+54')"
    );
    expect(PLANO).toContain("regexp_replace(o.numero_e164, '^[+]549', '+54') = regexp_replace(v_numero, '^[+]549', '+54')");
  });

  it("cupo semanal: cuenta portfolios distintos de los últimos 7 días en todos los inquilinos", () => {
    expect(PLANO.match(/count\(DISTINCT w\.business_id\)/g)).toHaveLength(2);
    expect(PLANO.match(/w\.vinculada_en > now\(\) - interval '7 days'/g)).toHaveLength(4);
    expect(PLANO.match(/'cupo', 'usadas', v_usadas, 'tope', v_tope/g)).toHaveLength(2);
  });

  it("cupo semanal en iniciar: quien ya entró esta semana puede volver a abrir el popup, como en vincular", () => {
    const iniciar = bloque("iniciar");

    expect(iniciar).toContain(
      "IF v_usadas >= v_tope AND NOT EXISTS ( SELECT 1 FROM public.whatsapp_wabas w " +
        "WHERE w.tenant_id = p_tenant_id AND w.vinculada_en > now() - interval '7 days' ) THEN"
    );
  });

  it("cupo semanal en vincular: sólo para una WABA nueva de Embedded Signup y sólo si el portfolio no entró ya esta semana", () => {
    const desde = PLANO.indexOf("IF NOT v_app AND v_fila.waba_id IS DISTINCT FROM v_waba THEN SELECT count(DISTINCT");
    const cupo = PLANO.slice(desde, PLANO.indexOf("IF v_limpiar THEN", desde));

    expect(desde).toBeGreaterThan(0);
    expect(cupo).toContain("v_usadas >= v_tope AND NOT EXISTS");
    expect(cupo).toContain("w.business_id = v_business");
    expect(PLANO).toContain("coalesce(v_datos->>'tope', '') !~ '^[0-9]{1,4}$'");
    // La app propia no tiene cupo ni tope: el tope sólo se lee para Embedded Signup.
    expect(bloque("vincular")).toContain("IF NOT v_app THEN v_tope := (v_datos->>'tope')::integer");
  });

  it("iniciar y aceptar_numero no tocan nada que no sea suyo; iniciar no escribe", () => {
    const iniciar = bloque("iniciar");

    expect(iniciar).not.toMatch(/\b(INSERT|UPDATE)\b/);
    expect(actualizaciones("whatsapp_wabas").some((u) => u.startsWith("UPDATE public.whatsapp_wabas SET numero_aceptado = true"))).toBe(true);
  });

  it("la fila manda: una app propia viva no abre el popup de Embedded Signup", () => {
    expect(PLANO).toContain(
      "v_app := v_hay_fila AND v_fila.origen = 'app_propia' AND v_fila.estado NOT IN ('cancelada', 'revocada')"
    );
    expect(PLANO).toContain(
      "v_limpiar := v_hay_fila AND v_fila.origen = 'app_propia' AND v_fila.estado IN ('cancelada', 'revocada')"
    );
    expect(PLANO.indexOf("v_app := v_hay_fila")).toBeGreaterThan(PLANO.indexOf("FOR UPDATE"));
    expect(PLANO.indexOf("v_limpiar := v_hay_fila")).toBeLessThan(PLANO.indexOf("IF p_paso = 'iniciar' THEN"));
    expect(bloque("iniciar")).toContain("IF v_app THEN RETURN jsonb_build_object('resultado', 'transicion')");
  });

  it("todo UPDATE lleva en el WHERE el inquilino y los estados de los que sale", () => {
    const wabas = actualizaciones("whatsapp_wabas");
    const numeros = actualizaciones("whatsapp_numeros");

    expect(wabas).toHaveLength(13);
    expect(numeros).toHaveLength(5);
    for (const u of wabas) expect(u).toMatch(/WHERE tenant_id = p_tenant_id AND estado IN \(/);
    for (const u of numeros) expect(u).toMatch(/WHERE id = v_numero_id AND estado IN \(/);
  });

  it("transiciones de whatsapp_wabas: cada paso sale sólo de los estados del plano", () => {
    const unico = (prefijo: string) => {
      const encontrados = actualizacionesQueEmpiezan(prefijo);
      expect(encontrados).toHaveLength(1);
      return encontrados[0];
    };

    // cancelar: la app propia sólo mientras se arma; Embedded Signup como siempre.
    expect(estadosDelWhere(unico("estado = 'cancelada', falla = NULL, paso_cancelado = v_paso_cancelado, app_secreto_cifrado"))).toEqual(["armando"]);
    expect(estadosDelWhere(unico("estado = 'cancelada', falla = NULL, paso_cancelado = v_paso_cancelado, actualizado_en"))).toEqual(["cancelada", "falla"]);
    // vincular: ahora también desde armando (la app propia).
    expect(estadosDelWhere(unico("estado = 'vinculada'"))).toEqual([
      "armando",
      "cancelada",
      "falla",
      "vinculada",
      "suscripta",
      "falta_codigo",
      "falta_pin",
      "revocada",
    ]);
    expect(estadosDelWhere(unico("numero_aceptado = true"))).toEqual(["vinculada", "suscripta", "falta_codigo", "falta_pin", "falla"]);
    expect(estadosDelWhere(unico("estado = v_estado_nuevo"))).toEqual([
      "cancelada",
      "vinculada",
      "suscripta",
      "falta_codigo",
      "falta_pin",
      "falla",
      "conectada",
    ]);
    // conectar es el que deja la fila en conectada; app_token también, salvo que el número siga pedido (ver más abajo).
    const aConectada = actualizacionesQueEmpiezan("estado = 'conectada'");
    expect(aConectada).toHaveLength(1);
    expect(estadosDelWhere(aConectada[0])).toEqual(["suscripta", "falta_codigo", "falta_pin"]);
    expect(estadosDelWhere(unico("estado = CASE WHEN v_numero_estado = 'pedido'"))).toEqual(["conectada", "falla"]);
    expect(estadosDelWhere(unico("estado = 'revocada'"))).toEqual([
      "cancelada",
      "vinculada",
      "suscripta",
      "falta_codigo",
      "falta_pin",
      "conectada",
      "falla",
    ]);
    // app_iniciar: retomar el armado o volver a armar una cancelada o revocada, del origen que sea.
    expect(estadosDelWhere(unico("razon_social = v_razon"))).toEqual(["armando"]);
    expect(estadosDelWhere(unico("estado = 'armando'"))).toEqual(["cancelada", "revocada"]);
    // app_credenciales: armando (cualquier app) y todo lo vinculado (la misma app).
    expect(estadosDelWhere(unico("app_id = v_app_id"))).toEqual([
      "armando",
      "vinculada",
      "suscripta",
      "falta_codigo",
      "falta_pin",
      "conectada",
      "falla",
    ]);
  });

  it("los estados que nombra cada UPDATE existen en el CHECK de la tabla", () => {
    for (const u of actualizaciones("whatsapp_wabas")) {
      for (const e of estadosDelWhere(u)) expect(ESTADOS).toContain(e);
    }
  });

  it("revocada es final: sólo salen de ella vincular y app_iniciar (volver a conectar o a armar) y los que sueltan la app muerta", () => {
    const salen = actualizaciones("whatsapp_wabas").filter((u) => estadosDelWhere(u).includes("revocada"));
    const permitidos = ["estado = 'vinculada'", "estado = 'armando'", "origen = 'embedded_signup'"];

    expect(salen).toHaveLength(4);
    for (const u of salen) {
      expect(permitidos.some((p) => u.startsWith(`UPDATE public.whatsapp_wabas SET ${p}`))).toBe(true);
    }
  });

  it("ningún UPDATE de whatsapp_wabas toca el token: va sólo en whatsapp_numeros", () => {
    for (const u of actualizaciones("whatsapp_wabas")) expect(u).not.toContain("token_cifrado");
    expect(PLANO).not.toMatch(/INSERT INTO public\.whatsapp_wabas \([^)]*token_cifrado/);
  });

  it("estado: el destino sólo puede ser suscripta, falta_codigo, falta_pin, falla o refrescar conectada", () => {
    const destinos = /v_estado_nuevo NOT IN \(([^)]*)\)/.exec(PLANO)?.[1] ?? "";

    expect(literales(destinos)).toEqual(["suscripta", "falta_codigo", "falta_pin", "falla", "conectada"]);
    expect(PLANO).toContain("WHEN 'conectada' THEN v_hay_fila AND v_fila.estado = 'conectada'");
    expect(PLANO).toContain("(v_estado_nuevo = 'falla' AND coalesce(v_falla, '') NOT IN (");
    expect(PLANO).toContain("(v_estado_nuevo <> 'falla' AND v_falla IS NOT NULL)");
  });

  it("estado: la falla sólo puede ser una de las trece del plano", () => {
    const lista = /coalesce\(v_falla, ''\) NOT IN \(([^)]*)\)/.exec(PLANO)?.[1] ?? "";

    expect(literales(lista)).toEqual([
      "canje",
      "token_invalido",
      "suscripcion",
      "registro",
      "webhook",
      "token_vencido",
      "nombre_rechazado",
      "coexistencia",
      "sin_numero",
      "secreto_invalido",
      "waba_restringida",
      "waba_bloqueada",
      "pago_pendiente",
    ]);
  });

  it("estado con falla puede nacer sin fila: el canje falla antes del primer vincular", () => {
    expect(PLANO).toContain("WHEN 'falla' THEN NOT v_hay_fila OR v_fila.estado IN (");
    expect(PLANO).toContain("INSERT INTO public.whatsapp_wabas (tenant_id, estado, falla) VALUES (p_tenant_id, 'falla', v_falla)");
  });

  it("estado: una conectada puede caer en falla o en falta_pin; los otros destinos no salen de ella", () => {
    // `registrarConNombreAprobado` vuelve a registrar el número con la fila ya conectada: si Graph lo rechaza,
    // la falla o el PIN que falta tienen que quedar anotados y no perderse como «transicion».
    const permitido = /v_permitido := CASE v_estado_nuevo (.*?) END;/.exec(PLANO)?.[1] ?? "";
    const rama = (destino: string) => new RegExp(`WHEN '${destino}' THEN (.*?)(?= WHEN | ELSE |$)`).exec(permitido)?.[1] ?? "";
    const desde = (destino: string) => literales(/estado IN \(([^)]*)\)/.exec(rama(destino))?.[1] ?? "");

    expect(desde("falla")).toContain("conectada");
    expect(desde("falta_pin")).toContain("conectada");
    // El ELSE (suscripta y falta_codigo) no sale de conectada: sería reabrir un alta que ya terminó.
    expect(/ELSE (.*)$/.exec(permitido)?.[1]).not.toContain("conectada");
  });

  it("estado no pisa con NULL lo que ya hay: PIN, nombre y fecha de la plantilla se conservan", () => {
    expect(PLANO).toContain("pin_cifrado = coalesce(v_pin, pin_cifrado)");
    expect(PLANO).toContain("nombre_estado = coalesce(v_nombre, nombre_estado)");
    expect(PLANO).toContain("plantilla_enviada_en = coalesce(v_plantilla, plantilla_enviada_en)");
  });

  it("vincular: rechaza si ya hay un número conectado o suspendido, y cuenta un intento más", () => {
    expect(PLANO).toContain("IF v_numero_estado IN ('conectado', 'suspendido') OR (v_hay_fila AND v_fila.estado = 'conectada') THEN");
    expect(PLANO).toContain("intentos = intentos + 1");
    expect(PLANO).toContain("numero_aceptado = false");
  });

  it("vincular: renueva vinculada_en sólo con una WABA nueva y conserva la plantilla si es la misma", () => {
    expect(PLANO).toContain(
      "vinculada_en = CASE WHEN vinculada_en IS NULL OR waba_id IS DISTINCT FROM v_waba THEN now() ELSE vinculada_en END"
    );
    expect(PLANO).toContain(
      "plantilla_enviada_en = CASE WHEN waba_id IS NOT DISTINCT FROM v_waba THEN plantilla_enviada_en END"
    );
  });

  it("vincular: completa el pedido o lo crea con el número de Meta; un conectado sólo se toca al volver a conectar", () => {
    expect(PLANO).toContain(
      "UPDATE public.whatsapp_numeros SET phone_number_id = v_phone, waba_id = v_waba, token_cifrado = v_token, actualizado_en = now() " +
        "WHERE id = v_numero_id AND estado IN ('pedido', 'conectado')"
    );
    expect(PLANO).toContain(
      "INSERT INTO public.whatsapp_numeros (tenant_id, numero_e164, phone_number_id, waba_id, token_cifrado) " +
        "VALUES (p_tenant_id, v_meta, v_phone, v_waba, v_token)"
    );
  });

  it("vincular con una app propia: sin portfolio, usuario de Facebook ni cupo, y sólo con su app y su secreto guardados", () => {
    const vincular = bloque("vincular");

    // Una llamada con forma de Embedded Signup sobre una app propia viva no escribe nada.
    expect(vincular).toContain(
      "IF v_app AND coalesce(v_business, v_fb, v_datos->>'tope') IS NOT NULL THEN RETURN jsonb_build_object('resultado', 'transicion')"
    );
    expect(vincular).toContain(
      "(NOT v_app AND (coalesce(v_business, '') !~ '^[0-9]{6,20}$' OR coalesce(v_datos->>'tope', '') !~ '^[0-9]{1,4}$'))"
    );
    expect(vincular).toContain(
      "IF v_fila.estado = 'armando' AND (v_fila.app_id IS NULL OR v_fila.app_secreto_cifrado IS NULL) THEN RETURN jsonb_build_object('resultado', 'transicion')"
    );
    expect(vincular).toContain(
      "IF v_hay_fila AND v_fila.estado NOT IN ('armando', 'cancelada', 'falla', 'vinculada', 'suscripta', 'falta_codigo', 'falta_pin', 'revocada') THEN"
    );
    expect(vincular).toContain("'via', CASE WHEN v_app THEN 'app_propia' ELSE 'embedded_signup' END");
  });

  it("vincular guarda el rubro del perfil sólo de una app propia, con la forma de Meta, y no lo pisa si no llega", () => {
    const vincular = bloque("vincular");

    expect(vincular).toContain("v_categoria := v_datos->>'categoria_perfil'");
    expect(vincular).toContain("OR (v_categoria IS NOT NULL AND (NOT v_app OR v_categoria !~ '^[A-Z_]{3,20}$'))");
    expect(vincular).toContain("categoria_perfil = CASE WHEN v_app THEN coalesce(v_categoria, categoria_perfil) END");
    // Embedded Signup no lleva rubro, y una fila que vuelve a armarse lo suelta como el resto de lo que era de la app.
    expect(PLANO).toContain("puede_enviar IS NULL AND categoria_perfil IS NULL");
  });

  it("vincular y estado sueltan los datos de una app propia muerta antes de escribirle como Embedded Signup", () => {
    const resets = actualizaciones("whatsapp_wabas").filter((u) => u.startsWith("UPDATE public.whatsapp_wabas SET origen = 'embedded_signup'"));

    expect(resets).toHaveLength(2);
    expect(resets[0]).toBe(resets[1]);
    expect(estadosDelWhere(resets[0])).toEqual(["cancelada", "revocada"]);
    expect(resets[0]).toContain("AND origen = 'app_propia'");
    for (const c of COLUMNAS_DE_LA_APP) expect(soloElSet(resets[0])).toContain(`${c} = NULL`);
    // No cambia el estado: lo hace el UPDATE que sigue, ya con la fila de Embedded Signup.
    expect(soloElSet(resets[0])).not.toMatch(/\bestado =/);

    for (const paso of ["vincular", "estado"] as const) {
      const rama = bloque(paso);
      const reset = rama.indexOf("IF v_limpiar THEN UPDATE public.whatsapp_wabas SET origen = 'embedded_signup'");

      expect(reset).toBeGreaterThan(0);
      // Después de la última validación: un reset seguido de un RETURN quedaría escrito, porque la función no revierte.
      expect(rama.lastIndexOf("RETURN jsonb_build_object(")).toBeLessThan(reset);
    }
  });

  it("conectar: sólo el pedido de este vínculo, con el id dado, la misma WABA y token propio", () => {
    expect(PLANO).toContain("v_numero_estado <> 'pedido'");
    expect(PLANO).toContain("v_numero_phone IS DISTINCT FROM v_phone");
    expect(PLANO).toContain("v_numero_waba IS DISTINCT FROM v_fila.waba_id");
    expect(PLANO).toContain("NOT v_numero_con_token");
  });

  it("conectar: el número de Meta tiene que ser el pedido (sin el 9) o estar aceptado", () => {
    expect(PLANO).toContain(
      "v_fila.numero_meta IS NULL OR ( NOT v_fila.numero_aceptado AND " +
        "regexp_replace(v_fila.numero_meta, '^[+]549', '+54') <> regexp_replace(v_numero_e164, '^[+]549', '+54') )"
    );
    expect(PLANO).toContain("SET numero_e164 = v_fila.numero_meta, estado = 'conectado', conectado_en = now()");
  });

  it("conectar una app propia exige el callback verificado, después de saber que está en un estado que conecta", () => {
    const conectar = bloque("conectar");
    const pendiente =
      "IF v_fila.origen = 'app_propia' AND v_fila.webhook_app_verificado_en IS NULL THEN RETURN jsonb_build_object('resultado', 'webhook_pendiente')";

    expect(conectar).toContain(pendiente);
    expect(conectar.indexOf("IF v_fila.estado NOT IN ('suscripta', 'falta_codigo', 'falta_pin')")).toBeLessThan(conectar.indexOf(pendiente));
    expect(conectar.indexOf(pendiente)).toBeLessThan(conectar.indexOf("IF v_numero_id IS NULL"));
    expect(conectar).toContain("'via', CASE WHEN v_app THEN 'app_propia' ELSE 'embedded_signup' END, 'phone_number_id', v_phone");
  });

  it("el número propio es el conectado, con token y de la WABA de la fila: lo que separa volver a conectar de «ya conectado»", () => {
    expect(PLANO).toContain(
      "v_propio := v_hay_fila AND v_fila.waba_id IS NOT NULL AND v_numero_waba = v_fila.waba_id " +
        "AND v_numero_estado = 'conectado' AND coalesce(v_numero_con_token, false)"
    );
    expect(PLANO.indexOf("v_propio :=")).toBeGreaterThan(PLANO.indexOf("FOR UPDATE"));
    expect(PLANO.indexOf("v_propio :=")).toBeLessThan(PLANO.indexOf("IF p_paso = 'iniciar' THEN"));
  });

  it("vincular de una WABA caída o a medias con el número vivo (lo que `reconectando` dice en TS): sólo la misma WABA con el mismo número, el resto «ya_conectado» o «no_aplica»", () => {
    const gate = "IF v_numero_estado IN ('conectado', 'suspendido') OR (v_hay_fila AND v_fila.estado = 'conectada') THEN";
    const desde = PLANO.indexOf(gate);
    const bloqueDelGate = PLANO.slice(desde, PLANO.indexOf("IF v_hay_fila AND v_fila.estado NOT IN", desde));

    expect(desde).toBeGreaterThan(0);
    expect(bloqueDelGate).toContain(
      "IF NOT (v_hay_fila AND v_fila.estado IN ('falla', 'vinculada', 'suscripta', 'falta_codigo', 'falta_pin') AND v_propio) " +
        "THEN RETURN jsonb_build_object('resultado', 'ya_conectado')"
    );
    expect(bloqueDelGate).toContain(
      "IF v_waba IS DISTINCT FROM v_fila.waba_id OR v_phone IS DISTINCT FROM v_numero_phone THEN RETURN jsonb_build_object('resultado', 'no_aplica')"
    );
  });

  it("los estados que `vincular` deja volver a pasar son exactamente los que `reconectando` (TS) llama reconectando: si no, el código de Meta se gasta y la base contesta «ya_conectado»", () => {
    const lista = /v_fila\.estado IN \(([^)]*)\) AND v_propio\) THEN RETURN jsonb_build_object\('resultado', 'ya_conectado'\)/.exec(PLANO)?.[1] ?? "";
    const sql = literales(lista).sort();
    const ts = ESTADOS.filter((estado) => reconectando({ estado, numero: "conectado", conToken: true })).sort();

    expect(sql.length).toBeGreaterThan(0);
    expect(sql).toEqual(ts);
  });

  it("cancelar con la WABA en falla y el número vivo no escribe: cerrar el popup no desconecta a nadie", () => {
    const viva = "ELSIF v_fila.estado = 'falla' AND v_propio THEN NULL;";
    const resto = "ELSIF v_fila.estado IN ('cancelada', 'falla') THEN";

    expect(PLANO).toContain(viva);
    expect(PLANO.indexOf(viva)).toBeLessThan(PLANO.indexOf(resto));
  });

  it("cancelar una app propia: sólo armando; suelta el secreto y la ruta y conserva la razón social, el CUIT y el slug", () => {
    const cancelar = bloque("cancelar");
    const armando = cancelar.indexOf("ELSIF v_fila.estado = 'armando' THEN UPDATE");
    const propiaViva = cancelar.indexOf("ELSIF v_app THEN RETURN jsonb_build_object('resultado', 'transicion')");
    const [update] = actualizacionesQueEmpiezan("estado = 'cancelada', falla = NULL, paso_cancelado = v_paso_cancelado, app_secreto_cifrado");

    // armando va antes que la app viva, y las dos antes que las ramas de Embedded Signup.
    expect(armando).toBeGreaterThan(0);
    expect(armando).toBeLessThan(propiaViva);
    expect(propiaViva).toBeLessThan(cancelar.indexOf("ELSIF v_fila.estado = 'falla' AND v_propio"));
    for (const c of ["app_secreto_cifrado", "ruta_webhook", "webhook_app_verificado_en"]) expect(soloElSet(update)).toContain(`${c} = NULL`);
    for (const c of ["slug_legal", "razon_social", "cuit", "app_id"]) expect(soloElSet(update)).not.toContain(c);
  });

  it("conectar con el número vivo sólo levanta la WABA y lo asienta como reconexión", () => {
    expect(PLANO).toContain("OR (v_numero_estado <> 'pedido' AND NOT v_propio)");
    expect(PLANO).toContain("IF v_propio THEN v_carga := v_carga || jsonb_build_object('reconexion', true)");
  });

  it("conectar repetido con el mismo id contesta ok antes de rechazar por estado", () => {
    const repetido = "v_fila.estado = 'conectada' AND v_numero_estado = 'conectado' AND v_numero_phone = v_phone";
    const rechazo = "IF v_fila.estado NOT IN ('suscripta', 'falta_codigo', 'falta_pin')";

    expect(PLANO).toContain(repetido);
    expect(PLANO.indexOf(repetido)).toBeLessThan(PLANO.indexOf(rechazo));
  });

  it("desconectar: borra token y PIN, sólo da de baja el número que creó este vínculo, y no sale de revocada", () => {
    expect(PLANO).toContain("SET estado = 'baja', token_cifrado = NULL, actualizado_en = now()");
    expect(PLANO).toContain("v_numero_id IS NOT NULL AND v_fila.waba_id IS NOT NULL AND v_numero_waba = v_fila.waba_id");
    expect(PLANO).toContain("SET estado = 'revocada', falla = NULL, pin_cifrado = NULL");
    expect(PLANO).toContain("IF NOT v_hay_fila OR v_fila.estado NOT IN ('cancelada', 'vinculada', 'suscripta', 'falta_codigo', 'falta_pin', 'conectada', 'falla')");
  });

  it("desconectar también suelta el secreto, la ruta y la verificación; app_id, datos_app_en y el slug quedan", () => {
    const [update] = actualizacionesQueEmpiezan("estado = 'revocada'");

    for (const c of ["app_secreto_cifrado", "ruta_webhook", "webhook_app_verificado_en"]) expect(soloElSet(update)).toContain(`${c} = NULL`);
    for (const c of ["app_id", "datos_app_en", "slug_legal", "razon_social", "cuit"]) expect(soloElSet(update)).not.toContain(c);
  });

  it("sin el App ID de la plataforma no hay app propia: los tres pasos contestan «apagado» antes del candado y sin escribir (S1)", () => {
    const apagado =
      "IF p_paso IN ('app_iniciar', 'app_credenciales', 'app_token') AND v_app_plat IS NULL THEN RETURN jsonb_build_object('resultado', 'apagado')";
    const desde = PLANO.indexOf("CREATE OR REPLACE FUNCTION");

    expect(PLANO).toContain(apagado);
    expect(PLANO).toContain("v_app_plat text := nullif(btrim(coalesce(p_app_plataforma, '')), '')");
    expect(PLANO.indexOf(apagado)).toBeLessThan(PLANO.indexOf("pg_advisory_xact_lock"));
    expect(PLANO.slice(desde, PLANO.indexOf(apagado))).not.toMatch(/\b(INSERT|UPDATE)\b/);
    // Es el único uso de la app de la plataforma como puerta: los otros pasos no dependen de ella.
    expect(PLANO.match(/v_app_plat IS NULL/g)).toHaveLength(1);
  });

  it("app_iniciar: valida lo que llega, no pisa un número conectado y sólo sale de armando, cancelada o revocada", () => {
    const rama = bloque("app_iniciar");

    expect(rama).toContain("coalesce(v_ruta, '') !~ '^[A-Za-z0-9_-]{22}$'");
    expect(rama).toContain("coalesce(v_slug, '') !~ '^[a-z0-9]{16}$'");
    expect(rama).toContain("char_length(coalesce(v_razon, '')) NOT BETWEEN 1 AND 120");
    expect(rama).toContain("coalesce(v_cuit, '') !~ '^[0-9]{11}$'");
    expect(rama).toContain("coalesce(v_acuerdo, '') !~ '^[0-9]{4}-[0-9]{2}$'");
    expect(rama).toContain("v_numero IS NOT NULL AND v_numero !~ '^\\+[1-9][0-9]{7,14}$'");
    expect(rama).toContain("v_razon := btrim(v_datos->>'razon_social')");

    const yaConectado = "IF v_numero_estado IN ('conectado', 'suspendido') THEN RETURN jsonb_build_object('resultado', 'ya_conectado')";
    const transicion =
      "IF v_hay_fila AND v_fila.estado NOT IN ('armando', 'cancelada', 'revocada') THEN RETURN jsonb_build_object('resultado', 'transicion')";
    const ocupado = "RETURN jsonb_build_object('resultado', 'numero_ocupado')";

    expect(rama).toContain(yaConectado);
    expect(rama).toContain(transicion);
    expect(rama.indexOf(yaConectado)).toBeLessThan(rama.indexOf(transicion));
    expect(rama.indexOf(transicion)).toBeLessThan(rama.indexOf(ocupado));
    expect(rama.indexOf(ocupado)).toBeLessThan(rama.indexOf("INSERT INTO public.whatsapp_wabas"));
  });

  it("app_iniciar: sin fila crea la fila armando; retomar no cambia la ruta ni el slug", () => {
    const rama = bloque("app_iniciar");
    const [retomar] = actualizacionesQueEmpiezan("razon_social = v_razon");

    expect(rama).toContain(
      "INSERT INTO public.whatsapp_wabas (tenant_id, estado, origen, ruta_webhook, slug_legal, razon_social, cuit, acuerdo_version) " +
        "VALUES (p_tenant_id, 'armando', 'app_propia', v_ruta, v_slug, v_razon, v_cuit, v_acuerdo)"
    );
    expect(soloElSet(retomar)).toBe(
      "UPDATE public.whatsapp_wabas SET razon_social = v_razon, cuit = v_cuit, acuerdo_version = v_acuerdo, actualizado_en = now()"
    );
  });

  it("app_iniciar desde cancelada o revocada de cualquier origen: arma de cero, reusa el slug y deja la app y el vínculo vacíos", () => {
    const [volver] = actualizacionesQueEmpiezan("estado = 'armando'");

    expect(soloElSet(volver)).toContain("origen = 'app_propia'");
    expect(soloElSet(volver)).toContain("ruta_webhook = v_ruta");
    // Con el slug del cliente, la app que ya tiene en Meta sigue apuntando a sus páginas legales; sin slug (despublicado) nace uno.
    expect(soloElSet(volver)).toContain("slug_legal = coalesce(slug_legal, v_slug)");
    for (const c of SE_VACIA_AL_VOLVER_A_ARMAR) expect(soloElSet(volver)).toContain(`${c} = NULL`);
    expect(soloElSet(volver)).toContain("numero_aceptado = false");
  });

  it("app_iniciar y el número: actualiza el pedido sin id de Meta, crea uno si no hay fila viva y deja el asiento del acuerdo", () => {
    const rama = bloque("app_iniciar");

    expect(rama).toContain("IF v_numero IS NOT NULL THEN IF v_numero_id IS NULL THEN INSERT INTO public.whatsapp_numeros (tenant_id, numero_e164) VALUES (p_tenant_id, v_numero)");
    expect(rama).toContain("ELSIF v_numero_phone IS NULL THEN UPDATE public.whatsapp_numeros SET numero_e164 = v_numero, actualizado_en = now() WHERE id = v_numero_id AND estado IN ('pedido')");
    expect(rama).toContain("v_evento := 'whatsapp.app_acuerdo'");
    expect(rama).toContain("v_objetivo := 'whatsapp_waba'");
    expect(rama).toContain("v_objetivo_id := p_tenant_id::text");
    expect(rama).toContain("v_carga := jsonb_build_object('acuerdo', v_acuerdo)");
  });

  it("app_credenciales: valida la app, el sobre del secreto y la ruta, y rechaza la app de la plataforma antes que cualquier otra cosa", () => {
    const rama = bloque("app_credenciales");

    expect(rama).toContain(
      "IF coalesce(v_app_id, '') !~ '^[0-9]{6,20}$' OR coalesce(v_secreto, '') !~ c_sobre_secreto OR char_length(v_secreto) > 512 " +
        "OR coalesce(v_ruta, '') !~ '^[A-Za-z0-9_-]{22}$' " +
        "OR (v_datos->'datos_app' IS NOT NULL AND jsonb_typeof(v_datos->'datos_app') <> 'boolean') THEN RETURN jsonb_build_object('resultado', 'datos_invalidos')"
    );
    // Ausente (modo actualizar) queda NULL y la columna no se toca.
    expect(rama).toContain("v_datos_app := (v_datos->>'datos_app')::boolean");

    const orden = [
      "IF v_app_id = v_app_plat THEN",
      "IF NOT v_app THEN RETURN jsonb_build_object('resultado', 'transicion')",
      "IF v_fila.estado <> 'armando' AND v_fila.app_id IS DISTINCT FROM v_app_id THEN RETURN jsonb_build_object('resultado', 'otra_app')",
      "o.app_id = v_app_id AND o.tenant_id <> p_tenant_id AND o.estado NOT IN ('revocada', 'cancelada')",
      "UPDATE public.whatsapp_wabas SET app_id = v_app_id",
    ].map((m) => rama.indexOf(m));

    expect(orden.every((i) => i >= 0)).toBe(true);
    expect([...orden].sort((a, b) => a - b)).toEqual(orden);
    expect(rama).toContain("'app_ocupada'");
  });

  it("app_credenciales: datos_app verdadero marca la fecha, falso la borra y ausente la deja", () => {
    const [update] = actualizacionesQueEmpiezan("app_id = v_app_id");

    expect(update).toContain(
      "datos_app_en = CASE WHEN v_datos_app THEN now() WHEN v_datos_app IS FALSE OR v_cambia THEN NULL ELSE datos_app_en END"
    );
  });

  it("app_credenciales en armando: otra app rota la ruta y borra la verificación; la misma app solo cambia el secreto (S5)", () => {
    const rama = bloque("app_credenciales");
    const [update] = actualizacionesQueEmpiezan("app_id = v_app_id");

    expect(rama).toContain("v_cambia := v_fila.estado = 'armando' AND v_fila.app_id IS DISTINCT FROM v_app_id");
    expect(update).toContain("ruta_webhook = CASE WHEN v_cambia THEN v_ruta ELSE ruta_webhook END");
    expect(update).toContain("webhook_app_verificado_en = CASE WHEN v_cambia THEN NULL ELSE webhook_app_verificado_en END");
    expect(rama).toContain("v_que := CASE WHEN v_cambia THEN 'app' ELSE 'secreto' END");
    expect(rama).toContain("v_evento := 'whatsapp.app_credenciales'");
    expect(rama).toContain("v_objetivo_id := coalesce(v_fila.waba_id, p_tenant_id::text)");
    expect(rama).toContain("v_carga := jsonb_build_object('que', v_que)");
  });

  it("app_credenciales con el secreto inválido y el número conectado devuelve la fila a conectada", () => {
    const [update] = actualizacionesQueEmpiezan("app_id = v_app_id");
    const condicion = "estado = 'falla' AND falla = 'secreto_invalido' AND v_numero_estado = 'conectado'";

    expect(update).toContain(`estado = CASE WHEN ${condicion} THEN 'conectada'`);
    expect(update).toContain("falla = CASE WHEN estado = 'falla' AND falla = 'secreto_invalido' AND v_numero_estado IN ('conectado', 'pedido') THEN NULL ELSE falla END");
  });

  it("app_credenciales con el secreto inválido caído armando el alta (número pedido) devuelve la fila a vinculada, no la deja en falla", () => {
    const [update] = actualizacionesQueEmpiezan("app_id = v_app_id");

    expect(update).toContain("WHEN estado = 'falla' AND falla = 'secreto_invalido' AND v_numero_estado = 'pedido' THEN 'vinculada' ELSE estado END");
  });

  it("app_token: sólo conectada o falla por token vencido, sólo el token del número de esta WABA, y vuelve a conectada (a vinculada si el número sigue pedido)", () => {
    const rama = bloque("app_token");
    const [update] = actualizacionesQueEmpiezan(
      "estado = CASE WHEN v_numero_estado = 'pedido' THEN 'vinculada' ELSE 'conectada' END, falla = NULL, actualizado_en = now() WHERE tenant_id = p_tenant_id AND estado IN ('conectada', 'falla')"
    );

    expect(rama).toContain("coalesce(v_token, '') !~ c_sobre OR char_length(v_token) > 4096");
    expect(rama).toContain(
      "IF NOT v_app OR NOT (v_fila.estado = 'conectada' OR (v_fila.estado = 'falla' AND v_fila.falla = 'token_vencido')) THEN RETURN jsonb_build_object('resultado', 'transicion')"
    );
    expect(rama).toContain(
      "IF v_numero_id IS NULL OR NOT (v_numero_estado IN ('conectado', 'suspendido') OR (v_numero_estado = 'pedido' AND v_fila.estado = 'falla')) OR v_numero_waba IS DISTINCT FROM v_fila.waba_id THEN RETURN jsonb_build_object('resultado', 'no_aplica')"
    );
    expect(rama).toContain(
      "UPDATE public.whatsapp_numeros SET token_cifrado = v_token, actualizado_en = now() WHERE id = v_numero_id AND estado IN ('conectado', 'suspendido', 'pedido')"
    );
    expect(update).toContain("AND (estado = 'conectada' OR falla = 'token_vencido')");
    expect(rama).toContain("v_carga := jsonb_build_object('que', 'token')");
    expect(rama).not.toContain("INSERT");
  });

  it("deja asiento de vincular, conectar, desconectar y de la app propia, con los tipos del catálogo de auditoría", () => {
    expect(PLANO).toContain("INSERT INTO public.audit_log (tenant_id, actor_id, event_type, target_type, target_id, payload, ip)");
    expect(PLANO).toContain("v_evento := 'whatsapp.waba_vinculada'");
    expect(PLANO).toContain("v_evento := 'whatsapp.numero_conectado'");
    expect(PLANO).toContain("CASE WHEN v_baja THEN 'whatsapp.numero_baja' ELSE 'whatsapp.waba_revocada' END");
    expect(PLANO).toContain("v_evento := 'whatsapp.app_acuerdo'");
    expect(PLANO).toContain("v_evento := 'whatsapp.app_credenciales'");

    expect(AuditEvent.WHATSAPP_WABA_VINCULADA).toBe("whatsapp.waba_vinculada");
    expect(AuditEvent.WHATSAPP_WABA_REVOCADA).toBe("whatsapp.waba_revocada");
    expect(AuditEvent.META_BORRADO_DE_DATOS).toBe("meta.borrado_de_datos");
    expect(AuditEvent.WHATSAPP_NUMERO_CONECTADO).toBe("whatsapp.numero_conectado");
    expect(AuditEvent.WHATSAPP_NUMERO_BAJA).toBe("whatsapp.numero_baja");
    expect(AuditEvent.WHATSAPP_APP_ACUERDO).toBe("whatsapp.app_acuerdo");
    expect(AuditEvent.WHATSAPP_APP_CREDENCIALES).toBe("whatsapp.app_credenciales");
    expect(AuditEvent.WHATSAPP_APP_LEGALES_DESPUBLICADAS).toBe("whatsapp.app_legales_despublicadas");
  });

  it("el asiento nunca lleva un secreto: sólo la versión del acuerdo, qué se cambió o el id de la WABA", () => {
    const cargas = [...PLANO.matchAll(/v_carga := jsonb_build_object\(([^;]*?)\);/g)].map((m) => m[1]);

    expect(cargas.length).toBeGreaterThanOrEqual(6);
    for (const c of cargas) expect(c).not.toMatch(/v_token|v_pin|v_secreto|secreto_cifrado|token_cifrado|pin_cifrado/);
  });

  it("whatsapp_numeros no gana ninguna columna ni se borra una fila", () => {
    expect(PLANO).not.toMatch(/ALTER TABLE public\.whatsapp_numeros/);
    expect(PLANO).not.toContain("DELETE FROM");
  });

  it("el esquema de Drizzle dice lo mismo que el SQL, columna por columna y en el mismo orden", () => {
    expect(Object.keys(getTableColumns(whatsappWabas))).toEqual(columnasDelSql("whatsapp_wabas"));
    expect(columnasDelSql("whatsapp_wabas")).not.toContain("CONSTRAINT");
  });

  it("pnpm permisos exige que la app no pueda escribir la tabla, y sí leerla", () => {
    expect(PERMISOS_QUITADOS.whatsapp_wabas).toEqual(["INSERT", "UPDATE", "DELETE"]);
  });

  it("whatsapp_wabas es de control y sólo de control: la base del cliente ni la lee", () => {
    expect(TABLAS_DE_CONTROL).toContain("whatsapp_wabas");
    expect(TABLAS_SOLO_DE_CONTROL).toContain("whatsapp_wabas");
    expect(ESPEJADAS_DE_SOLO_LECTURA).not.toContain("whatsapp_wabas");
    expect(TABLAS_DE_CONTROL.indexOf("whatsapp_wabas")).toBe(TABLAS_DE_CONTROL.indexOf("whatsapp_numeros") + 1);
  });

  it("los perfiles del rol: la función llega por EXECUTE ON ALL FUNCTIONS, la tabla pierde la escritura, y en el cliente todo", () => {
    const delRol = sentenciasDelRol();
    const quitaEscritura = delRol.find((s: string) => s.includes('public."whatsapp_wabas"'));

    expect(delRol.some((s: string) => s.includes("GRANT EXECUTE ON ALL FUNCTIONS IN SCHEMA public"))).toBe(true);
    expect(quitaEscritura).toContain("REVOKE INSERT, UPDATE, DELETE");
    expect(quitaEscritura).not.toContain("SELECT");
    expect(sentenciasPerfilCliente()).toContain(
      `DO $$ BEGIN IF to_regclass('public."whatsapp_wabas"') IS NOT NULL THEN REVOKE ALL ON public."whatsapp_wabas" FROM claimmix_app; END IF; END $$`
    );
    expect(sentenciasPerfilControl()).toContain("'whatsapp_wabas'");
  });
});
