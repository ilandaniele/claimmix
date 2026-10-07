# Seguridad y cumplimiento: respuestas para una aseguradora (CAIQ-lite)

_Actualizado el 2026-09-30 (B19). Contacto para cualquier pregunta sobre este
documento: ilan.daniele@gmail.com._

Este documento contesta lo que una aseguradora suele preguntar antes de
contratar, con el formato de los cuestionarios CAIQ / SIG-lite: pregunta,
respuesta y dónde se comprueba. Dice lo que hay, y dice lo que todavía no hay.

Reglas con las que se escribió:

- Lo que no se pudo verificar desde el código o desde un ensayo dice
  **a verificar**. No se rellena con lo que sería razonable.
- Una deuda se escribe tal cual, con su consecuencia. Está en la sección 11.
- **ClaimMix no tiene certificación SOC 2 ni ISO 27001, ni un pen test
  externo.** Lo que sí tiene es un conjunto de controles que se ejecutan solos
  en cada cambio y se pueden correr sobre pedido (sección 12).

## 1. Dónde viven los datos

| Componente | Qué guarda | Región | Evidencia |
|---|---|---|---|
| Vercel | la aplicación y los cron | `gru1` (São Paulo) | `vercel.json` (`regions: ["gru1"]`) |
| Neon (Postgres) | casos, mensajes, padrón, auditoría, configuración | la rama de ensayo de Veltra está en `sa-east-1`; la de producción (`ep-proud-resonance`): **a verificar** | host de la conexión de ensayo; producción no se verificó |
| Cloudflare R2 | fotos de daños, licencias, cédulas | `region: "auto"` en el cliente; ubicación del balde: **a verificar** | `src/server/storage/claim-attachments-bucket.ts` |
| Google Vertex AI (Gemini) | el texto y las fotos de cada denuncia, sólo para extraer campos | `us-central1` | `GOOGLE_CLOUD_LOCATION`; el dueño rechazó la región `global` |
| Meta (WhatsApp Cloud API) | el número de teléfono y los mensajes del canal de WhatsApp | definida por Meta | sección 8 |

La política de privacidad pública dice «Estados Unidos» para Neon y R2. Con lo
de arriba, eso puede estar desactualizado para Neon. Ver el texto propuesto en
la sección 13.

## 2. Cifrado

| Pregunta | Respuesta | Evidencia |
|---|---|---|
| ¿Cifrado en tránsito? | TLS en todo el tráfico público (Vercel). HSTS de dos años con `includeSubDomains; preload`. La conexión a Neon y a R2 es por TLS. | `src/proxy.ts`; `ssl` sin `rejectUnauthorized: false` desde #181 |
| ¿Cifrado en reposo de la base y de los adjuntos? | Lo provee el proveedor (Neon, Cloudflare R2). Es cifrado de disco, no una clave nuestra. Detalle del proveedor: **a verificar** en su documentación vigente. | no hay código nuestro que lo pruebe |
| ¿Se cifran campos sensibles con una clave propia? | Sí, los secretos que guardamos por inquilino: el refresh token de Gmail, las claves de IA, el secreto de firma del webhook al Core y el secreto del IdP del SSO. `aes-256-gcm`, IV de 12 bytes, etiqueta de 16 bytes fijada al cifrar y al descifrar (una etiqueta más corta se rechaza antes de descifrar). | `src/lib/security/cifrado.ts` |
| ¿Quién tiene la clave? | Una sola clave para todos los inquilinos, derivada de `GMAIL_TOKEN_ENCRYPTION_KEY`. **No hay una clave por inquilino.** | ídem |
| ¿Cómo se guardan las contraseñas? | Hash `scrypt` de Better Auth (no bcrypt). | `node_modules/better-auth/dist/crypto/password.mjs` |
| ¿Los tokens OAuth de Google? | Se guardan cifrados y ya no se piden refresh tokens. | #181 |

## 3. Aislamiento entre inquilinos

