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
4. Confirmar que la app de ClaimMix está en `subscribed_apps` de la WABA. Cada
   número nuevo recibe además su **webhook propio**
   (`NEXT_PUBLIC_SITE_URL` + `/api/webhooks/whatsapp`, con `WHATSAPP_VERIFY_TOKEN`):
   dev y prd comparten app y WABA, y sin él los mensajes del número caerían en el
   webhook del otro ambiente. Con `NEXT_PUBLIC_SITE_URL` sin https o sin
   `WHATSAPP_VERIFY_TOKEN` no se llama a Meta (aviso `sin_credencial`). En el
   ambiente que no es dev, `NUMEROS_DE_DEV` lista los números de dev: uno de ellos
   termina en «revisión» con el aviso `de_otro_ambiente`, sin tocar Meta.
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
   no tiene fila de número, además sale el aviso `sin_fila`. Si el número es de la
   lista del otro ambiente, aviso `de_otro_ambiente`. Si falta el token, la WABA, el
   número de la plataforma, el sitio https o `WHATSAPP_VERIFY_TOKEN` en el entorno,
   aviso `sin_credencial`. La fila se lee y se escribe en control; cada paso que se
   guarda se espeja a la base del cliente (con `BASE_POR_CLIENTE` apagado no hace
   nada) y, si la copia no entra, el paso sale igual y la levanta el barrido.
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
4. Le pone al número su webhook propio (`POST /{id}` con
   `webhook_configuration.override_callback_uri` y `verify_token`) y lo lee de Graph
   (`GET /{id}?fields=webhook_configuration`). Si lo que vuelve no es la URL de este
   ambiente, el número queda registrado y en `pedido`, con el aviso `sin_webhook`; un
   nuevo intento repite el webhook sin volver a registrarlo.
5. Con la función de la 0049 (paso `conectado`) pasa la fila a `conectado`, sólo con
   el webhook leído de Graph. Desde ahí el webhook del número lo rutea al espacio y
   las respuestas salen con el token de la plataforma.

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

