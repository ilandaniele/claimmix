-- 0021 — los cuatro tipos de siniestro que el código conocía y la base no.
--
-- `required_docs_config` se sembró en la 0001 con cuatro tipos: choque, robo,
-- granizo e incendio. Desde entonces el código sumó cuatro más —cristales, rc,
-- robo_contenido y accidente_personal— con su checklist en
-- `src/core/case/required-docs.ts`, y nadie escribió la migración que los
-- pusiera acá.
--
-- El síntoma no era un error, que es lo que lo hizo durar: `seedRequiredDocs`
-- consulta esta tabla y, si no encuentra filas para el tipo, se vuelve sin
-- hacer nada (`if (configured.length === 0) return;`). O sea que el agente
-- pedía bien los papeles —eso sale del archivo, no de acá— pero el caso no
-- registraba un solo documento pendiente. En la pantalla del analista esos
-- siniestros se veían completos.
--
-- Hoy hay 45 casos en producción de estos cuatro tipos, ninguno con
-- seguimiento de documentación.
--
-- Las filas de abajo son copia literal de REQUIRED_DOCS_CONFIG. Si divergen,
-- `pnpm docs-config` lo dice: ese chequeo se agregó junto con esta migración,
-- porque el problema real no fueron las filas que faltaban sino que nada
-- comparaba las dos listas.

INSERT INTO public.required_docs_config (claim_type, doc_key, label_es, required) VALUES
  -- cristales — la denuncia sólo aplica si hubo vandalismo, no en un impacto
  -- de piedra en la ruta. Es la única fila opcional de toda la tabla.
  ('cristales',          'fotos_danos',       'Fotos del vidrio dañado',              true),
  ('cristales',          'denuncia_policial', 'Denuncia policial (si aplica)',        false),

  -- rc (responsabilidad civil) — el daño es a un tercero, así que hace falta
  -- respaldo policial además de las fotos.
  ('rc',                 'fotos_danos',       'Fotos de los daños a tercero',         true),
  ('rc',                 'denuncia_policial', 'Denuncia policial o acta policial',    true),
  ('rc',                 'licencia_conducir', 'Licencia de conducir',                 true),

  -- robo_contenido — lo que se llevaron de adentro del vehículo.
  ('robo_contenido',     'denuncia_policial', 'Denuncia policial',                    true),
  ('robo_contenido',     'fotos_danos',       'Fotos del interior del vehículo',      true),

  -- accidente_personal — hay una persona lastimada; el caso se deriva a un
  -- especialista por severidad, y esta fila es para que el certificado quede
  -- registrado como pendiente mientras tanto.
  ('accidente_personal', 'certificado_medico','Certificado médico / alta hospitalaria', true)

ON CONFLICT (claim_type, doc_key) DO UPDATE
  SET label_es = EXCLUDED.label_es,
      required = EXCLUDED.required;