| Pregunta | Respuesta | Evidencia |
|---|---|---|
| ¿Cómo se separan los datos de dos aseguradoras? | Dos defensas independientes. La capa de datos abre una transacción por inquilino (`enTenant`, `enTenantVarias`) y cada consulta filtra por `tenant_id`. Debajo, Postgres aplica `ROW LEVEL SECURITY` con `FORCE` en todas las tablas con `tenant_id`. | `src/data/scope.ts`; migración `0018` |
| ¿Puede la aplicación saltarse la RLS? | No con el rol de la aplicación: `claimmix_app` no tiene `BYPASSRLS`, y la capa se planta si le dan un rol que saltea. | `pnpm permisos`, `pnpm tenancy` |
| ¿Quién usa entonces el rol dueño? | Sólo los barridos de sistema (cron, migraciones, scripts), y cada consulta dueña lleva `// sin-inquilino:` con el motivo. `pnpm arquitectura` falla si falta. | `scripts/find-raw-db.mjs` |
| ¿Se prueba contra datos reales? | Sí, dos veces por cambio: `pnpm tenancy` recorre solo toda tabla con `tenant_id`, y `pnpm pentest` busca desde el inquilino B el caso más nuevo del A por id, listado, búsqueda, exportación y las herramientas del agente. | `docs/TESTING.md`, sección 7 |
| ¿Las tablas nuevas de B19? | `sso_settings` y `adjuntos_por_purgar` nacen con RLS `FORCE` y política. `claimmix_app` sólo puede leer e insertar en la cola de purga. | `neon/migrations/0045_sso_y_purga_de_adjuntos.sql`, `tests/unit/migracion-0045.test.ts` |

## 4. Control de acceso

| Pregunta | Respuesta | Evidencia |
|---|---|---|
| ¿Qué roles hay? | Cinco: `owner`, `admin`, `specialist`, `analyst`, `viewer`. Cada acción tiene una constante de roles propia (ver datos del padrón, editar el padrón, entregar al Core, revisar desvíos), y la guarda vive en el servidor. Esconder un enlace no es una defensa. | `src/lib/auth/roles.ts`, `require-role.ts` |
| ¿Quién puede registrarse? | Nadie por su cuenta: el alta la cierra una lista de permitidos, en un solo lugar (el hook de creación de usuario), que cubre también la primera entrada con Google. | `src/lib/auth/registro-permitido.ts`, `provision.ts` |
| ¿Autenticación? | Email y contraseña, Google y, por inquilino, el IdP OIDC de la aseguradora (sección 5). | `src/lib/auth/index.ts` |
| ¿Sesiones? | Cookie de sesión de Better Auth con un caché de 60 segundos. Revocar una sesión tarda hasta un minuto en llegar a todas las pantallas. Cambiar la contraseña cierra las otras sesiones. | `src/lib/auth/index.ts` |
| ¿Límite de intentos? | Por IP y por cuenta, en Postgres, con un alcance propio para el SSO (`auth:sso`) y tope por IP. | `src/lib/rate-limit/` |
| ¿MFA propio? | **No.** Quien lo necesita lo exige desde su IdP con el SSO. | sección 5 |
| ¿Quién del proveedor puede llegar a los datos de clientes? | Quien tiene las credenciales de infraestructura (Vercel, Neon, R2). Hoy es el dueño de la plataforma. Quiénes y con qué registro: **a definir por contrato**. | |

## 5. SSO por inquilino (B19)

Plugin propio de Better Auth (`sso-inquilino`), OIDC, un IdP por inquilino.
El admin lo configura en `/configuracion`.

- **Dominio.** El correo de quien entra tiene que pertenecer a un dominio que
  la aseguradora demostró controlar con un registro TXT. La coincidencia es
  exacta: `ana@sub.empresa.com` no es de `empresa.com`. Los proveedores de
  correo abierto (gmail, hotmail, etc.) no se aceptan. El token del TXT sale de
  una clave derivada (HKDF) de `BETTER_AUTH_SECRET`.
- **Qué se valida en el callback.** Firma del `id_token` contra el JWKS del
  IdP (`jose`), `iss`, `aud`, vencimiento, `nonce` y que el dominio del correo
  sea el verificado del inquilino. Ante la duda, no entra.