El tope es **por portfolio de negocio, no por WABA**. La documentación de la Cloud API
(https://developers.facebook.com/docs/whatsapp/cloud-api/phone-numbers) dice: «New
business portfolios are initially capped at two registered business phone numbers.»
Veltra es un solo portfolio, así que una WABA nueva dentro de Veltra no suma lugares.
Además, cada WABA necesita su propio número de la plataforma. Una WABA por ambiente
espera a la verificación del negocio o a un portfolio aparte (`docs/PUESTA_EN_MARCHA.md`,
«Después de A5: una WABA y un token por ambiente»).

La tarjeta «Lugares en la WABA de la plataforma» de `/admin/altas` muestra «N libres de
M», donde M es `ALTA_NUMEROS_MAXIMOS_WABA` y N lo que queda después de contar las filas
de `/phone_numbers` (una sola recorrida de Graph, sin consulta a la base). Compara con
ese tope por WABA, el mismo que dispara `sin_lugar`, y **no** con el tope de Meta por
portfolio de arriba. En 0 libres se pone en rojo. Si falta la credencial, Meta no
contesta o no se pudieron contar las filas enteras, muestra «—» y «Meta no contestó: sin
dato».

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
(`vercel logs`). Sale un aviso por día y motivo, salvo `agregado`, `incierto` y
`sin_webhook`, que salen por cada espacio.

| Motivo | Qué pasó | Qué hacer |
|---|---|---|
| `sin_lugar` | La WABA llegó a `ALTA_NUMEROS_MAXIMOS_WABA`, o se agotó `ALTA_TOPE_NUMEROS_DIA`. | Mirar WhatsApp Manager y borrar a mano los números sobrantes, o verificar la empresa en Meta y subir el tope. Mientras, conectar el espacio desde `/admin/altas`: ahora fija el webhook propio del número, ya no hace falta ponerlo a mano. |
| `ya_en_la_waba` | El número ya estaba en la WABA; no se adopta solo. | Ver de quién es. Si es del cliente, conectarlo desde `/admin/altas` (se comprueba contra Meta); si no, aclararlo con quien lo agregó. |
| `rechazo` | Meta dijo que no (el número está en la app de WhatsApp, nombre rechazado, PIN de otro proveedor…). | Leer el `code` en el log `whatsapp.alta_numero.graph` (trae el paso). Si es la app de WhatsApp, el cliente borra esa cuenta; si no, `/admin/altas`. |
| `sin_dueno` | Meta tiene el número, pero la base no pudo asignárselo al espacio. | Ver `alta.numero_automatico_no_guardado` (dice el resultado de la función) y conectarlo desde `/admin/altas`. Mientras la fila siga en `pedido`, el webhook descarta lo que entre. |
| `pais` | No es un móvil argentino; no se mandó nada a Meta. | Corregir el número del espacio o conectarlo a mano. |
| `sin_nombre` | Graph no devolvió el nombre visible del número de la plataforma; no se agregó nada. | Revisar `WHATSAPP_PHONE_NUMBER_ID` y el permiso `whatsapp_business_management` del token. |
| `agregado` | No es una falla: un número entró a la WABA. | Si el espacio no llega a conectarlo, borrarlo a mano en WhatsApp Manager, porque ocupa lugar del tope. |
| `incierto` | Se pidió agregar el número y Meta no contestó o contestó algo que no se entiende: pudo haber entrado. | Buscarlo en WhatsApp Manager. Si está, conectar el espacio desde `/admin/altas` o borrarlo; si no, repetir. Los cupos del espacio quedan gastados. |
| `sin_fila` | Un espacio pidió el código y no tiene un número en trámite (`pedido`); no se llamó a Meta. | Ver el espacio en `/admin/altas`: puede ser un número ya tomado por otro al darse de alta. |
| `sin_credencial` | Falta el token, la WABA o el número de la plataforma en el entorno, o el sitio no es https o no hay token del apretón de manos; no se llamó a Meta. | Revisar `WHATSAPP_ACCESS_TOKEN`, `WHATSAPP_BUSINESS_ACCOUNT_ID`, `WHATSAPP_PHONE_NUMBER_ID`, `NEXT_PUBLIC_SITE_URL` y `WHATSAPP_VERIFY_TOKEN`. |
| `de_otro_ambiente` | Un espacio pidió un número de la lista `NUMEROS_DE_DEV`; no se llamó a Meta. | Ver cómo llegó ese número a este ambiente y conectarlo en el que corresponde. |
| `sin_webhook` | El número quedó registrado pero Graph no devolvió el webhook propio de este ambiente: lo que le escriban puede caer en el otro. | Mirar el número en WhatsApp Manager. El espacio puede reintentar (repite el webhook sin registrar de nuevo); si no alcanza, conectar desde `/admin/altas`, que fija el webhook propio del número: ya no hace falta ponerlo a mano. |

Los números sobrantes se borran **a mano en WhatsApp Manager**: ClaimMix no borra nada
de la WABA. Lo mismo vale para un flujo abandonado (se agregó el número y nadie
escribió el código).

### Conectar a mano: qué contesta

Conectar desde `/admin/altas` comprueba el número contra Meta y, antes de escribir en la
base, le fija su webhook propio (el mismo del paso 4 de arriba) y lo vuelve a leer de
Graph. El número de la plataforma no se toca: usa el webhook de la app. La pantalla
contesta con un resultado de una lista cerrada, y no escribe nada en la base si no es
`ok`:

- `sin_credencial`: falta la credencial de Meta de la plataforma, su WABA,
  `NEXT_PUBLIC_SITE_URL` con https o `WHATSAPP_VERIFY_TOKEN`. Falla cerrado: no se llamó
  a Meta.
- `webhook_ajeno`: el número ya tiene el webhook de otro ambiente. No se toca ni se
  conecta; hay que conectarlo en el ambiente que corresponde.
- `sin_webhook`: Meta no dejó el webhook de este ambiente en el número. No se conectó;
  mirar el número en WhatsApp Manager y repetir. (Es el resultado de la pantalla, no el
  aviso por mail del mismo nombre.)
- `meta_no_responde`: Meta no contestó o contestó algo que no se entiende. Repetir en un
  rato.

### El PIN de dos pasos

`register` pone la verificación en dos pasos con un PIN al azar que **no se guarda**:
guardar un secreto que no se usa sólo agrega superficie. Para re-registrar o migrar
el número hay que cambiarlo antes, con el mismo token:
`POST /{id}` con `{ "pin": "<seis dígitos>" }`. Si el número ya tenía un PIN de otro
proveedor, `register` falla y el caso va a revisión.

### Prueba real en QA

Hace falta una SIM libre que no esté en la app de WhatsApp. Prender
`ALTA_NUMERO_AUTOMATICO=1` en QA (y la 0049 ya aplicada en esa base), con el token de
la WABA propia de QA (después de A5).

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
ajustarlas después.

Estado al 17/10: en prd la bandera está prendida desde el 09/10 y esta prueba en QA no
se hizo. El dueño eligió (D1, b) prenderla también en dev y en QA, y se carga en el lote
de A12 de `docs/PUESTA_EN_MARCHA.md`. QA no tiene token de WhatsApp, así que sus altas
por código van a revisión con `sin_credencial`. El único lugar libre de la WABA actual
es primero del cliente ficticio de prd, y esa alta es la prueba en vivo: mirar
`whatsapp.alta_numero.graph` y `alta.numero_en_revision` en los logs. La prueba real en
QA espera a la WABA y al token propios de QA (después de A5).


## Parte G — WABA propia por cliente (Embedded Signup)

Cada cliente trae su propia WABA con el popup de Meta (Embedded Signup v4) y los
mensajes salen de su número, con su token. La WABA «Veltra» deja de ser el cuello de
botella de los números. Detrás de `ALTA_WABA_PROPIA`, apagada por omisión: con ella
apagada todo anda como antes.

- **Quién entra:** el admin de un espacio de alta automática (`autoalta`), desde
  `/conectar-whatsapp`, a la que lo lleva un enlace en Configuración y en `/preparando`.
  Un espacio en prueba también puede abrir el popup.
- **Quién no:** los clientes que ya están conectados a la WABA de la plataforma siguen
  ahí. No hay migración de uno a otro. Tampoco se soporta la coexistencia con la app de
  WhatsApp Business: si el número sigue en esa app, la conexión queda en falla
  `coexistencia`.
- **Solo celulares argentinos (+54).**

### Cómo funciona, en una pasada

1. `iniciarWaba` mira que haya lugar esta semana (`ALTA_TOPE_WABAS_SEMANA`, 10 por
   omisión, de todos los espacios juntos) y arma lo que el popup precarga.
2. La persona recorre el popup. El navegador devuelve un código que dura 30 segundos y un
   evento; el evento es una pista, no la verdad.
3. `vincularWaba` cambia el código por el token del usuario de sistema de la integración
   (no vence, y muere si el cliente saca la app de su cuenta) y le pregunta a Meta, con
   ese token, qué WABA y qué número son. Se guarda cifrado con
   `GMAIL_TOKEN_ENCRYPTION_KEY` y `wa:<tenantId>:<wabaId>` como AAD: el sobre de un
   espacio no abre en la fila de otro.
4. `continuarWaba` suscribe la app a la WABA, pide el código del número si hace falta,
   registra el número, le pone su webhook (el mismo `override_callback_uri` por número de
   la Parte F, `fijarWebhookDelNumero`) y lo deja `conectada`. Se puede repetir: cada vuelta
   retoma donde quedó y no vuelve a canjear el código.
5. Al conectar se pide en segundo plano la plantilla `reabrir_denuncia` (categoría
   UTILITY, la misma que la de la plataforma; FINANCE es la categoría del perfil comercial
   del número, no de la plantilla) en la WABA del cliente. Hasta que Meta la apruebe, «Reabrir y reenviar» cae al
   correo, como antes.

Estados de la fila (`whatsapp_wabas.estado`): `cancelada`, `vinculada`, `suscripta`,
`falta_codigo`, `falta_pin`, `conectada`, `falla` y `revocada`. Las fallas posibles son
`canje`, `token_invalido`, `suscripcion`, `registro`, `webhook`, `token_vencido`,
`nombre_rechazado`, `coexistencia` y `sin_numero`. El token y el PIN no llegan a un
registro, a un resultado ni al navegador.

### Configurar Meta (dueño, en este orden)

**Se puede empezar hoy, sin código:**

1. Verificar el negocio Veltra en Meta: la constancia de CUIT con la razón social exacta y
   un comprobante de domicilio.
2. En Configuración básica de la app: ícono, categoría, `https://claimmix.vercel.app/privacy`
   y `/terms`, y la **URL de eliminación de datos**:
   `https://claimmix.vercel.app/api/meta/borrado` (responde después del deploy).
3. En Casos de uso, WhatsApp: empezar el onboarding de **Tech Provider**.
4. Revisión de la app: acceso avanzado a `whatsapp_business_management` y
   `whatsapp_business_messaging`, con los videos grabados sobre el número actual.

**Hace falta el código desplegado:**

5. Facebook Login for Business: prender Client OAuth, Web OAuth, Enforce HTTPS, Strict Mode
   y Login with JS SDK; dominios permitidos de prd y de dev; crear una configuración de
   Embedded Signup v4 con Cloud API y token **que no vence**. Sin `featureType`: la
   coexistencia no entra. El `config_id` que sale es `META_ES_CONFIG_ID`.
6. Suscribir en el webhook de la app los campos `account_update` y
   `phone_number_name_update` (además de `messages`, que ya está).
7. Aplicar la 0051 (`neon/migrations/0051_waba_propia.sql`) **a mano**, con el dueño de la
   base (necesita `BYPASSRLS`), en las tres bases y antes de prender la bandera: QA
   (`ep-wispy-flower`), producción (`ep-proud-resonance`) y la rama `production` de Veltra
   (`STAGING_DATABASE_URL`). Sin ella `/admin/altas` y la baja de un número fallan, y el CI
   queda rojo por `--exigir-al-dia`. Después, en cada una con su `DATABASE_URL_APP`:
   `pnpm permisos && pnpm tenancy`.
8. Solo en dev: cargar `META_APP_ID`, `META_ES_CONFIG_ID` y `ALTA_WABA_PROPIA=1` (más
   `WHATSAPP_APP_SECRET`, que ya está). Probar como administrador de la app, con un
   portfolio de prueba nuevo (la WABA de Veltra se rechaza) y una SIM libre. Mirar:
   - el estado llega a `conectada`;
   - un mensaje desde un celular personal llega a la bandeja de dev;
   - la plantilla se crea;
   - «Desvincular la WABA» borra el token;
   - la revisión nocturna corre (`reap-stuck`);
   - **el `user_id` del `signed_request` de `/api/meta/borrado` es el `authResponse.userID`
     que devuelve el popup.** El `user_id` de `debug_token` del token que se canjea es el del
     usuario de sistema de la integración, no el de la persona que conectó, así que no sirve
     para el borrado. Se guarda como `fb_user_id` el que informa el popup (con forma de id
     de Meta) y, sin él, el de `debug_token`; el borrado busca por ese valor. Si Meta no
     devuelve `userID` o los ids no calzan, el borrado contesta igual 200 con su código pero
     deja `meta_borrado.sin_coincidencia` en el registro: ahí hay que usar «Desvincular la
     WABA» a mano. Esto solo se ve contra Meta de verdad.
9. Con la app aprobada y la verificación de acceso hecha: pasar la app a modo Live, cargar
   las variables en prd, hacer **una** promoción y conectar al primer cliente. **No prender
   prd sin haber visto en dev que el `user_id` del borrado calza con el `userID` del popup**
   (punto del paso 8): hasta entonces el borrado automático es una suposición y vale el
   procedimiento manual de «Si un cliente pide que se borren sus datos».
10. **Marcha atrás:** `ALTA_WABA_PROPIA=0`. Frena el alta nueva; los clientes ya conectados
    siguen enviando y recibiendo, porque el envío nunca mira la bandera.
11. **Un solo entorno por app de Meta.** La app tiene un único webhook para `account_update`
    y `phone_number_name_update`. Si dev y prd comparten app, los eventos de las WABAs que se
    conectaron en un entorno llegan al otro, que no tiene su fila y los descarta: la
    revocación o el rechazo de nombre no se ven. Por eso `ALTA_WABA_PROPIA` va prendida en un
    solo entorno por app de Meta (hoy, dev hasta que se promueva a prd), o cada entorno con su
    propia app.

Variables (ver `.env.example`): `ALTA_WABA_PROPIA`, `META_APP_ID`, `META_ES_CONFIG_ID`,
`WHATSAPP_APP_SECRET` y `ALTA_TOPE_WABAS_SEMANA`. Faltando alguna de las tres credenciales
el botón no se muestra.

### Qué mira el sistema solo

- **Cada mensaje.** `numeros.ts` abre el token del espacio con su AAD; una fila con token que
  no abre no manda ni recibe (queda `whatsapp.credenciales_sin_token`). Una fila conectada sin
  token es del camino de la plataforma y usa el token del entorno, aunque su WABA no sea la
  de `WHATSAPP_BUSINESS_ACCOUNT_ID` (por ejemplo la WABA de prueba): así la bandera apagada
  no corta a esos clientes. El webhook le pasa a `resolverNumeros` la WABA que Meta declara en
  el evento: si el número pertenece a otra, se anota `waba_no_coincide` y el evento se rutea
  igual, porque quien decide a quién pertenece el número es la fila y no el sobre del webhook.
- **Cada envío.** Si Graph contesta 190 (token) o 131042 (forma de pago o factura), el
  mensaje no sale, el caso cae al correo y el operador recibe el aviso `token_vencido` o
  `pago_pendiente`, pero solo si el espacio habla con su WABA propia: con la WABA de la
  plataforma el aviso le diría al cliente que vuelva a conectar algo que no es suyo, así que
  ahí solo queda el registro `whatsapp.messenger.send_failed`.
- **Eventos de la cuenta** (`account_update` y `phone_number_name_update`, solo por la
  ruta firmada con HMAC y en segundo plano): revocación o desvinculación, nombre aprobado o
  rechazado y restricciones. Antes de dar una WABA por revocada se le pregunta a Graph
  (`debug_token`, código 190); un evento viejo se ignora por su `hora`.
- **Una vez al día**, dentro de `/api/cron/reap-stuck` (`revisarWabas`, 20 s de
  presupuesto, 50 WABAs al azar por vuelta, de mejor esfuerzo): cada WABA `conectada` tiene
  que seguir con un token válido (si no, pasa a `falla` con `token_vencido`); si le falta la
  plantilla, se pide de nuevo; y una WABA a medias hace más de 48 horas avisa como
  `waba_huerfana`.

### Qué hace el operador

Todo desde `/admin/altas`, columna «WhatsApp propio» de cada espacio: origen (WABA propia o
de la plataforma), estado, falla, paso donde canceló, WABA, nombre del número y estado de
la plantilla.

- **«Reintentar la conexión»** retoma `continuarWaba` con el token guardado. Sirve cuando
  quedó a medias por un corte de Meta. Si no hay token, avisa «No hay token de la WABA para
  reintentar» y el cliente tiene que volver a abrir el popup.
- **«Desvincular la WABA»** borra el token y el PIN, da de baja el número y suelta la app
  en Meta (se baja el número y se desuscribe la app). Con el token ya muerto no puede
  llamar a Meta y no es un error: la fila queda `revocada`.
- **«Dar de baja el número»** (el botón de siempre) también borra el token y revoca la fila
  de la WABA, pero **no llama a Meta**. Para soltar la app en Meta hay que usar «Desvincular
  la WABA».
- **Conectar a mano** (el formulario del operador) sigue siendo solo sobre la WABA de la
  plataforma, y ahora también le fija el webhook propio al número (ver «Conectar a mano:
  qué contesta», en la Parte F). No hay «conectar por el cliente».
- **Ayuda del cliente:** el enlace «Ayuda» de `/conectar-whatsapp` es un `mailto:` a la misma
  dirección a la que escribe `aviso-operador.ts`, con el espacio y la WABA en el cuerpo.

Avisos nuevos (`aviso-operador.ts`; llega un mail por motivo por día, y por espacio en los
motivos que son de un espacio):

| Motivo | Qué pasó | Qué hacer |
|---|---|---|
| `canje` | Meta no aceptó el código del popup y no hay token para seguir | Revisar `META_APP_ID` y `WHATSAPP_APP_SECRET`; el código está en el registro `whatsapp.embedded_signup.graph`; el cliente reabre el popup |
| `suscripcion` | No se pudo suscribir la app a la WABA: no llega ningún mensaje de ella | Mirar el registro `whatsapp.embedded_signup.graph`; «Reintentar la conexión» |
| `registro` | Meta no registró el número en Cloud API | Mirar el registro `whatsapp.alta_numero.graph`; el cliente puede reintentar desde su pantalla o el operador con «Reintentar la conexión» |
| `revocada` | El cliente sacó la app o Meta anuló el acceso (confirmado con `debug_token`) | Nada en Meta; el espacio no manda ni recibe hasta que el cliente vuelva a conectar |
| `plantilla` | No se pudo crear `reabrir_denuncia` en la WABA del cliente | El número funciona dentro de las 24 horas; la revisión diaria la pide de nuevo |
| `numero_ocupado` | Un espacio quiso conectar un número o WABA que ya son de otro | Revisar a quién pertenece antes de tocar nada |
| `cupo_semanal` | Se llegó al tope de WABAs nuevas de la semana | Subir `ALTA_TOPE_WABAS_SEMANA` o esperar a la semana siguiente |
| `token_vencido` | Graph dijo 190 en un envío o en la revisión diaria | Ver abajo |
| `pago_pendiente` | Graph dijo 131042: la WABA no tiene forma de pago o debe una factura | El cliente lo arregla en Meta |
| `nombre_rechazado` | Meta rechazó el nombre visible del número | El cliente lo cambia en WhatsApp Manager |
| `waba_huerfana` | La persona se fue en medio del trámite (WABA a medias hace más de 48 h) y Meta sigue con la app vinculada | «Desvincular la WABA» del espacio; si ya no hay fila (se borró el espacio o falló el guardado), desvincular la app en Meta. El aviso se repite una vez al día hasta que alguien actúe |
| `cuenta_restringida` | Meta restringió, deshabilitó o sancionó la cuenta | El detalle está en el registro `whatsapp.cuenta_restringida`; lo resuelve el cliente en WhatsApp Manager |

**Token vencido.** La WABA pasa a `falla` con `token_vencido` solo desde `conectada`. Si el
número seguía conectado, el operador tiene que «Desvincular la WABA» y el cliente volver a
abrir el popup: reintentar no sirve, porque el token no vuelve.

### Si un cliente pide que se borren sus datos

Meta llama a `POST /api/meta/borrado` (la URL de eliminación de datos de la app) con un
`signed_request`. Sin firma válida contesta 400 y no toca nada. Con firma, busca las WABAs
de ese `user_id` de Facebook, borra el token y el PIN (la misma baja que el operador),
deja una entrada de auditoría por espacio y contesta `{ url, confirmation_code }`. Si no
encuentra ninguna fila contesta igual, con un código, porque no hay nada que borrar. Si
falla la base contesta 500 para que Meta reintente. Los casos y los mensajes de los
asegurados son del cliente y no se borran por acá. Tampoco se suelta la app en Meta: para
cuando Meta llama, el token ya está muerto.

**El id de Facebook puede no calzar.** El `user_id` que manda Meta en el pedido de borrado
tiene que ser el `authResponse.userID` que el popup informó al conectar, y eso solo se
confirma contra Meta de verdad (paso 8). Si no calza, la ruta contesta igual 200 con su
código, pero no borra nada y deja `meta_borrado.sin_coincidencia` en el registro. Mientras
no esté confirmado, un pedido de borrado se atiende **a mano**:

1. Buscar en el registro (`vercel logs`, entorno que corresponda) la línea
   `meta_borrado.sin_coincidencia` y anotar su `codigo`: es el que Meta le dio a la persona.
2. Identificar el cliente por la razón social o el correo que la persona informe, nunca
   por el id del pedido.
3. En `/admin/altas`, abrir el espacio y usar «Desvincular la WABA»: borra el token y el PIN
   y da de baja el número. Es la misma baja que hace la ruta.
4. Contestarle a la persona, con el código del paso 1, que el acceso ya está borrado. Los
   casos y mensajes de sus asegurados no se borran por este pedido.

Si en dev el id calza, esta sección queda como respaldo para los pedidos que no traigan
`userID`.

### Texto de privacidad (pendiente del dueño)

`src/app/privacy/page.tsx` **no se toca desde el código**. La URL de eliminación de datos
apunta a `/privacy#meta`, así que esa página necesita una sección con ese ancla. Texto
propuesto:

> **Datos que recibimos de Meta (WhatsApp).** Cuando conectás tu cuenta de WhatsApp Business
> con ClaimMix, Meta nos entrega un acceso a tu cuenta de WhatsApp Business (la WABA y el
> número que elegiste) para que podamos recibir y enviar los mensajes de tus asegurados. Lo
> guardamos cifrado y lo usamos solo para eso. No pedimos ni guardamos tu contraseña de
> Facebook ni de WhatsApp.
>
> **Cómo se borra.** Podés sacar ClaimMix de tu cuenta en cualquier momento desde la
> configuración de integraciones de tu negocio en Meta; con eso Meta nos avisa y borramos el
> acceso guardado y el PIN del número. También podés pedírselo a tu operador de ClaimMix. Al
> pedir el borrado te damos un código de confirmación. Los casos y mensajes de tus asegurados
> no se borran con este pedido: se rigen por la retención de tu contrato.

Revisar con el dueño antes de publicarlo: nombra la retención del contrato y el flujo de
aviso de Meta.

## Parte H — App propia del cliente

Segunda vía para conectar el número del agente, detrás de `ALTA_APP_PROPIA`, apagada por
omisión. El cliente arma en Meta su propia app, su usuario del sistema y su token, y nos
pasa cuatro datos: el App ID, el App Secret, el token y el ID de su cuenta de WhatsApp
(WABA ID). ClaimMix hace el resto por Graph, con el `appsecret_proof` en cada llamada. No
depende de que Veltra pase la verificación del negocio, la revisión de la app ni el alta de
Tech Provider (Parte G): cada cliente opera su propio negocio con Standard Access. Con la
bandera apagada todo anda como antes.

- **Qué hace falta para que la vía abra:** `ALTA_APP_PROPIA=1` más `NEXT_PUBLIC_SITE_URL`
  (https), `META_APP_ID`, `WHATSAPP_APP_SECRET` y `WHATSAPP_APP_SECRETS_KEY`. Si falta una,
  la vía queda cerrada y el servidor anota una vez por proceso `alta.app_propia_sin_config`
  con los **nombres** que faltan, nunca los valores. `ALTA_WABA_PROPIA` (Parte G) y
  `ALTA_APP_PROPIA` son banderas independientes: una fila viva sigue con la vía de su
  origen aunque la bandera del otro camino esté apagada.
- **Quién entra:** el admin de un espacio del alta automática, desde
  `/conectar-whatsapp/app`.
- **Quién no:** los clientes que ya están en la WABA de la plataforma o en Embedded Signup
  siguen ahí. Pasar a un cliente de la vía «app propia» a Embedded Signup implica mover el
  número a otra WABA: Meta no deja elegir después, en Embedded Signup, una cuenta creada
  desde una app de desarrollador.
- **Sin coexistencia** con la app de WhatsApp Business (exige ser Solution Partner o Tech
  Provider). **Solo celulares argentinos (+54).**
- **Riesgo de política.** Pedirle credenciales al cliente es zona gris en las Platform
  Terms de Meta (§6.a.iv). ClaimMix entra en la excepción solo si actúa como proveedor de
  servicios del cliente, con acuerdo escrito previo (§5.a). Por eso la bandera **no se
  prende en prd hasta que un abogado revise** el anexo, §6.a.iv, §5.a, la cláusula 4.1(b)
  de los Meta Terms for WhatsApp Business Platform y las plantillas de las páginas legales.
  En dev se prende solo con testers propios.

### Cómo lo ve el cliente

Una ventana previa (P0) y cuatro pasos. El progreso vive en el servidor: el cliente corta
cuando quiere y retoma en el paso de su fila; nada se guarda en el navegador.

1. **P0, antes de empezar.** Qué va a necesitar (ser admin de la empresa en Meta, un celular
   y una tarjeta para el medio de pago), la razón social como figura en ARCA, el CUIT, el
   número, y la casilla de aceptación del anexo de proveedor de servicios (versión
   `VERSION_DEL_ANEXO`, hoy `2026-10`). Crea la fila `armando`, la ruta del webhook de ese
   espacio y el identificador de sus páginas legales.
2. **Paso 1, tu app.** Crear la app en Meta y pegar App ID y App Secret (P1). ClaimMix los
   valida con una llamada propia, rechaza la app de la plataforma por App ID, y carga en la
   app los términos, la privacidad y el mail de contacto, **solo en los campos vacíos**, con
   las páginas legales que ClaimMix publica a nombre del cliente. Después, P1B: ícono (un
   PNG de 1024 × 1024 con las iniciales del espacio, que baja de la pantalla), categoría,
   propósito y URL de borrado de datos. Después, E14: la Callback URL y el verify token en
   «WhatsApp › Configuration» de la app del cliente. Es un paso normal mientras la
   incógnita I1 siga abierta; se salta solo si la suscripción por API anda y ClaimMix puede
   confirmarla sin pisar otro callback.
3. **Paso 2, tu número.** Sumarlo en Meta con «Add phone number» y el código del SMS (P2).
   La cuenta y el número de prueba de «Get started» no sirven: se frenan con
   `numero_distinto`.
4. **Paso 3, usuario del sistema y token.** Una ventana con tres bloques: crear (o reusar,
   porque no se pueden borrar) el usuario del sistema; asignarle la app y la cuenta de
   WhatsApp; generar el token y pegarlo junto con el WABA ID (P3). ClaimMix valida el
   token, sus permisos, que no traiga permisos de más y que el WABA ID sea de una cuenta que
   el token ve; suscribe la app a la cuenta, lee el número, pide el código si Meta no lo da
   por verificado, lo registra con un PIN generado en el servidor y lo deja `conectada`. Si
   el webhook de la app no verificó, no conecta (`webhook_pendiente`) y vuelve a E14.
5. **Paso 4, probar.** Medio de pago en WhatsApp Manager, «Live» si la app tiene ese
   interruptor (I40) y un «hola» desde un celular personal. La pantalla se pone verde
   recién cuando el agente responde (`primera_respuesta_en`). A los 2 minutos sin mensaje
   muestra qué revisar; con mensaje pero sin respuesta, la línea del medio de pago; a los
   10 minutos ofrece esperar otros 10.
6. **G, conectado.** App, recepción de mensajes, envío según Meta (`puede_enviar`), nombre
   visible, «Cargar la clave secreta nueva» y «Desconectar». «Desconectar» y la baja no
   miran ninguna bandera.

Las ventanas de excepción (E2 a E12) aparecen solo cuando el servidor las pide:
`elegir_numero`, `falta_codigo`, `falta_pin` (también un 131031 al registrar),
`numero_distinto`, `token_vencido` (el cliente pega un token nuevo), `secreto_invalido` (pega
el App Secret nuevo), `pago_pendiente`, `coexistencia`, `nombre_rechazado`, `esperar` y
`waba_restringida` o `waba_bloqueada`.

**Capturas.** W6 todavía no se hizo, así que no hay capturas en `public/conectar-whatsapp/app/`
(`p0`, `p1`, `p1b`, `e14`, `e14-campos`, `p2`, `p3-1`, `p3-2`, `p3-3` y `p4`, en `.webp`).
Sin captura la ventana sale sin imagen y los textos usan las etiquetas en inglés de la
consola de Meta, que son las que el cliente va a ver. Cuando se saquen, se copian ahí con
esos nombres y no hace falta tocar código.

### Antes de prenderlo (dueño, en este orden)

1. **W6, el ensayo manual** (pendiente). En dev, con un portfolio de prueba nuevo y el chip
   de repuesto. No escribe código: cierra las incógnitas de la tabla de abajo y ajusta los
   textos. Mientras no se haga, el código usa el respaldo de cada fila.
2. **Decisión sobre App Review (I7, Q35).** Si la app del cliente necesita App Review para
   pasar a «Live» o para los dos permisos de WhatsApp, la ventaja de esta vía cae (el cliente
   espera días y Meta revisa una app que en realidad opera ClaimMix) y **no se publica para
   autoalta**: queda como alta asistida, con el aviso `antes.revision` en P0. Hoy la vía está
   construida como si **no** hiciera falta, apagada. La decisión es del dueño, con lo que
   muestre W6.
3. **Abogado** (Q15). Revisa el anexo, las Platform Terms §6.a.iv y §5.a, la cláusula 4.1(b)
   y las plantillas `legal.*` de las páginas legales. Mientras tanto, nada en prd.
4. **Clave nueva.** Generar `WHATSAPP_APP_SECRETS_KEY` en la máquina del dueño, con 32 bytes
   al azar en base64:
   `node -e "console.log(require('crypto').randomBytes(32).toString('base64'))"`. Cargarla
   en Vercel, en dev y en prd por separado (`vercel env add WHATSAPP_APP_SECRETS_KEY`), cada
   ambiente con una distinta. **Guardar una copia fuera de Vercel**: perderla obliga a cada
   cliente a volver a pegar su secreto. Nunca va al repo (`.env.example` lleva solo el
   nombre).
5. **La 0051.** Es una sola, la misma de la Parte G: lleva las columnas de la app propia y el
   estado `armando` (se editó la 0051 en vez de sumar una 0052). Aplicarla **a mano**, con el
   dueño de la base, en las tres bases (paso 7 de la Parte G). Si alguna base ya tiene una
   versión anterior de la 0051, hay que reaplicar a mano lo que cambió. Sin ella,
   `/admin/altas` y la baja de un número fallan.
6. **Dev.** `ALTA_APP_PROPIA=1`. Hacer el asistente entero con la app de W6 y comprobar:
   - las tres páginas legales dan 404 antes de P1 y abren sin sesión después, con la razón
     social y `noindex`;
   - P1B dice «listos» si ClaimMix pudo cargar los datos, o muestra los tres valores;
   - E14: con la URL y el token copiados, Meta verifica y el panel sigue solo; con una
     segunda app que ya tiene otra Callback URL, el asistente no la pisa y muestra el aviso;
   - el estado llega a `conectada` y G muestra el número;
   - un «hola» desde un celular personal llega a la bandeja de dev; P4 se pone verde
     recién cuando el agente responde; sin mandar el «hola», a los 2 minutos aparece el
     diagnóstico;
   - la plantilla se crea y el perfil queda completo;
   - «Desconectar» borra el secreto y la ruta, la ruta da 404, y el texto pide borrar la
     Callback URL, revocar el token y cambiar la verificación en dos pasos;
   - la salud diaria corre y escribe `puede_enviar` desde `health_status`;
   - resetear el App Secret dispara el aviso `secreto_invalido`, y solo después de que Meta
     lo confirma;
   - una fila `armando` de más de 24 h recibe un solo recordatorio;
   - «Despublicar las páginas legales» en `/admin/altas` las deja en 404.
7. **Después del deploy de dev:** `pnpm check` completo.
8. **Prd.** La bandera sigue apagada hasta el visto bueno del abogado. Después, la variable y
   una promoción. Los primeros cinco clientes se hacen por videollamada.
9. **Marcha atrás:** `ALTA_APP_PROPIA=0`. Frena el alta nueva; los clientes conectados siguen
   enviando y recibiendo, porque la ruta del webhook y el envío no miran la bandera, y
   desconectar sigue andando.

### Qué mira el sistema solo

- **Cada mensaje entrante** llega a `/api/webhooks/whatsapp/app/<ruta>`, una ruta por espacio.
  Verifica la firma con el App Secret de ese espacio sobre los bytes exactos, antes de
  interpretar el cuerpo; una firma mala no cuesta nada (topes en memoria, caché de 30 s,
  y la base se toca una vez por hora por ruta solo para pedir la revisión del secreto). La
  ruta de la plataforma descarta los ids de las WABAs `app_propia`. El primer mensaje marca
  `primer_mensaje_en`.
- **Cada envío** lleva el `appsecret_proof` y, con el primer `wamid` aceptado, marca
  `primera_respuesta_en`. Ante un error de Graph, solo en filas `app_propia`:
  - **190** (token): el mensaje no sale, cae al correo y avisa `token_vencido`;
  - **131042** (pago): avisa `pago_pendiente`; si es la primera respuesta, además abre la
    ventana de pago en P4;
  - **368** (cuenta restringida): `waba_restringida`;
  - **131031** (cuenta bloqueada): ante cualquier 131031, en segundo plano, se lee
    `health_status` de la WABA, y solo con `BLOCKED` pasa a `waba_bloqueada`. Un 131031 al
    registrar el número o al poner el PIN no es esto: es `falta_pin`.
  
  En Embedded Signup y en la WABA de la plataforma, 368, 131031 y 131042 solo quedan en el
  registro `whatsapp.messenger.send_failed`: ahí no hay cliente a quien avisarle.
- **Eventos de cuenta** (`account_update`, `account_review_update` y
  `phone_number_name_update`, por la ruta firmada del espacio): revocación o desvinculación
  (se confirma con `debug_token` antes de darla por buena), restricción o sanción
  (`waba_restringida`), nombre aprobado o rechazado. Un evento viejo se ignora por su
  `hora`. `business_capability_update` y los eventos de plantillas no se suscriben.
- **Una vez al día**, dentro de `/api/cron/reap-stuck` (`revisarWabas`, 20 s de presupuesto
  más la llamada en curso, 50 WABAs al azar por vuelta, de mejor esfuerzo; corre solo si
  quedan 40 s del tiempo de la tarea). Para cada fila `app_propia` en `conectada` (o en
  `falla` por `nombre_rechazado`):
  1. el token y el secreto: si Meta rechaza el App Secret y también la confirmación, la
     fila pasa a `falla` con `secreto_invalido` y avisa; si el token dejó de valer o perdió
     un permiso (también si dejó de ver la WABA), pasa a `falla` con `token_vencido` y avisa;
  2. `health_status` del número: escribe `puede_enviar`; `BLOCKED` avisa
     `waba_bloqueada`, `LIMITED` solo se muestra;
  3. el nombre visible, en las filas con el nombre en revisión o rechazado (respaldo del
     evento): con el nombre aprobado, registra el número;
  4. la plantilla `reabrir_denuncia`, si falta;
  5. los recordatorios (abajo). El aviso `waba_huerfana` de 48 h sigue siendo solo de Embedded Signup: una fila `armando` no tiene `waba_id` y no entra.
- **Recordatorio al cliente.** Una fila `armando` con más de 24 h sin avanzar recibe **un**
  mail, una sola vez, con el paso en que quedó (cargar las claves, pegar la dirección del
  webhook o pegar el token) y el enlace para seguir. El mail sale con el remitente del
  sistema; sin remitente cargado no sale y la fila no se marca, así que se reintenta al otro
  día. Sin la 0051 se saltea. Al operador le llega el aviso `recordatorio`.

### Qué hace el operador

Todo desde `/admin/altas`, columna «WhatsApp propio» de cada espacio. Para una fila de la app
propia muestra además del estado, la falla, la WABA y el nombre del número:

| Campo | Qué dice |
|---|---|
| Origen | «App de Meta propia del cliente» (la WABA propia de Embedded Signup y la de la plataforma tienen el suyo) |
| App ID | El de la app del cliente. **Nunca** se muestran el secreto, el token, el PIN ni la ruta del webhook |
| Webhook de la app | Verificado por Meta, o sin verificar |
| Datos de la app | Si ClaimMix cargó términos, privacidad y mail de contacto |
| Páginas legales | Publicadas o despublicadas, con su botón |
| Primer mensaje recibido / Primera respuesta enviada | Los dos hitos de la prueba; «Todavía no» si faltan |
| Puede enviar (según Meta) | Sí, Limitado o Bloqueado, de la salud diaria; vacío si todavía no se midió |
| Recordatorio de alta a medias | Cuándo se le mandó el mail de las 24 h |

Botones:

- **«Reintentar la conexión»** retoma `continuarWaba` con el token guardado. No aparece en
  filas `armando`: ahí el cliente no terminó de pasar los datos y nada para reintentar.
- **«Desvincular la WABA»** borra el token, el PIN, el secreto y la ruta, da de baja el
  número y suelta la app en Meta. Anda también con la bandera apagada y con una fila
  `armando`. Ver «Desconectar» abajo.
- **«Despublicar las páginas legales»** (con casilla de confirmación): pone el identificador
  de las páginas en `NULL`, sus tres direcciones pasan a 404, y deja una entrada de
  auditoría. No toca el estado, el token ni el secreto: el cliente sigue conectado. La app
  de Meta del cliente **sigue apuntando a las direcciones viejas** hasta que las cambie, y
  Meta puede objetar una app sin términos o sin privacidad. Si el cliente vuelve a P0 se crea
  un identificador nuevo. Sirve si el contenido de las páginas resultó un problema legal, o
  si el cliente pide sacarlas.
- **«Dar de baja el número»** y **conectar a mano** siguen como en la Parte G; conectar a
  mano es solo sobre la WABA de la plataforma y no se ofrece para una fila `armando`.

**Desconectar** (el cliente desde G, el operador desde `/admin/altas`, o una revocación
confirmada). Es una sentencia: la fila viva del número pasa a `baja` sin token y la de la
WABA a `revocada` sin PIN, secreto, ruta ni verificación. Desde ahí la ruta da 404 (hasta 30
s por la caché; la firma ya no verifica porque el secreto no se lee). Después, con el token
en memoria y sin deshacer la baja si falla: se da de baja el número en la API de WhatsApp
(`deregister`) y se desuscribe la app. El token del usuario del sistema **no se revoca por
API** (la ruta documentada no dice con qué token se autoriza, I26): el cliente tiene que
hacerlo, y el texto de confirmación se lo pide junto con borrar la Callback URL, cambiar o
desactivar la verificación en dos pasos del número (el PIN lo generamos nosotros) y,
si quiere, cambiar el App Secret con «Reset». Los casos del cliente quedan mientras dure la
relación con ClaimMix; se borran cuando termina, no al desconectar el número.

Avisos nuevos de esta vía (`aviso-operador.ts`; un mail por espacio y por día):

| Motivo | Qué pasó | Qué hacer |
|---|---|---|
| `secreto_invalido` | Meta ya no acepta el App Secret (se confirmó con una llamada propia): el cliente lo cambió. El espacio sigue conectado | Pedirle que pegue el secreto nuevo en `/conectar-whatsapp/app` («Cargar la clave secreta nueva»). Mientras tanto no llegan los mensajes nuevos: los que Meta reintente entran cuando se actualice |
| `token_vencido` | Graph dijo 190 en un envío, o el token ya no sirve o ya no alcanza la WABA | Reintentar no sirve: el cliente pega un token nuevo en la ventana de token. Si el número seguía conectado, «Desvincular la WABA» y que vuelva a empezar |
| `waba_restringida` | Graph dijo 368, o `account_review_update` fue rechazado | Lo resuelve el cliente en WhatsApp Manager; ClaimMix no puede apelar por él |
| `waba_bloqueada` | 131031 confirmado con `health_status = BLOCKED`, o la salud diaria dio `BLOCKED` | El cliente escribe al soporte de Meta desde WhatsApp Manager |
| `pago_pendiente` | 131042 en un envío o en la primera respuesta | El cliente carga o revisa el medio de pago en WhatsApp Manager y manda otro «hola» |
| `revocada` | El cliente sacó la app o Meta anuló el acceso (confirmado con `debug_token`) | En esta vía el aviso suma la línea de la verificación en dos pasos: decirle al cliente que cambie o desactive el PIN |
| `baja_fallida` | Al desconectar, Meta no dio de baja el número: sigue registrado en la API de WhatsApp y el cliente no puede usarlo en la app del celular | El código está en el registro `whatsapp.alta_numero.graph`. Darlo de baja a mano o avisarle al cliente. Un rechazo por espera no se reintenta solo |
| `recordatorio` | Se le mandó el recordatorio a un espacio que dejó el alta a medias hace más de 24 h | Nada. Si el cliente no vuelve, la fila queda en «Armando la app» y se limpia a mano (abajo) |

**Filas `armando` huérfanas.** Una fila que quedó en `armando` mucho tiempo no hace daño por sí
sola (no tiene token ni WABA), pero sus páginas legales siguen publicadas porque la app del
cliente ya apunta ahí. Para limpiarla: «Desvincular la WABA» la pasa a `revocada` y borra el
secreto y la ruta, y si hace falta, «Despublicar las páginas legales». Si el cliente vuelve,
P0 reusa o rehace la fila.

**La ruta por inquilino.** Es un valor al azar de 16 bytes en base64url, por espacio, que
identifica pero **no autentica** (autentica la firma con el App Secret). Aparece en los
logs de acceso de Vercel; en Sentry se reemplaza por `:ruta`. Si se filtra, no hay nada que
rotar a mano: «Desvincular la WABA» la borra, y al volver a conectar se arma una nueva.

### Secretos y rotación

| Secreto | Dónde vive | Cifrado |
|---|---|---|
| Token del usuario del sistema | `whatsapp_numeros.token_cifrado` | Clave de Gmail, AAD `wa:<tenantId>:<wabaId>` |
| PIN de dos pasos | `whatsapp_wabas.pin_cifrado` | Clave de Gmail, AAD `wa-pin:<tenantId>:<wabaId>` |
| App Secret | `whatsapp_wabas.app_secreto_cifrado` | Sobre `v2.wa1.…` con `WHATSAPP_APP_SECRETS_KEY`, AAD `wa-secreto:<tenantId>:<appId>` |
| `appsecret_proof` y verify token | no se guardan | Se calculan por llamada |

El App Secret tiene una clave aparte porque le da a quien lo tiene la app entera del cliente,
no solo un número. Un sobre copiado a otra fila, a otro espacio o a otra app no abre.
**Rotar el token:** lo pega el cliente en la ventana de token cuando el que hay deja de
servir; no se le pide revocar el viejo (no sabemos si generar uno nuevo invalida los
anteriores, I12). **Rotar el App Secret:** lo cambia un administrador de la app con «Reset»
en «App settings › Basic»; las firmas fallan, Meta lo confirma y la fila pasa a
`secreto_invalido`. **Rotar `WHATSAPP_APP_SECRETS_KEY`:** se suma `wa2` con otra variable
(el `kid` va en el sobre); cada secreto se vuelve a cifrar con `wa2` en su próximo guardado, y
`wa1` se saca solo cuando no queda ningún sobre `wa1`. **`BETTER_AUTH_SECRET`:** al rotarlo
cambia el verify token derivado; los webhooks ya verificados siguen, y si el cliente vuelve
a guardar la Callback URL en Meta, E14 le muestra el valor nuevo.

Riesgos que quedan: un volcado de la base **y** de las variables de Vercel juntos abre todos
los secretos; el token y el PIN siguen con la clave de Gmail; el cliente puede fabricar
webhooks válidos, pero solo para su propio espacio (el costo de IA lo acotan los topes por
espacio); un token que el cliente generó y ClaimMix rechazó sigue activo hasta que el cliente
lo revoque.

### Incógnitas de W6 (el dueño las cierra con el ensayo)

Ninguna página de Meta contesta estas preguntas; el ensayo manual sí. Hasta entonces el
código hace lo de la columna «Mientras no se cierre». Cuando se cierre una, se anota acá la
respuesta y se ajusta lo que diga la columna.

| # | Qué hay que mirar | Mientras no se cierre |
|---|---|---|
| I1 | Si `POST /{app-id}/subscriptions` acepta `object=whatsapp_business_account` y si el GET lo lista con su `callback_url` | `GET_LISTA_WHATSAPP` queda en `false`: el callback es `desconocido`, no hay POST automático y E14 es un paso normal |
| I3 | Si `granular_scopes` de `debug_token` lista los ids de la cuenta para un token de usuario del sistema | `wabaIds` es `null` y el WABA ID que pega el cliente se comprueba al recorrer la WABA |
| I4 | Qué `expires_at` devuelve un token que no vence y qué error da un app token con secreto malo | Se ajustan `token_temporal` y `app_invalida` |
| I6 | Si «Reset» invalida el secreto viejo al instante, si invalida el token del usuario del sistema y si los reintentos de Meta se vuelven a firmar | Se ajustan el texto de `secreto_invalido` y el de G |
| I7 | **Si hace falta App Review para pasar a Live o para los permisos con Standard Access** | **Decide si se sigue.** Con App Review, la vía no se publica para autoalta (alta asistida y `antes.revision` en P0) |
| I8 | Si una app en Development puede enviar y qué webhooks recibe | Los textos de «Live» quedan condicionales (I40) |
| I9 | Si el Data Use Checkup anual aplica a la app del cliente y qué pasa si no se completa | Se suma un aviso anual |
| I10 | Si hay un endpoint para saber si la cuenta tiene medio de pago | La línea de P4 sigue informativa; el 131042 abre la ventana de pago |
| I11 | Si Meta corta los mensajes de servicio sin medio de pago más allá del 131042, y las tarifas en ARS (las dos páginas de precios se contradicen) | No se le promete nada al cliente |
| I12 | Qué invalida el token del usuario del sistema además de quitar la app | Se ajusta el texto de `token_vencido` |
| I14 | Si Meta exige Business Verification para hablar con terceros | Se suma a P0 |
| I15 | Los pasos reales de la interfaz y si «API Setup» crea la cuenta de WhatsApp sin sumar un número | Se ajustan los textos de P2 |
| I16 | El cupo de usuarios del sistema (1, y 1 admin con Standard Access) y si un cliente que gastó el cupo puede crear otro | P3 ya pide reusar el que hay |
| I17 | La postura de Meta ante un ISV que opera a escala con apps de sus clientes sin ser Tech Provider | Riesgo de política (arriba) |
| I18 | Si «sólo para ti» (§5.a.i) permite un proveedor con muchos clientes aislados | Lo resuelve el abogado (Q15) |
| I20 | El código de error de Graph para un número ya activo en WhatsApp, al registrarlo | Cae en el rechazo genérico `meta` hasta sumarlo a `motivoDeAlta` |
| I21 | El nombre exacto del campo `is_on_biz_app` | La coexistencia se detecta por `platform_type` |
| I22 | Los tiempos de restricción y de apelación de un portfolio | No se le dan plazos al cliente |
| I23 | Si `POST /{waba-id}/phone_numbers` anda con Standard Access | La vía no lo usa; solo cuenta si se quiere sumar el número por API |
| I24 | En la evolución del modelo de cuentas (WAAC, fase 2): si hay que regenerar los tokens y qué permisos se suman. La fase 3 (primer semestre de 2028) cambia las rutas por id del número | La salud diaria abre la ventana de token si faltan permisos; antes de la fase 3 hay que cambiar `messenger.ts`, `alta-de-numero.ts` y la lectura de salud |
| I26 | De dónde sale el id para `DELETE /{app-scoped-system-user-id}/access_tokens` y con qué token se autoriza | El texto de desconectar le pide al cliente revocar el token |
| I27 | El formato y el largo de `hub.challenge` | W6 anota uno y se ajusta la regex de la ruta |
| I28 | Si la URL de borrado de datos se puede cargar por API | El cliente la copia en P1B |
| I29 | Si Meta acepta páginas legales con dominio de ClaimMix en la app del cliente | Un texto le dice dónde pegar las direcciones de su propia web, sin acción del servidor |
| I30 | El límite de `deregister` y si comparte el de `register` | Un rechazo por espera se anota, no se reintenta y sale `baja_fallida` |
| I31 | Si la Resumable Upload API anda con el token del cliente para la foto del perfil | La foto es manual |
| I32 | Los enlaces profundos a pantallas de una app y de «System users» | Se usa el enlace general |
| I33 | Si el token trae alcances implícitos que el cliente no marcó | Lista de tolerados, cada uno con su fuente |
| I34 | Los hosts de las URLs de media, además de `lookaside.fbsbx.com` | Se agrega a `WHATSAPP_MEDIA_HOSTS` (lista separada por comas, sin deploy de código); hasta entonces otro host se anota (`whatsapp.media_host_no_permitido`, sólo el host) y se rechaza. Una redirección del CDN vale si va a un host permitido, un solo salto |
| I35 | Si «WhatsApp › Configuration» deja guardar el webhook antes de que exista la cuenta de WhatsApp | E14 pasa a después del paso 3 |
| I36 | Cómo distinguir por Graph la cuenta y el número de prueba de «Get started», y con qué nombre los muestra Meta | P2, P3 y la ventana de número distinto lo dicen en texto; `numero_distinto` frena el número de prueba |
| I37 | Si el app token lee y escribe `terms_of_service_url`, `privacy_policy_url` y `contact_email` del nodo Application | P1B muestra los tres valores con Copiar |
| I38 | Qué falla con «Require App Secret» prendido: el envío, la descarga de media o el GET al CDN | Se suma el proof donde falte; el CDN queda con Bearer |
| I39 | Si «Show» del App Secret pide la contraseña de Facebook | Aparece la línea `claves.reauth` |
| I40 | Si la app del caso de uso de WhatsApp tiene el interruptor de modo, y qué webhooks llegan en Development | Los textos de «Live» de P1B y P4 son condicionales |
| I41 | Dónde se carga el medio de pago para una app propia y qué pasa exactamente sin él | `final.pago` dice «puede rechazar» |
| I42 | El código del 403 al pasar el tope de 2 números por portfolio | `cuenta.tope` queda como texto general |

Retiradas o cerradas: I2 y I25 (no hay override del webhook de la WABA; pasa a una versión
futura), I5 (el proof va siempre), I13 (la coexistencia exige Solution Partner o Tech
Provider: sigue afuera), I19 (confirmada: una cuenta creada desde una app de desarrollador
no se puede elegir después en Embedded Signup).

### Texto de términos, privacidad y anexo (pendiente del dueño)

`src/app/terms/page.tsx` y `src/app/privacy/page.tsx` **no se tocan desde el código**. Las
páginas que ClaimMix publica a nombre de cada cliente (`/legal/<identificador>/terminos`,
`/privacidad` y `/borrado`) usan las plantillas `legal.*` del diccionario del servidor y
también esperan al abogado. Lo que falta, para que lo pegue el dueño:

**Anexo de proveedor de servicios — `/terms#app-propia`** (versión `2026-10`; la casilla de P0
apunta a esta ancla):

> **Anexo de proveedor de servicios — WhatsApp con tu propia app de Meta.**
>
> **Qué hacemos.** Cuando conectás tu número con tu propia app de Meta, ClaimMix actúa como
> tu proveedor de servicios y trabaja solo para vos. Usamos el App ID, el App Secret, el
> token de acceso y el ID de tu cuenta de WhatsApp únicamente para recibir y enviar, en tu
> nombre, los mensajes de tus asegurados, y para publicar a tu nombre los términos, la
> política de privacidad y la página de borrado de datos que Meta le pide a tu app. Los
> guardamos cifrados y no los usamos para nada más ni los compartimos.
>
> **Subencargados.** Para leer y ordenar los mensajes, ClaimMix usa Google (Vertex AI y
> Gemini) como subencargado, atado por contrato a las mismas condiciones. Los datos de
> WhatsApp no se usan para crear, entrenar ni mejorar modelos de inteligencia artificial,
> salvo un ajuste fino exclusivo para tu negocio.
>
> **Qué respondés vos ante Meta.** La app y la cuenta de WhatsApp son tuyas. Ante Meta
> respondés vos: si restringe o bloquea la cuenta, o cambia sus reglas, lo resolvés con Meta;
> ClaimMix no puede apelar por vos.
>
> **Qué cobra Meta.** Meta le factura los mensajes a tu cuenta, según sus tarifas vigentes
> (https://developers.facebook.com/documentation/business-messaging/whatsapp/pricing y
> https://developers.facebook.com/documentation/business-messaging/whatsapp/pricing/non-template-messages).
> ClaimMix no te garantiza ninguna tarifa. Sin un medio de pago cargado en WhatsApp Manager,
> Meta puede rechazar los mensajes del agente.
>
> **Cuando desconectás.** Dejamos de atender tu número, lo damos de baja en la API de
> WhatsApp y borramos el token, el App Secret y el PIN. Tus casos quedan mientras dure tu
> relación con ClaimMix y se borran cuando termina. Después, en Meta, te corresponde borrar
> la Callback URL de tu app, revocar el token en «System users» y cambiar o desactivar la
> verificación en dos pasos del número.
>
> **Si más adelante querés pasar a «Conectar con Facebook».** Meta no deja elegir, en ese
> flujo, una cuenta creada desde una app de desarrollador: hay que mover el número a otra
> cuenta.

**Sección de privacidad — `/privacy`:**

> **Credenciales de WhatsApp con tu propia app.** Cuando conectás tu número con tu propia app
> de Meta, guardamos cifrados el App ID, el App Secret, el token de acceso y el ID de tu cuenta
> de WhatsApp. Los usamos solo para atender tu número en tu nombre. Los borramos cuando
> desconectás el número, o antes si nos lo pedís. ClaimMix publica a tu nombre, en direcciones
> propias de cada cliente y fuera de los buscadores, los términos, la política de privacidad y
> la página de borrado de datos que Meta le pide a tu app, con la razón social, el CUIT y el
> mail de contacto que nos diste; podés pedir que las despublique tu operador de ClaimMix.

Revisar con el dueño y el abogado antes de publicarlo: nombra a Google como subencargado, la
retención de los casos hasta el fin de la relación, la responsabilidad ante Meta y las
tarifas. El inglés lo traduce el abogado junto con el texto. Después de publicar el anexo,
hay que cambiar `VERSION_DEL_ANEXO` (`src/server/alta/waba-resultados.ts`) si el texto cambió
de fondo: la versión que el cliente aceptó queda en `acuerdo_version`.
