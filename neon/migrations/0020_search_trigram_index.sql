-- =============================================================================
-- 0020 — Que la búsqueda del tablero deje de recorrer la tabla entera
-- =============================================================================
--
-- La búsqueda del tablero es una subcadena, no una palabra:
--
--     where policyholder_name ilike '%gonzalez%'
--        or policy_number     ilike '%gonzalez%'
--
-- Con el comodín adelante ningún índice btree sirve — el índice está ordenado
-- por el principio del texto, y acá el principio es desconocido. Postgres
-- recorre la tabla entera y descarta fila por fila.
--
-- Con 460 casos eso tarda 0,2 ms y no molesta. Medido en el ensayo con 200.000:
--
--     sin índice    97 ms   Seq Scan
--     con índice     5 ms   Bitmap Index Scan
--
-- Dieciocho veces, y el planificador lo usa de verdad — que es la parte que hay
-- que comprobar, porque un índice que el planificador ignora cuesta disco y
-- escrituras a cambio de nada. Se reproduce con `pnpm busqueda`.
--
-- `pg_trgm` parte el texto en grupos de tres caracteres e indexa esos grupos,
-- así que puede encontrar una subcadena sin saber dónde empieza. Un índice GIN
-- por columna, y Postgres los combina con BitmapOr para resolver el `or`.
--
-- Por qué GIN y no full-text (`tsvector`): la búsqueda por texto completo busca
-- PALABRAS, y acá se busca subcadena. Alguien que escribe "gonzal" tiene que
-- encontrar "Gonzalez", y un índice de palabras no lo hace.
--
-- Sobre CONCURRENTLY: no se usa porque no corre dentro de una transacción y
-- estas migraciones se aplican como un bloque. Con la tabla en 460 filas el
-- índice se construye al instante. Si algún día se aplica sobre una tabla
-- grande y en uso, hay que sacarlo del bloque y correrlo aparte con
-- CONCURRENTLY, o la escritura queda bloqueada mientras se construye.
--
-- Es aditiva y reversible: no cambia datos ni políticas. Para deshacerla,
-- `drop index` de las dos y listo — la consulta vuelve a andar, más lenta.

CREATE EXTENSION IF NOT EXISTS pg_trgm;

CREATE INDEX IF NOT EXISTS idx_cases_policyholder_name_trgm
  ON cases USING gin (policyholder_name gin_trgm_ops);

CREATE INDEX IF NOT EXISTS idx_cases_policy_number_trgm
  ON cases USING gin (policy_number gin_trgm_ops);

-- Que no se aplique a medias sin avisar. Si la extensión no se pudo crear —en
-- algunos proveedores hace falta un permiso que el dueño de la base no tiene—
-- los índices de arriba fallan, pero conviene decirlo con un mensaje que se
-- entienda en vez de con el error de Postgres.
DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_extension WHERE extname = 'pg_trgm') THEN
    RAISE EXCEPTION
      'pg_trgm no quedó instalada. Sin ella los índices de búsqueda no existen '
      'y el tablero vuelve a recorrer la tabla entera. En Neon la crea el dueño '
      'de la base; en otro proveedor puede hacer falta pedirla.';
  END IF;

  IF NOT EXISTS (
    SELECT 1 FROM pg_indexes
    WHERE tablename = 'cases' AND indexname = 'idx_cases_policyholder_name_trgm'
  ) THEN
    RAISE EXCEPTION 'idx_cases_policyholder_name_trgm no se creó.';
  END IF;
END $$;