- **Descubrimiento y llamadas al IdP** van por HTTPS fijado a la IP resuelta,
  con tope de tamaño y de tiempo, sin seguir redirecciones y sin devolver el
  cuerpo de una respuesta que no es 2xx. La guarda es la misma que la del
  webhook al Core (anti SSRF).
- **El secreto del IdP** se guarda cifrado (`aes-256-gcm`) y nunca vuelve en
  una respuesta.
- **Quién se vincula.** Las cuentas `sso:<inquilino>` no se agregan a
  `trustedProviders`, pero el callback vincula por id a quien ya existe en ESE
  inquilino con el mismo mail: el IdP verificó el correo, el dominio está probado
  por DNS y la cuenta es del inquilino del `state`. Las cuentas locales nacen con
  `emailVerified = false`, así que exigir el correo local verificado dejaba afuera
  al admin y a todos los usuarios previos apenas se exigía SSO. Una cuenta de otro
  inquilino o sin perfil nunca se vincula. Hay una excepción: la que quedó de un
  primer ingreso por este mismo SSO que creó usuario y cuenta y falló al crear el
  perfil, y sólo si TODAS sus cuentas son la `sso:<inquilino>` de este inquilino.
  Esa se recupera dándole el perfil de `viewer` en el reintento; una cuenta sin
  perfil con contraseña o con Google puede ser de cualquiera y sigue rechazada.
- **Exigir SSO.** Con `exigir`, ese dominio deja de poder entrar con contraseña
  ni con Google, y nadie del dominio puede darse de alta por esas vías (el alta se
  niega antes de crear la cuenta). Activarlo requiere que el PROPIO admin que lo
  pide ya tenga su cuenta `sso:<inquilino>`: es la prueba de que el camino anda con
  su cuenta y no lo deja afuera. Rige sólo para las cuentas de ESE inquilino: una
  cuenta de otro inquilino con un mail del mismo dominio no se bloquea, ni se le
  cierran las sesiones, ni se le frena el alta. Cierra las sesiones de los usuarios
  de ese dominio (menos la del admin que lo activó). No cuentan como ingreso, y pasan, el alta de
  un usuario por un admin y el cambio de contraseña de quien ya estaba adentro.
  Un mail fuera del dominio del SSO no puede exigirlo.
- **Cambiar el IdP.** Con otro issuer, otro dominio u otro `client_id` se apagan
  `activo` y `exigir`, y el secreto viejo no se conserva si cambió el issuer o el
  `client_id`.
- **Cómo se apaga `exigir` si alguien se queda afuera.** Lo hace el dueño de la
  plataforma: `UPDATE sso_settings SET exigir = false WHERE tenant_id = '<id>'`.
- **Auditoría.** Guardar el IdP, verificar el dominio, exigir o dejar de exigir,
  el alta por primer ingreso y cada rechazo dejan una fila en `audit_log`, sin
  secretos.

Evidencia: `tests/unit/sso-*.test.ts`, `tests/unit/https-fijado.test.ts`,
`tests/integration/admin/sso.test.ts` (con un IdP y un DNS simulados) y
`attackSso` en `pnpm pentest`.

Lo que **no** se probó contra un IdP real: el flujo completo contra Entra ID,
Okta o Google Workspace de una aseguradora. Lo prueba el piloto.

## 6. Auditoría y trazabilidad

- `audit_log` **sólo se agrega**: `claimmix_app` no tiene `UPDATE` ni `DELETE`
  (migración `0032`). Una aplicación comprometida no puede reescribir la
  historia.
- Registra quién (usuario de la aseguradora), qué, sobre qué, cuándo, y la IP y
  el navegador. No registra a las personas que reportan un siniestro.
- La retención y el borrado de casos dejan su propio rastro: por cada caso
  `CASE_DELETED` (con `por_retencion` cuando lo borra el barrido) y por cada
  pasada `RETENCION_APLICADA`, con sólo cantidades.
- El contenido de un mail o de un WhatsApp nunca va a los registros de
  aplicación ni a Sentry. Sentry sólo se carga si hay `SENTRY_DSN`, sin PII y con
  los eventos limpiados antes de salir. Si está encendido en producción:
  **a verificar**.
