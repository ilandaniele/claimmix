# Entrega al sistema central (B5)

ClaimMix entrega los casos al sistema de la aseguradora por dos caminos, que se
usan juntos o por separado:

- **Webhook firmado (push).** ClaimMix manda el caso a una URL de la aseguradora.
- **API de lectura (pull).** El sistema de la aseguradora lee los casos de `/api/v1` con una clave.

Las dos se configuran en **Configuración → Entrega al sistema central**. Sólo un
administrador ve esa sección.

> **Datos personales.** El payload y la API llevan datos personales del
> asegurado: nombre, número de póliza, la descripción del siniestro y todo lo
> que la IA extrajo del caso. Tratá el endpoint, el secreto y la clave con el
> mismo cuidado que la base de siniestros.

La migración `neon/migrations/0036_entrega_al_core.sql` crea la tabla
`core_sync_settings`. Sin ella, la sección muestra un aviso y nada se envía.

## 1. El webhook

### Cuándo se manda

Se manda un caso por pedido. Un especialista o un administrador aprieta **Enviar al
sistema central** en un caso en `listo_para_core`, o **Reintentar** en uno en
`error_core`. No hay envío automático ni cola de reintentos.

| Respuesta del sistema central | Estado del caso | Lo que queda |
|---|---|---|
| 2xx | `enviado_a_core` | `core_external_id` = el `id` de la respuesta, si vino |
| cualquier otra, o ninguna | `error_core` | `core_error_message` = un código fijo (abajo) |

Vale para los casos de cualquier canal. Sin URL, sin secreto o con el envío
apagado, el botón no aparece y el caso sale a mano, como antes de B5. Tampoco
aparece en un caso simulado o de prueba: esos no se mandan, igual que en
`/api/v1` (ver abajo).

### Qué se manda

`POST` a la URL configurada, con `Content-Type: application/json`:

```json
{
  "caseId": "6f1c…",
  "tenantId": "a3b0…",
  "claimType": "choque",
  "severity": "medium",
  "customerName": "…",
  "policyNumber": "…",
  "accidentDate": "…",
  "accidentDescription": "…",
  "extractedFields": { "full_name": "…", "policy_number": "…" },
  "updatedAt": "2026-09-28T14:03:11.123456Z"
}
```

El botón **Probar envío** manda un payload sintético con `"prueba": true`,
`claimType: "prueba"` y un `caseId` al azar. No corresponde a ningún caso:
descartalo.

### Encabezados

| Encabezado | Valor |
|---|---|
| `X-ClaimMix-Signature` | `t=<unix>,v1=<hex>`: HMAC-SHA256 con el secreto, sobre `<unix>.<body crudo>` |
| `X-ClaimMix-Timestamp` | el mismo `<unix>`, en segundos |
| `Idempotency-Key` | el `caseId`: el mismo caso trae siempre la misma clave |
| `X-ClaimMix-Event-Id` | `<caseId>:<updatedAt>`: cambia cuando el caso cambia |
| `User-Agent` | `ClaimMix-Core-Sync/1` |

### Verificar la firma

Copiá [`verificar-firma.mjs`](./verificar-firma.mjs) tal cual. Es Node puro, sin
dependencias, y los tests de ClaimMix lo usan: si la firma cambia, el archivo
cambia con ella.

La firma se calcula sobre el cuerpo **crudo**. Verificala antes de `JSON.parse`:
un JSON re-serializado no da los mismos bytes.

```js
import express from "express";
import { verificarFirma } from "./verificar-firma.mjs";

const app = express();

app.post("/claimmix", express.raw({ type: "application/json" }), (req, res) => {
  const valida = verificarFirma({
    secreto: process.env.CLAIMMIX_SIGNING_SECRET,
    encabezado: req.get("X-ClaimMix-Signature"),
    body: req.body, // Buffer, gracias a express.raw
  });
  if (!valida) return res.sendStatus(401);

  const caso = JSON.parse(req.body.toString("utf8"));
  if (caso.prueba) return res.status(200).json({ id: "prueba" });

  // Deduplicá por caso.caseId (el caso) y caso.updatedAt (la versión): van firmados.
  const id = guardarSiniestro(caso, caso.caseId);
  res.status(200).json({ id });
});
```

`verificarFirma` devuelve `true` o `false` y nunca tira. Rechaza:

- un encabezado mal formado;
- un `t` a más de **5 minutos** del reloj del receptor, en cualquier dirección (un pedido viejo reenviado);
- una firma que no corresponde al cuerpo o al secreto.

### Deduplicación

Un reintento desde `error_core` puede llegar después de que el sistema central
ya guardó el caso: por ejemplo, si guardó y la respuesta no llegó a tiempo.

- `caseId` del cuerpo identifica el caso. Si ya lo tenés, respondé 2xx con el mismo `id`.
- `updatedAt` del cuerpo distingue versiones del mismo caso.
- `Idempotency-Key` (el `caseId`) y `X-ClaimMix-Event-Id` (`caseId:updatedAt`)
  repiten esos datos para un proxy o un log, pero **no van firmados**: quien
  tenga una copia del pedido puede cambiarlos sin romper la firma. Deduplicá
  siempre por el cuerpo.

### Qué responder

- **2xx** es entregado. Un cuerpo JSON con `id` (o `external_id`), de hasta 200
  caracteres, queda como `core_external_id`. Sin cuerpo o sin `id` también es
  entregado, sin id.
