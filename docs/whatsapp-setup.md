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