- **La propia `audit_log` no tiene retención.** Crece sin límite. Es deuda
  dicha, no decisión (sección 11).

## 7. Retención y borrado

### Retención de casos (apagada por defecto)

- Variables: `RETENCION_MODO` (`apagado` por omisión, `simular`, `borrar`) y
  `RETENCION_ANIOS` (5 por omisión; de 1 a 30; un valor inválido apaga).
- **Hoy está apagada en todos los ambientes.** El dueño decide cuándo pasar a
  `simular`, que cuenta y no borra, y después a `borrar`.
- Corre dentro del cron `reap-stuck`, en la ventana de las 04 UTC y UNA vez por
  día (un cupo de 24 h, pedido dentro de la ventana). La ruta se llama cada quince
  minutos: sin el cupo, la ventana de una hora dejaba pasar cinco corridas. Si la
  corrida falla, no se reintenta hasta el día siguiente. Borra hasta 200 casos
  por inquilino por corrida, los más viejos primero.
- Alcance: casos en un estado cerrado (`cerrado`, `pagado`, `rechazado`) con
  `closed_at` anterior al corte. **No toca** clientes, pólizas (el padrón es de
  la aseguradora), `audit_log` ni los casos `no_relevante`.
- El `DELETE` vuelve a comprobar estado y `closed_at`: un caso que se reabrió
  entre que se lo listó y el borrado se salva.

### Borrado diferido de adjuntos

- Borrar un caso (por una persona o por la retención) anota los adjuntos de R2
  en la cola `adjuntos_por_purgar`, en el mismo lote que el `DELETE`. No se
  pierde el rastro de lo que hay que borrar en R2.
- **La cola sólo se agrega.** No hay `UNIQUE` sobre `storage_path` ni `ON CONFLICT`:
  `claimmix_app` no puede actualizar una fila para renovarla. Si el objeto ya
  estaba anotado (otro caso lo compartía), entra otra fila y manda la MÁS NUEVA
  por `storage_path`; una purga lograda cierra también las filas viejas del mismo
  objeto. Así un borrado posterior no queda pisado por una fila cancelada o ya
  vencida.
- `PURGA_ADJUNTOS_MODO` (`apagado` por omisión, `simular`, `borrar`) y
  `PURGA_GRACIA_DIAS` (30 por omisión; de 7 a 365). Los objetos se borran de
  R2 pasada la gracia, de a 50 por corrida, uno por uno, idempotente.
- **Cómo se recupera algo borrado por error.** Durante la gracia el objeto sigue
  en R2 y el dueño puede cancelar la purga:
  `UPDATE adjuntos_por_purgar SET purgar_despues = NULL` (con `WHERE` por
  inquilino o caso). Un `NULL` en `purgar_despues` es una purga cancelada: si
  después se borra otro caso que comparte el objeto, la fila nueva manda y el
  objeto se purga igual. Las
  filas de la base se recuperan con los backups de la sección 9, que son por
  ventana corta.
- Si R2 falla, la fila queda con `ultimo_error` fijo y se reintenta después.

### Limitaciones, dichas tal cual

- Los scripts y las cascadas de inquilino **no encolan** adjuntos: dejan
  objetos huérfanos en R2. No hay barrido hacia atrás de los huérfanos viejos.

## 8. Subprocesadores

| Proveedor | Para qué | Datos que ve | Región |
|---|---|---|---|
| Vercel | aloja la aplicación y los cron | todo lo que pasa por la aplicación | `gru1` |
| Neon | base de datos | todo el dato operativo | ver sección 1 |
| Cloudflare R2 | adjuntos | fotos de daños, licencias, cédulas | **a verificar** |
| Google Cloud (Vertex AI, Gemini) | extracción de campos | texto y fotos de cada denuncia | `us-central1` |
| Google (Gmail API, login) | canal de mail y «Continuar con Google» | los correos de la casilla configurada | definida por Google |
| Meta (WhatsApp Cloud API) | canal de WhatsApp | teléfono y mensajes de ese canal | definida por Meta |
| Sentry (sólo si hay DSN) | errores de ejecución | eventos sin PII | **a verificar** |
| GitHub | repositorio privado y CI | código; credenciales de CI (sección 11) | |

