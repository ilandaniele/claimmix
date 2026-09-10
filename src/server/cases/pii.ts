/**
 * Qué le sale a cada rol de lo que escribió el denunciante.
 *
 * `/api/customers` y `/api/policies` exigen `CUSTOMER_PII_ROLES` con el
 * comentario «un analista NO entra: acá salen DNI, correo y teléfono». Esa es
 * la frontera declarada, y se esquiva por las rutas del caso, que devuelven el
 * mensaje ENTERO —con el DNI, el teléfono y la póliza adentro— a `...ALL_ROLES`.
 *
 * Las dos funciones de acá viven juntas porque hacen lo mismo con distinto
 * corte, y ese corte es lo único que hay que leer para entender la frontera:
 *
 *   · La corrida del agente se enmascara para todo el que no esté en
 *     `CUSTOMER_PII_ROLES`. Un analista no la necesita: es el registro de lo que
 *     hizo el modelo, no la pantalla donde se trabaja el siniestro.
 *
 *   · La conversación se enmascara SOLO para `viewer`. Enmascarársela a un
 *     analista sería teatro: el DNI y el número de póliza que se taparían en el
 *     cuerpo del mensaje están, en la misma pantalla, en el panel de campos
 *     extraídos y en la fila del caso. Tapar una copia y mostrar la otra no es
 *     una frontera, es ruido — y le saca al analista lo único que necesita leer
 *     para atender la denuncia.
 *
 * Enmascarar y no esconder: `redactString` tapa el DNI, la póliza y la patente
 * y deja el texto legible, así que quien lee sigue entendiendo qué pasó. La
 * dirección sí se oculta entera, porque no hace falta para leer nada.
 */

import "server-only";

import { redactString } from "@/lib/audit/redact";
import { CUSTOMER_PII_ROLES, type UserRole } from "@/lib/auth/roles";

/** Lo que se ve en lugar de una dirección de correo o un teléfono. */
export const OCULTO = "[oculto]";

function sinIdentificadores<T extends string | null | undefined>(texto: T): T {
  return (texto ? redactString(texto) : texto) as T;
}

/**
 * El mail del denunciante no sale para quien no puede ver el padrón.
 *
 * `run.input_payload` es `{ subject, body, sender_email }`: el correo entero que
 * escribió la persona. Salía a `...ALL_ROLES`, o sea también a `viewer`,
 * mientras `/api/customers` exige `CUSTOMER_PII_ROLES`. La frontera existía y
 * se esquivaba con dos pedidos: `GET /api/cases` para sacar un id, y `GET
 * /api/cases/:id/agent-run` para el mail completo.
 *
 * Que el `viewer` vea la corrida sigue siendo lo correcto —para eso está la
 * pantalla— y lo que se le quita es el cuerpo crudo, no la decisión: el modelo,
 * la confianza, los campos extraídos y el resultado quedan.
 */
export function sinPiiSiNoCorresponde<T>(run: T, rol: string): T {
  if (CUSTOMER_PII_ROLES.includes(rol as UserRole)) return run;
  if (!run || typeof run !== "object") return run;

  const r = run as {
    input_payload?: { subject?: string; body?: string; sender_email?: string | null };
  };
  if (!r.input_payload) return run;

  return {
    ...run,
    input_payload: {
      ...r.input_payload,
      subject: sinIdentificadores(r.input_payload.subject),
      body: sinIdentificadores(r.input_payload.body),
      // La dirección es de la persona y no hace falta para leer la corrida.
      sender_email: r.input_payload.sender_email ? OCULTO : r.input_payload.sender_email,
    },
  } as T;
}

interface MensajeConTexto {
  subject: string | null;
  body_text: string | null;
  from_addr: string | null;
}

/**
 * La conversación, sin identificadores, para quien sólo mira.
 *
 * `GET /api/cases/:id/messages` devolvía `body_text` y `from_addr` crudos a
 * `...ALL_ROLES`: el cuerpo de cada mensaje que mandó la persona, con su DNI y
 * su teléfono adentro, y la dirección desde la que escribió. Es la misma fuga
 * que se cerró en `agent-run`, por la puerta de al lado.
 *
 * `viewer` es el único rol que se enmascara. El motivo está en el encabezado de
 * este archivo.
 */
export function mensajesSinPiiSiNoCorresponde<T extends MensajeConTexto>(
  mensajes: T[],
  rol: string
): T[] {
  if (rol !== "viewer") return mensajes;

  return mensajes.map((m) => ({
    ...m,
    subject: sinIdentificadores(m.subject),
    body_text: sinIdentificadores(m.body_text),
    from_addr: m.from_addr ? OCULTO : m.from_addr,
  }));
}