- Cualquier otra respuesta es un fallo. El cuerpo nunca se guarda ni se muestra.
- ClaimMix **no sigue redirecciones**. Un 3xx es el fallo `redireccion`.

### Reglas del destino

- `https`, en el puerto **443**, con un nombre de host. No se aceptan IPs
  literales, otro puerto ni usuario y contraseña en la URL.
- El nombre tiene que resolver sólo a direcciones públicas. Una red privada,
  loopback, link-local, CGNAT, la metadata de la nube o un prefijo de
  traducción dan `destino_rechazado`.
- ClaimMix se conecta a la IP que validó, con el nombre en SNI y en `Host`.
- Plazo total: **10 segundos**, incluida la resolución DNS.

Los códigos de fallo que quedan en `core_error_message`:

| Código | Qué pasó |
|---|---|
| `timeout` | no hubo respuesta en 10 s |
| `red` | no se pudo resolver o conectar |
| `destino_rechazado` | la URL o su IP no cumplen las reglas de arriba |
| `redireccion` | respondió 3xx |
| `http_<n>` | respondió otro código, por ejemplo `http_500` |

### Rotar el secreto

**Rotar secreto** genera uno nuevo y lo muestra **una sola vez**. El anterior
deja de servir en el acto. En la base queda cifrado (AES-256-GCM) y nunca se
vuelve a mostrar.

## 2. La API de lectura: `/api/v1`

### La clave

```
Authorization: Bearer cmk_<tenant-id>_<43 caracteres base64url>
```

- **Crear clave** o **Rotar clave** la muestra una sola vez. En la base queda
  sólo su SHA-256 y los primeros 8 caracteres de la parte al azar, para
  reconocerla en pantalla.
- Rotar invalida la anterior en el acto. **Revocar clave** la borra: la API
  deja de responder hasta crear otra.
- Una clave mal formada, inventada o revocada da `401` con
  `WWW-Authenticate: Bearer`.

### Cupo

120 pedidos por minuto por IP. Pasado el cupo, `429` con `Retry-After` en
segundos.

Todas las respuestas llevan `Cache-Control: no-store`.

### `GET /api/v1/cases`

Los casos reales de la aseguradora, paginados. Cada fila trae `case_id`,
`policy_number`, `policyholder_name`, `claim_type`, `status`, `confidence_min`
(un número en texto), `channel`, `created_at`, `updated_at` y `closed_at`.
Las fechas van en ISO 8601, en UTC y con microsegundos
(`2026-09-28T14:03:11.123456Z`).

No salen los casos simulados (`email_sim`, `whatsapp_sim`) ni los de prueba:
los que escribió un remitente reservado (`@example.com`, `.org`, `.net`, o un
número `5490000…`).

| Parámetro | Qué hace |
|---|---|
| `status` | uno de los estados del caso, por ejemplo `listo_para_core` |
| `updated_since` | ISO 8601 con zona: casos cuyo último cambio es igual o posterior |
| `cursor` | el `next_cursor` de la respuesta anterior |
| `per_page` | de 1 a 100; 25 por defecto |

El último cambio es `updated_at`, o `created_at` si el caso nunca se modificó.
El orden es por último cambio, del más viejo al más nuevo, y después por id.
Un caso aparece recién **dos minutos** después de su último cambio: así una
escritura lenta no queda detrás de lo que ya leíste.

Para leer sólo lo nuevo, guardá `next_cursor` y pasalo la vez siguiente, con el
mismo `status` si filtrás. Un caso que cambia después vuelve a aparecer más
adelante; ninguno queda salteado. Si no hay nada nuevo, `next_cursor` es el
mismo que mandaste. `has_more` dice si ya hay otra página para pedir ahora.
`updated_since` sirve para el primer pedido; después alcanza con el cursor.

```json
{
  "data": [{ "case_id": "…", "status": "listo_para_core", "updated_at": "2026-09-28T14:03:11.123456Z" }],
  "meta": { "per_page": 25, "has_more": true, "next_cursor": "…" }
}
```

```sh
curl -H "Authorization: Bearer $CLAIMMIX_KEY"   "https://claimmix.vercel.app/api/v1/cases?status=listo_para_core&updated_since=2026-09-01T00:00:00Z&per_page=100"
curl -H "Authorization: Bearer $CLAIMMIX_KEY"   "https://claimmix.vercel.app/api/v1/cases?status=listo_para_core&per_page=100&cursor=$NEXT_CURSOR"
```

### `GET /api/v1/cases/:id`

Un caso con las mismas columnas que el listado, más:

- `extracted_fields`: `[{ field_key, field_value, confidence }]`
- `missing_docs`: `[{ doc_key, requested_at, satisfied_at, declined_at, declined_note }]`
- `exported_at`: la hora del pedido

Un id de otra aseguradora, o de un caso simulado o de prueba, da `404`, igual
que uno que no existe.

```sh
curl -H "Authorization: Bearer $CLAIMMIX_KEY"   "https://claimmix.vercel.app/api/v1/cases/6f1c…"
```

### Errores

```json
{ "error": { "code": "INVALID_CREDENTIALS", "message": "…" } }
```

| Estado | Cuándo |
|---|---|
| 400 | un parámetro inválido (`VALIDATION_FAILED`) |
| 401 | sin clave, clave mal formada, inventada o revocada |
| 404 | el caso no existe, es de otra aseguradora o es simulado o de prueba |
| 429 | se pasó el cupo |