- No hay OpenAI ni otro proveedor de modelos. El extractor es siempre Gemini por
  Vertex. No hay llamadas nuevas al modelo en B19.
- Que Vertex no retiene los datos más allá de la solicitud es lo que dice hoy la
  política de privacidad. **A verificar** contra los términos vigentes del
  proveedor antes de repetirlo en un contrato.
- Cambios de subprocesadores: se avisa por correo antes de incorporar uno
  (proceso a formalizar por contrato).

## 9. Backups y continuidad

- **Base:** Neon mantiene historial para restauración a un punto en el tiempo
  (PITR). **La ventana vigente del plan no está verificada** y no se hizo nunca
  una restauración de prueba. Hasta que se haga, no se promete un RPO.
- **Adjuntos:** R2 no tiene versionado activado por nosotros. Lo que se borra de
  R2 se borra. Sólo la gracia de la purga (sección 7) da una ventana.
- **Continuidad:** la aplicación corre en un solo región de Vercel (`gru1`). No
  hay failover entre regiones ni entre proveedores. Un corte de Vercel o Neon es
  un corte del servicio.
- **Trabajo en vuelo:** la carga usa el SDK `workflow` de Vercel, retomable
  paso a paso, y un barrido cada 15 minutos (`barrer-trabados.yml`) levanta lo que
  quedó trabado. `/api/health` mide base, migraciones y almacenamiento.

## 10. Desarrollo seguro y detección

- **Cada cambio pasa por CI** antes de llegar a producción: tipos, lint,
  pruebas unitarias e integrales, cobertura, auditoría de dependencias,
  licencias, tamaño del paquete, Semgrep (OWASP Top 10), CodeQL, escaneo de
  secretos (sobre cada cambio y semanal) y un pen test local sin credenciales.
  Nombres de los jobs: `typecheck`, `lint`, `unit-tests`, `build`,
  `integration-tests`, `cobertura`, `security-audit`, `bundle-size`,
  `integration-tests-email`, `license-audit`, `tenencia-capa-datos`,
  `pen-test-local`.
- **Después de cada deploy** corren las pruebas contra el alias real: `pnpm
  smoke`, el ensayo de conversaciones completas, `pnpm pentest` (mitad gratis) y
  la carga.
- **Ramas protegidas por proceso:** rama, PR a `qa`, promoción. Nunca push a
  `main`. Desde que el repositorio es privado, GitHub ya no lo impone en el
  plan actual y se sostiene a mano.
