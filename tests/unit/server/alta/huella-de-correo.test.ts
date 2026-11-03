/**
 * `huellaDeCorreo`: la misma expresión arma la huella al borrar y al aceptar la
 * invitación; si la normalización de una punta se corriera, el enlace viejo
 * volvería a valer.
 */
import { sql } from "drizzle-orm";
import { PgDialect } from "drizzle-orm/pg-core";
import { describe, expect, it } from "vitest";

import { huellaDeCorreo } from "@/server/alta/huella-de-correo";

const ESPACIO = "aaaaaaaa-0000-4000-8000-00000000000a";

describe("huellaDeCorreo", () => {
  it("es el sha256 en hexa de «espacio:dirección», con la dirección sin espacios y en minúsculas", () => {
    const { sql: texto, params } = new PgDialect().sqlToQuery(huellaDeCorreo(ESPACIO, sql`u.email`));

    expect(texto).toBe(
      "encode(sha256(convert_to($1::text || ':' || lower(btrim(u.email)), 'utf8')), 'hex')"
    );
    expect(params).toEqual([ESPACIO]);
  });

  it("acepta un parámetro como dirección: la misma forma de los dos lados", () => {
    const columna = new PgDialect().sqlToQuery(huellaDeCorreo(ESPACIO, sql`b.email`));
    const parametro = new PgDialect().sqlToQuery(huellaDeCorreo(ESPACIO, sql`${"Lucia@Example.com"}::text`));

    expect(parametro.sql).toBe(columna.sql.replace("b.email", "$2::text"));
    expect(parametro.params).toEqual([ESPACIO, "Lucia@Example.com"]);
  });
});
