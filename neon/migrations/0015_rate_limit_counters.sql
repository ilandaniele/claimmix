-- Un limitador de intentos que sobreviva a la instancia que lo cuenta.
--
-- El limitador vivía en la memoria del proceso, y en serverless cada instancia
-- tiene la suya. El propio módulo lo decía como una limitación aceptable para
-- el MVP; la prueba de carga mostró por qué no lo es. Cien pedidos simultáneos
-- al webhook los atendió Vercel levantando instancias, y cada instancia
-- empieza a contar de cero.
--
-- O sea: el límite de cinco intentos de login por IP se multiplica por la
-- cantidad de instancias, y esa cantidad la decide el atacante mandando más
-- pedidos en paralelo. El control se debilita exactamente cuando lo atacan.
--
-- Esto lo mueve a la base, que es la única cosa que las instancias comparten.
-- Es una ventana fija y no deslizante: en el peor caso, justo en el borde entre
-- dos ventanas, deja pasar hasta el doble del límite. A cambio es una sola
-- sentencia atómica en vez de leer-contar-escribir, que con varias instancias
-- compitiendo es una carrera. Para frenar fuerza bruta, el doble del límite en
-- un instante sigue siendo cuatro órdenes de magnitud menos que un diccionario.

CREATE TABLE IF NOT EXISTS public.rate_limit_counters (
  bucket_key   text        NOT NULL,
  window_start timestamptz NOT NULL,
  hits         integer     NOT NULL DEFAULT 0,
  PRIMARY KEY (bucket_key, window_start)
);

-- Para el barrido: borrar por ventana vieja no puede recorrer la tabla entera,
-- porque cuando la tabla está grande es justo cuando hay que barrerla.
CREATE INDEX IF NOT EXISTS idx_rate_limit_counters_window
  ON public.rate_limit_counters (window_start);

COMMENT ON TABLE public.rate_limit_counters IS
  'Contadores de ventana fija para el limitador de intentos, compartidos entre instancias. Las filas se borran solas en el cron diario; una fila huérfana no significa nada más que un intento viejo.';