- **Escaneos asistidos por modelo:** el repositorio se escaneó entero en tres
  tandas en septiembre (3 defectos parchados en #178, 1 en #180, endurecimientos
  en #181).
- **Incidentes.** Detección: los checks de después del deploy, `/api/health`,
  los registros de Vercel y, si está encendido, Sentry. **No hay un runbook de
  respuesta a incidentes ni un plazo de notificación firmado.** Una brecha se
  avisa a cada aseguradora afectada por correo desde ilan.daniele@gmail.com.
  Lo que hay que formalizar por contrato: plazo (72 horas es lo usual), canal y
  responsable.

## 11. Deudas de seguridad, dichas tal cual

1. **GitHub todavía guarda el `DATABASE_URL` de producción con `BYPASSRLS`.**
   Es la conexión del rol dueño de la base viva, y la usan los jobs de después
   del deploy, que escriben y limpian sus propias filas en la base de los
   clientes. Quien controle los secretos del repositorio puede leer todos los
   inquilinos. Mitigación actual: repositorio privado y rama protegida por
   proceso. Lo correcto es una conexión con un rol sin `BYPASSRLS` para esos
   jobs.
2. **La clave de la cuenta de servicio de GCP queda sólo en la máquina del
   dueño.** Vercel y GitHub Actions entran a Google por identidad federada
   (WIF), sin clave. No se afirma que no quede ningún otro secreto en Vercel o
   en GitHub: hay secretos de base, de WhatsApp, de R2, de auth y de cifrado
   (sección 2) en los dos.
3. **Los scripts y las cascadas de inquilino dejan objetos huérfanos en R2**
   (sección 7), sin barrido hacia atrás.
4. **Falta confirmar si el balde de staging comparte con producción.** QA tiene
   balde propio (`claimmix-qa-attachments`, con un token que no lee el otro).
   Staging: **a verificar**.
5. **Una sola clave de cifrado para todos los inquilinos** (sección 2).
6. **`audit_log` sin retención.** Crece sin límite.
7. **Sin PITR verificado ni restauración probada** (sección 9).
8. **Sin MFA propio.** Se delega al IdP con SSO (sección 4).
9. **La política de privacidad pública tiene datos desactualizados** (sección
   13). No se tocó en este cambio.
10. **Una sola región y un solo proveedor por capa**, sin failover.
11. Las pruebas unitarias de retención y de purga usan SQL dibujado y bases
    simuladas. El SQL real corre contra Postgres en la sección 7 de
    `pnpm capa-datos`, en cada corrida del CI y contra la base del ensayo: el
    `CASE` del PUT y el `EXISTS` del PATCH de `/api/admin/sso`, la cola de purga
    con dos borrados del mismo objeto, la retención en `simular` y la revisión
    nocturna. La migración 0045 ya está aplicada en las tres bases (30/09). Lo que
    esa prueba no cubre, porque simula R2 y no enciende ningún modo, es del
    dueño (sección 12).

## 12. Pendientes del dueño (no son código)

- Confirmar la separación de baldes de R2 entre staging y producción. El SQL de
  SSO, purga, retención y revisión nocturna ya lo prueba el CI contra Postgres
  (sección 7 de `pnpm capa-datos`), pero con R2 simulado: no toca ningún balde.
- Decidir cuándo pasar `RETENCION_MODO` y `PURGA_ADJUNTOS_MODO` a `simular` y
  después a `borrar`. Nacen apagadas y no se encendieron en ningún ambiente.
- Verificar la ventana de PITR de Neon en el plan vigente y hacer una
  restauración de prueba.
- Verificar la región de la base de producción y la ubicación del balde de R2.
- **SOC 2 (Tipo I y II), ISO 27001 y un pen test externo.** Son procesos y
  auditorías de terceros, no se resuelven con código. Este documento y los
  controles automáticos son el insumo.
- Un runbook de incidentes con plazo de notificación.

## 13. Texto de privacidad propuesto

`src/app/privacy/page.tsx` **no se tocó**. La página pública tiene estos
desajustes con lo que el sistema hace hoy; acá está el texto sugerido, para que
lo revise quien firma la política:

- **Contraseñas.** Dice «hash bcrypt (factor 12)». Es `scrypt`. Sugerido:
  «Contraseñas almacenadas con un hash `scrypt` con sal».
- **Roles.** Dice «admin / analyst». Son cinco: owner, admin, specialist,
  analyst y viewer. Sugerido: «Control de acceso por roles (propietario,
  administrador, especialista, analista y lector) con auditoría de acciones».
- **Regiones.** Dice «Estados Unidos» para todos los proveedores. La aplicación
  corre en São Paulo (Vercel `gru1`) y la base de ensayo está en `sa-east-1`;
  Vertex corre en `us-central1`. Sugerido: nombrar la región de cada proveedor
  una vez verificadas la de la base de producción y la de R2.
- **Retención.** Dice «hasta 5 años después del cierre». Hoy esa retención no se
  aplica sola: nace apagada. Sugerido, una vez que el dueño la encienda: «Los
  casos cerrados se eliminan automáticamente a los cinco años de su cierre. Los
  archivos adjuntos se eliminan del almacenamiento treinta días después, y hasta
  entonces pueden recuperarse a pedido del responsable del servicio.»
- **Vertex.** «El proveedor no los conserva más allá de la solicitud»: dejarlo
  sólo si se verifica contra los términos vigentes.
- **Inicio de sesión único.** Agregar: «Una aseguradora puede conectar su
  proveedor de identidad (OIDC) y exigir que sus usuarios entren sólo por él.»
- **Datos de uso.** La frase sobre auditoría es correcta: los registros son de
  los usuarios de la aseguradora, no de quienes reportan un siniestro.
