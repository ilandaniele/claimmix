# Connecting WhatsApp to ClaimMix (ban-safe)

This guide wires WhatsApp into ClaimMix so policyholders can **send claims via
WhatsApp** and have them flow into the same AI intake pipeline as email.

## TL;DR — what "ban-safe" actually means

There are two ways to talk to WhatsApp programmatically:

| Approach | Ban risk | Fits ClaimMix? |
|---|---|---|
| **Official Meta WhatsApp Business Cloud API** (`graph.facebook.com`) | ✅ None — it's Meta's sanctioned business platform | ✅ Yes |
| Unofficial WhatsApp-Web / `whatsmeow` (most "WhatsApp MCP" repos, e.g. `lharries/whatsapp-mcp`) | ❌ High — automates a *personal* account; Meta bans these | ❌ No |

**Every ban-safe option — including every ban-safe "WhatsApp MCP" — is built on
the official Cloud API.** So the foundation below is required either way.

> ⚠️ **Do not use your personal number** (+54 9 291 642 6930) as the *business*
> number. A number registered to the WhatsApp Business Platform can no longer be
> used as a normal WhatsApp account. Use a fresh number, or Meta's free **test
> number** for development. Your personal number is fine as a *recipient* you
> message the business from.

---

## Part A — ClaimMix already has the intake side built

- `POST /api/webhooks/whatsapp` receives messages and creates a case, then runs
  the AI extraction agent — the same pipeline as email.
- `GET /api/webhooks/whatsapp` answers Meta's verification handshake.
- The `whatsapp` channel exists across the schema, inbox, and case views.

You only need to (1) create a Meta WhatsApp app, (2) set env vars, (3) register
the webhook. No new ClaimMix code is required.

---

## Part B — Meta Business / Cloud API setup (one-time, you must do this)

1. Go to **developers.facebook.com** → create an app → type **Business**.
2. Add the **WhatsApp** product. Meta gives you a free **test phone number** and
   a temporary access token immediately.
3. From **WhatsApp → API Setup**, copy:
   - **Phone number ID** → `WHATSAPP_PHONE_NUMBER_ID`
   - **WhatsApp Business Account (WABA) ID** (needed for the MCP, Part D)
4. Create a **permanent** token: **Business Settings → System Users → Add** a
   system user with the `whatsapp_business_messaging` permission, generate a
   token → `WHATSAPP_ACCESS_TOKEN`. (The temporary token expires in 24 h.)
5. **App Secret**: **App Settings → Basic → App Secret** → `WHATSAPP_APP_SECRET`.
6. Pick any random string for `WHATSAPP_VERIFY_TOKEN` (you'll type the same value
   into the Meta dashboard in Part C).

---

## Part C — Configure ClaimMix

Set these in Vercel (Production) and `.env.local` (see `.env.example`):

```
WHATSAPP_VERIFY_TOKEN      = <the random token you chose>
WHATSAPP_APP_SECRET        = <Meta App Secret>
WHATSAPP_ACCESS_TOKEN      = <permanent system-user token>
WHATSAPP_PHONE_NUMBER_ID   = <from API Setup>
WHATSAPP_TENANT_ID         = <the ClaimMix tenant UUID inbound claims belong to>
WHATSAPP_API_VERSION       = v22.0        # optional
```

Then in the Meta dashboard, **WhatsApp → Configuration → Webhook**:

- **Callback URL:** `https://<your-prod-url>/api/webhooks/whatsapp`
- **Verify token:** the same `WHATSAPP_VERIFY_TOKEN`
- Click **Verify and Save** (Meta calls `GET` — ClaimMix echoes the challenge).
- **Subscribe** to the **`messages`** field.

### Test it

Send a WhatsApp message from your personal +54 number to the business/test
number. Within seconds a case appears in the inbox (channel = WhatsApp), the AI
extracts the fields, and — if `WHATSAPP_ACCESS_TOKEN` is set — ClaimMix can reply
with an acknowledgement (`sendWhatsAppText`, inside the 24 h service window).

For local testing without Meta, the **normalized + Bearer** path still works:

```bash
curl -X POST http://localhost:3000/api/webhooks/whatsapp \
  -H "Authorization: Bearer $WHATSAPP_WEBHOOK_SECRET" \
  -H "Content-Type: application/json" \
  -d '{"from":"5492916426930","body":"Tuve un choque en la ruta 3"}'
```

---

