-- =============================================================================
-- 0026 — Los mensajes que fallaron se vuelven a leer
-- =============================================================================
--
-- El poller de Gmail avanza la marca de agua SIEMPRE, incluso cuando todos los
-- mensajes de la tanda fallaron (`const shouldAdvance = true;`). Y hace bien en
-- avanzar: si se quedara clavado, un mensaje que falla para siempre bloquearía
-- la casilla entera y ningún correo nuevo entraría nunca. Es el bucle de
-- veneno, y el arreglo ingenuo (`errors === 0`) lo reintroduce.
--
-- El problema es lo que pasaba con el mensaje que fallo: nada. Quedaba su id
-- escrito en `last_error` y ningún camino lo volvía a mirar. El cron diario
-- llama al mismo `pollGmail`, que arranca desde la marca ya avanzada; sólo
-- relee con `messages.list(newer_than:1d)` si el historyId venció con un 404 o
-- en la primera corrida. O sea que si el que falló era una denuncia, esa
-- persona escribió y nadie la iba a leer nunca.
--
-- Esta columna es la tercera salida, la que no estaba: la marca sigue
-- avanzando —no hay bucle de veneno— y el mensaje que falló queda anotado para
-- reintentarlo en la corrida siguiente, con un tope de intentos para que uno
-- roto de verdad no se reintente para siempre.
--
-- Forma:  [{ "id": "18f...", "intentos": 2, "visto": "2026-09-09T10:00:00Z" }]
--
-- Va en jsonb y no en una tabla propia porque es estado del poller, uno por
-- casilla, efímero y acotado: se vacía solo a medida que los mensajes entran, y
-- el tope de intentos le pone techo al tamaño.
-- =============================================================================

ALTER TABLE public.gmail_poll_state
  ADD COLUMN IF NOT EXISTS mensajes_pendientes jsonb NOT NULL DEFAULT '[]'::jsonb;

COMMENT ON COLUMN public.gmail_poll_state.mensajes_pendientes IS
  'Mensajes que fallaron y hay que reintentar: [{id, intentos, visto}]. La marca de agua avanza igual; esto es lo que evita perderlos.';
