-- =============================================================================
-- Migration 0003: Seed required_docs_config
-- =============================================================================
-- This is a config/reference table. Not user data. No RLS.
-- Required documents per claim type for gap-analysis logic.
-- =============================================================================

INSERT INTO public.required_docs_config (claim_type, doc_key, label_es, required) VALUES
  -- choque (collision)
  ('choque', 'parte_amistoso',   'Parte de accidente amistoso',        true),
  ('choque', 'fotos_danos',      'Fotografías de los daños',           true),
  ('choque', 'licencia_conducir','Licencia de conducir del asegurado', true),

  -- robo (theft)
  ('robo',   'denuncia_policial','Denuncia policial',                  true),
  ('robo',   'fotos_lugar',      'Fotografías del lugar del hecho',    true),

  -- granizo (hail)
  ('granizo','foto_oblea_vtv',   'Fotografía de la oblea VTV',         true),
  ('granizo','fotos_danos',      'Fotografías de los daños por granizo',true),

  -- incendio (fire)
  ('incendio','informe_bomberos','Informe de bomberos',                true),
  ('incendio','fotos_danos',     'Fotografías de los daños por incendio',true),
  ('incendio','denuncia_policial','Denuncia policial (si aplica)',      true)

ON CONFLICT (claim_type, doc_key) DO UPDATE
  SET label_es = EXCLUDED.label_es,
      required = EXCLUDED.required;
