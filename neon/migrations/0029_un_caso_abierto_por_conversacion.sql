-- =============================================================================
-- 0029 — Un caso recién abierto por conversación
-- =============================================================================
--
-- `createWhatsAppIntake` busca un caso abierto para ese teléfono y, si no hay,
-- crea uno. Son dos transacciones distintas, y en el medio hay una ventana:
--
--     mensaje A → busca → no hay → crea el caso 1
--     mensaje B → busca → no hay → crea el caso 2   ← los dos "no hay"
--
-- No hace falta nada raro. Alguien escribe "choqué" y manda la foto un segundo
-- después: Meta entrega los dos eventos en pedidos separados y no promete
-- orden. Dentro de UN pedido el bucle es secuencial y esto no pasa; entre dos
-- pedidos concurrentes, sí.
--
-- Lo que queda es una conversación partida en dos casos, y el agente le
-- contesta a la persona dos veces por el mismo choque — el lease de extracción
-- serializa las corridas de un caso, no las de dos.
--
-- ── Por qué el índice va sobre `recibido` y no sobre "abierto" ───────────────
--
-- La tentación es prohibir dos casos ABIERTOS por hilo. No se puede: el buscador
-- mira los tres estados abiertos DENTRO de una ventana de 7 días, y a propósito
-- deja que un mensaje muy posterior abra un caso nuevo. Un índice sobre los tres
-- estados prohibiría eso, y `now()` no entra en un predicado de índice.
--
-- `recibido` sí, porque es el estado con el que un caso NACE, y es el único que
-- las dos mitades de la carrera escriben. Y no se queda ahí: el barredor de
-- `reap-stuck` saca de `recibido` cualquier caso de más de 20 minutos, contra
-- una mediana de 8 segundos para salir solo. O sea que un `recibido` viejo
-- —el único caso donde este índice cambiaría una decisión del buscador— no
-- existe.
--
-- Medido contra producción antes de escribir esto: 0 casos en `recibido` de
-- WhatsApp, 0 hilos con más de un caso abierto, 0 duplicados que bloquearan la
-- creación del índice.
--
-- Acotado a WhatsApp a propósito. El correo tiene la misma forma de carrera y
-- otro camino de ingreso, que no sabe recuperarse de un choque de clave. Una
-- cosa por vez.
-- =============================================================================

CREATE UNIQUE INDEX IF NOT EXISTS idx_cases_un_recibido_por_hilo
  ON public.cases (tenant_id, channel, email_thread_id)
  WHERE status = 'recibido'
    AND channel IN ('whatsapp', 'whatsapp_sim')
    AND email_thread_id IS NOT NULL;