## Part D — (Optional) The ban-safe WhatsApp **MCP**

This is **not** what makes ClaimMix receive claims — Part A–C already does that.
An MCP lets **Claude itself** (Claude Code / Desktop / Cursor) send WhatsApp
messages via the *same* official Cloud API, e.g. for ops or testing. It is
ban-safe **because** it uses `graph.facebook.com`, not the personal web protocol.

Use a Cloud-API-based server such as
[`nakulben/whatsapp-mcp`](https://github.com/nakulben/whatsapp-mcp) or
[`tkhattar14/whatsapp-business-mcp`](https://github.com/tkhattar14/whatsapp-business-mcp)
(both call the official Graph API). Install per its README, then add it to your
**local** MCP config (do **not** commit it — it carries your token):

```jsonc
// .mcp.json (git-ignored) or your Claude Code user config
{
  "mcpServers": {
    "whatsapp": {
      "command": "/path/to/whatsapp-mcp/venv/bin/python",
      "args": ["-m", "whatsapp_mcp"],
      "env": {
        "META_ACCESS_TOKEN": "<WHATSAPP_ACCESS_TOKEN>",
        "META_PHONE_NUMBER_ID": "<WHATSAPP_PHONE_NUMBER_ID>",
        "META_WABA_ID": "<your WABA id>"
      }
    }
  }
}
```

It needs the **same** Meta credentials from Part B, so finish that first.

> Avoid `whatsmeow`-based servers (they pair a personal account by QR) for
> anything business-facing — that's the ban risk you're trying to avoid.

---

## Part E — Reopening a claim after the 24h window

Meta only lets a business message a claimant with plain text inside 24 h of
their last inbound message. Past that window, the **only** thing Meta accepts
is an approved template — so ClaimMix ships one to ask again for what's still
missing, `reabrir_denuncia`:

| Field | Value |
|---|---|
| Name | `reabrir_denuncia` |
| Category | Utility |
| Language | `es_AR` (Spanish — Argentina) |
| Body | `Hola. Te escribimos por tu denuncia con número de referencia {{1}}. Para poder seguir, todavía necesitamos: {{2}}. Podés responder a este mensaje; las fotos o archivos mandalos por este mismo chat.` |
| Sample for `{{1}}` | `a1b2c3d4-...` (a case id) |
| Sample for `{{2}}` | `Número de póliza` |

Create it in **Meta Business Manager → WhatsApp Manager → Message Templates**
with those exact values, then submit it for Meta's review.

Set `WHATSAPP_BUSINESS_ACCOUNT_ID` (the WABA id from Part B, step 3) so ClaimMix
can ask Meta whether the template got approved. The system-user token from Part
B needs the `whatsapp_business_management` permission for that lookup — add it
alongside `whatsapp_business_messaging` on the same system user.

There is nothing else to configure: ClaimMix checks the template's approval
status on its own, and caches it briefly. Without `WHATSAPP_BUSINESS_ACCOUNT_ID`,
or while the template is not yet approved, behaviour stays exactly as it is
today — a reopened-by-abandonment case outside the window simply can't be
reopened by resending.

---

## Parte F — Número propio por código (alta automática)

Un espacio del alta automática (`/alta`) nace con su número en estado `pedido`, y
hasta ahora lo conectaba el operador a mano desde `/admin/altas`. Con
`ALTA_NUMERO_AUTOMATICO=1` lo conecta el owner o el admin del espacio desde
**Configuración**: pide el código por SMS o por llamada, lo escribe, y Meta suma su
número a la WABA de la plataforma. Está **apagado por omisión**: sin la variable, o
sin la migración 0049 en la base, nada llama a Graph. `/admin/altas` sigue de
respaldo para cualquier caso que no cierre solo.

> Graph no se probó en vivo. Los endpoints, los cuerpos, el formato del móvil
> argentino, el idioma del SMS y los códigos de error de esta parte salen de la
> documentación de Cloud API y se miden en la prueba real de QA (abajo). Todo lo que
> Meta conteste y no se entienda termina en «revisión» con aviso al operador, nunca
> en un número a medias.

### Antes de prenderlo

1. Aplicar la **0049** a mano, con el rol dueño, en las tres bases y en este orden:
   QA (`ep-wispy-flower`), la viva (`ep-proud-resonance`) y la rama `production` de
   Veltra (`STAGING_DATABASE_URL`). Identificar cada base por el canal de sus casos,
   no por el nombre. `node scripts/migrate.mjs --apply`, y después en cada una, con su
   `DATABASE_URL_APP`: `pnpm permisos && pnpm tenancy`. El CI corre
   `--exigir-al-dia`: mergear antes de migrar lo deja rojo.
2. Sólo después, `ALTA_NUMERO_AUTOMATICO=1`. Con la bandera y sin la 0049 la
   pantalla de Configuración no muestra los formularios (comprueba en la misma
   consulta que la función exista) y sigue con «lo conectamos nosotros»; si alguien
   llega con una pantalla vieja, la acción termina en «revisión» sin llamar a Graph
   (el motivo queda en el log `alta.numero_automatico_no_aplica`, `sin_migracion`).
   La bienvenida de la bandeja sólo mira la bandera: por eso la 0049 va primero.
3. El token del sistema (`WHATSAPP_ACCESS_TOKEN`) necesita
   `whatsapp_business_management` y `whatsapp_business_messaging`, y hacen falta
   `WHATSAPP_BUSINESS_ACCOUNT_ID` y `WHATSAPP_PHONE_NUMBER_ID` (el de la plataforma).
   Sin alguno de los dos ids no se agrega nada.
4. Confirmar que la app de ClaimMix está en `subscribed_apps` de la WABA: así los
   mensajes del número nuevo llegan al mismo webhook, sin configurar nada más.
5. Mantener `ADMIN_EMAILS` y el remitente del sistema (Gmail): sin ellos los avisos
   al operador sólo quedan en el log `alta.numero_en_revision`.

### Lo que hace la persona

1. Se da de alta en `/alta` con un **móvil argentino** (`+549` y diez dígitos más)
   que reciba SMS o llamada y que **no esté en la app de WhatsApp ni en WhatsApp
   Business**. Si lo está, tiene que borrar esa cuenta y esperar unos minutos; los
   chats se pierden.
2. En **Configuración** aprieta «Por SMS» o «Por llamada». El panel sólo se ve si es
   owner o admin, el espacio es del alta automática, la prueba sigue vigente (o está
   activo; suspendido o dado de baja no), la 0049 está en la base y el número está en
   `pedido`. En `/registro` el aviso de que el móvil no puede estar en la app de
   WhatsApp aparece con la bandera prendida.
3. Escribe el código de seis números y aprieta «Conectar».
4. Listo: lo que le escriban a ese número entra como caso en la bandeja de su espacio.

Los clientes de esa aseguradora ven como nombre del número **el de la plataforma**
(el `verified_name` del número de Veltra, leído de Graph). Lo que tipeó la persona
nunca va como nombre. Si después quiere que figure el de su empresa, se pide a Meta
a mano.

### Lo que hace el sistema

Cada acción es un formulario de servidor (sin JavaScript de cliente) que termina en
`/configuracion?wa=<resultado>`, con un resultado de una lista cerrada: nunca un
texto de Graph.

**Pedir el código** (`pedirCodigo`):

1. Toma los cupos de código (por espacio, por red y global). Sin lugar, «esperar».
2. Lee, en una consulta, la fila del número y el estado del espacio y comprueba que
   la 0049 exista. Si algo no cierra, «revisión» y no llama a Graph; si el espacio
   no tiene fila de número, además sale el aviso `sin_fila`. Si falta el token, la
   WABA o el número de la plataforma en el entorno, aviso `sin_credencial`.
3. Si la fila todavía no tiene `phone_number_id`:
   - parte el número (sólo `+549…`; otro formato, aviso `pais`);
   - recorre la WABA (`GET /{waba}/phone_numbers?fields=id,display_phone_number,verified_name`);
   - si el número ya está ahí, no lo adopta (aviso `ya_en_la_waba`); si la WABA ya
     tiene el máximo de números, aviso `sin_lugar`; si no aparece el nombre de la
     plataforma, aviso `sin_nombre`;
   - toma los cupos de alta y agrega el número
     (`POST /{waba}/phone_numbers` con `cc`, `phone_number` y `verified_name`). Si
     Meta pide aflojar, «esperar» y los cupos de alta vuelven; si rechaza, aviso
     `rechazo`; si no contesta, da 5xx o contesta sin id, el número pudo haber
     entrado: aviso `incierto` y los cupos se quedan gastados;
   - guarda el id que Graph devolvió con la función de la 0049 (paso `agregado`) y
     avisa al operador (aviso `agregado`).
4. Pide el código: `POST /{id}/request_code` con `code_method` (`SMS` o `VOICE`) y
   `language` (`es` o `en`, según la cuenta).

**Verificar el código** (`verificarCodigo`):

1. Toma el cupo de verificaciones. El código tiene que ser `^\d{6}$`.
2. `POST /{id}/verify_code` con `code`. Si Meta lo rechaza, mira
   `GET /{id}?fields=code_verification_status`: si ya figura `VERIFIED` (un intento
   anterior que se cortó después de aceptarlo) sigue; si no, «código incorrecto».
3. Si Meta ya lo tiene registrado en Cloud API
   (`GET /{id}?fields=status,platform_type`) no vuelve a registrarlo. Si no,
   `POST /{id}/register` con `messaging_product` y un PIN de seis dígitos al azar.
4. Con la función de la 0049 (paso `conectado`) pasa la fila a `conectado`. Desde
   ahí el webhook de la WABA lo rutea al espacio y las respuestas salen con el token
   de la plataforma.

Lo que nunca pasa: el número de la plataforma no se toca (ni `register`, ni
`request_code`, ni se guarda en la fila de un espacio); nada borra números de la
WABA ni llama a `deregister`; el token, el PIN y el código no se anotan, no se
guardan y no vuelven a la pantalla; el `phone_number_id` sale siempre de la
respuesta de Graph, nunca de lo tipeado.

### El tope de Meta

Mientras la empresa (Veltra) **no esté verificada en Meta**, un portfolio admite **2
números** (esto sale de la documentación, no se midió). El de la plataforma ya ocupa
uno: **hoy entra un solo número automático**. Del segundo espacio en adelante, todo
va a revisión con el aviso `sin_lugar`, hasta que se verifique la empresa y se suba
`ALTA_NUMEROS_MAXIMOS_WABA`. Ese tope se compara contra **todas** las filas que
devuelve `/phone_numbers`, en cualquier estado, antes de agregar. Si no se las puede
contar enteras, el pedido falla cerrado («meta»).

### Los topes

| Variable | Por defecto | Rango | Qué limita |
|---|---|---|---|
| `ALTA_NUMERO_AUTOMATICO` | apagado | `1` prende | la función entera |
| `ALTA_NUMEROS_MAXIMOS_WABA` | 2 | 1-1000 | números en total de la WABA, el de la plataforma incluido |
| `ALTA_TOPE_NUMEROS_DIA` | 2 | 0-50 | números nuevos por día, de todos los espacios juntos (0 cierra) |
| `ALTA_TOPE_CODIGOS_INQUILINO_DIA` | 3 | 0-20 | pedidos de código por espacio cada 24 h |
| `ALTA_TOPE_CODIGOS_IP_DIA` | 5 | 0-50 | pedidos de código por red cada 24 h (/56 en IPv6) |
| `ALTA_TOPE_CODIGOS_DIA` | 10 | 0-500 | pedidos de código de todos los espacios, cada 24 h (0 cierra) |
| `ALTA_TOPE_VERIFICACIONES_HORA` | 5 | 0-20 | intentos de entregar un código por espacio por hora |

Además hay dos cupos fijos, sin variable: **un número nuevo por hora por espacio** y
**tres `register` por día por espacio** (Meta admite unos diez por número cada 72 h).
Todos fallan cerrados: si el contador no contesta, no sale nada. Los cupos de código
sólo se devuelven si ningún pedido a Graph salió: una compuerta cortó antes (la fila,
el espacio, la migración, las credenciales o un móvil que no es argentino). Desde el
recorrido de la WABA se quedan gastados, aunque el recorrido falle, porque cada
vuelta cuesta contra los topes de Meta; un timeout o una respuesta rara en
`request_code` también cuentan como código pedido, porque Meta pudo haber mandado el
SMS. Los cupos de alta (un número por hora por espacio y el tope diario) vuelven sólo
cuando Meta pide aflojar.
Las ventanas de 24 h son fijas (cortan a las 00:00 UTC): en el borde del día el tope
puede duplicarse.

### Qué hace el operador ante cada aviso

El mail dice sólo el motivo; qué espacio fue queda en el log `alta.numero_en_revision`
(`vercel logs`). Sale un aviso por día y motivo, salvo `agregado` e `incierto`, que
salen por cada espacio.

| Motivo | Qué pasó | Qué hacer |
|---|---|---|
| `sin_lugar` | La WABA llegó a `ALTA_NUMEROS_MAXIMOS_WABA`, o se agotó `ALTA_TOPE_NUMEROS_DIA`. | Mirar WhatsApp Manager y borrar a mano los números sobrantes, o verificar la empresa en Meta y subir el tope. Mientras, conectar el espacio desde `/admin/altas`. |
| `ya_en_la_waba` | El número ya estaba en la WABA; no se adopta solo. | Ver de quién es. Si es del cliente, conectarlo desde `/admin/altas` (se comprueba contra Meta); si no, aclararlo con quien lo agregó. |
| `rechazo` | Meta dijo que no (el número está en la app de WhatsApp, nombre rechazado, PIN de otro proveedor…). | Leer el `code` en el log `whatsapp.alta_numero.graph` (trae el paso). Si es la app de WhatsApp, el cliente borra esa cuenta; si no, `/admin/altas`. |
| `sin_dueno` | Meta tiene el número, pero la base no pudo asignárselo al espacio. | Ver `alta.numero_automatico_no_guardado` (dice el resultado de la función) y conectarlo desde `/admin/altas`. Mientras la fila siga en `pedido`, el webhook descarta lo que entre. |
| `pais` | No es un móvil argentino; no se mandó nada a Meta. | Corregir el número del espacio o conectarlo a mano. |
| `sin_nombre` | Graph no devolvió el nombre visible del número de la plataforma; no se agregó nada. | Revisar `WHATSAPP_PHONE_NUMBER_ID` y el permiso `whatsapp_business_management` del token. |
| `agregado` | No es una falla: un número entró a la WABA. | Si el espacio no llega a conectarlo, borrarlo a mano en WhatsApp Manager, porque ocupa lugar del tope. |
| `incierto` | Se pidió agregar el número y Meta no contestó o contestó algo que no se entiende: pudo haber entrado. | Buscarlo en WhatsApp Manager. Si está, conectar el espacio desde `/admin/altas` o borrarlo; si no, repetir. Los cupos del espacio quedan gastados. |
| `sin_fila` | Un espacio pidió el código y no tiene un número en trámite (`pedido`); no se llamó a Meta. | Ver el espacio en `/admin/altas`: puede ser un número ya tomado por otro al darse de alta. |
| `sin_credencial` | Falta el token, la WABA o el número de la plataforma en el entorno; no se llamó a Meta. | Revisar `WHATSAPP_ACCESS_TOKEN`, `WHATSAPP_BUSINESS_ACCOUNT_ID` y `WHATSAPP_PHONE_NUMBER_ID`. |

Los números sobrantes se borran **a mano en WhatsApp Manager**: ClaimMix no borra nada
de la WABA. Lo mismo vale para un flujo abandonado (se agregó el número y nadie
escribió el código).

### El PIN de dos pasos

`register` pone la verificación en dos pasos con un PIN al azar que **no se guarda**:
guardar un secreto que no se usa sólo agrega superficie. Para re-registrar o migrar
el número hay que cambiarlo antes, con el mismo token:
`POST /{id}` con `{ "pin": "<seis dígitos>" }`. Si el número ya tenía un PIN de otro
proveedor, `register` falla y el caso va a revisión.

### Prueba real en QA

Hace falta una SIM libre que no esté en la app de WhatsApp. Prender
`ALTA_NUMERO_AUTOMATICO=1` **sólo en QA** (y la 0049 ya aplicada en esa base).

1. Crear un espacio por `/alta` con el número de esa SIM.
2. En Configuración, «Por SMS»; si no llega, «Por llamada».
3. Escribir el código y ver «Listo».
4. Mandar un WhatsApp a ese número y ver el caso en la bandeja de ese espacio.
5. En los logs (`vercel logs`, evento `whatsapp.alta_numero.graph`) anotar los códigos
   de error que aparezcan y si el número argentino entró con el 9 adelante.
6. En WhatsApp Manager, mirar el estado del nombre visible.
7. Si queda un número sobrante, borrarlo ahí.

Lo que sólo esta prueba aclara: que llegue el SMS o la llamada, el `verify_code` y el
`register` reales, el formato del número, el idioma, los códigos de error, cómo cuenta
Meta el tope, la revisión del nombre y que el webhook del número nuevo llegue al
espacio. Las constantes están juntas en `src/server/whatsapp/alta-de-numero.ts` para
ajustarlas después. En producción se prende recién cuando QA salga bien.
