# Puesta en marcha: un cliente de prueba en cada ambiente

Esta guía sirve para dejar dev, QA y prd completos e iguales, cada uno con un cliente de
prueba que recorre lo mismo que va a recorrer un cliente real: el alta, la base propia, el
número de WhatsApp, la casilla de Gmail, un segundo usuario, una denuncia por cada canal, la
lectura de lo que contestó el agente y el consumo en el panel. En dev el cliente de prueba es
la cuenta del dueño. En QA, la cuenta de Gonzalo, que hace la parte de QA. En prd, un cliente
ficticio que arma el dueño con una empresa inventada y un correo y un celular reales. Desde
el 16/10 rige la regla de ambientes iguales: código, banderas, migraciones y entrenamiento del
agente iguales en dev, QA y prd hasta que el dueño diga otra cosa, y lo que entra a QA sigue el
mismo día a main y a prd (`docs/PROJECT_STATUS.md:5051`). Lo que esta guía marca como
«excepción» se aparta de esa regla, y cada excepción está justificada o figura como decisión
del dueño.

Cada paso es una casilla `- [ ]`: se marca `- [x]` cuando salió bien, y quien la marca anota
al lado la fecha. Todos los pasos usan la misma plantilla:

- **Quién:** [Dueño], [Gonzalo], [Cliente ficticio] (el dueño haciendo de cliente, en una
  ventana privada o en otro equipo), [Claude] (siempre con el OK del dueño) o [Automático].
- **Dónde:** la pantalla, la consola o el comando.
- **Qué hacer.**
- **Salió bien si:** lo que se ve cuando anduvo.
- **Si falla:** qué mirar y a quién avisar.
- **Fuentes:** los `archivo:línea` del repo, para quien quiera comprobarlo. Quien sólo sigue
  los pasos puede saltearlas.

Lo que no existe se dice «no existe». No se escribe ningún valor de secreto: sólo nombres de
variables. Los valores de secretos los pega sólo el dueño, en la pantalla de Vercel.

## Orden recomendado

1. «Antes de empezar» completo: las decisiones (A1), las cuentas y consolas (A2 a A10), las
   migraciones (A11) y el lote de variables de los tres proyectos (A12), con un solo redeploy
   por proyecto. Ninguna prueba antes de eso. Cada variable que cambia después pide otro
   redeploy y repetir la prueba. Además, el plan Hobby tiene un tope diario de builds para
   los tres proyectos y admite a lo sumo una promoción a prd por día.
2. dev y QA en paralelo. Gonzalo no depende del número de WhatsApp ni de prd.
3. prd. El número por código va primero a prd, porque en la WABA queda un solo lugar libre
   (D1). Dev y QA también reciben la bandera (D1, b), pero ese lugar es primero del cliente
   ficticio de prd.
4. El «Ensayo del prompt» después de cada deploy, y «Cuánto consume» (C1) después del paso 12
   de dev.

**Contradicción en los docs, resuelta.** Los otros docs decían que el número por código no se
prende en prd hasta que la prueba en QA salga bien. El 17/10 el dueño eligió D1 (b): prd lo
tiene prendido desde el 09/10, y dev y QA lo reciben en el lote de A12. `docs/whatsapp-setup.md`
y `docs/PROJECT_STATUS.md` se corrigieron en este mismo cambio.

## Lo que hoy no es igual

- Lo que muestra `/registro` en cada ambiente (el correo, Turnstile) sale de las banderas que
  informa `/api/health` con el `Authorization: Bearer` de `CRON_SECRET` de ese ambiente. En QA,
  el job «Alta automática en QA» del Post-deploy comprueba en cada deploy que `/registro`
  coincide con ellas (`docs/TESTING.md`, capa 11); dev y prd no tienen esa comprobación.
- QA no tiene token de WhatsApp ni casilla de la plataforma, a propósito
  (`docs/PROMOCION.md:323-327`). Sigue así hasta que QA tenga su propia WABA y su propio token
  (después de A5; ver «Después de A5: una WABA y un token por ambiente»).
- El número por código (`ALTA_NUMERO_AUTOMATICO`) está en 1 en los tres ambientes: prd desde
  el 09/10, dev y QA desde el lote de A12 (17/10, D1 b). En QA sin token de WhatsApp: un alta
  que pida el teléfono termina en revisión con `sin_credencial`.
- `BASE_POR_CLIENTE` sólo está prendida en prd. En dev y QA queda en 0 porque no tiene vuelta
  (`docs/PROMOCION.md:779-784`, D2).
- El entrenamiento del agente: dev tiene 19 reglas y 207 ejemplos, prd ninguno y QA no está
  documentado (`docs/PROJECT_STATUS.md:5057`).

## Qué pedido resuelve cada paso

| Pedido | Dónde se resuelve | Estado al 16/10 |
|---|---|---|
| 1. Alta automática con número, mail y base propia | prd pasos 2 a 9; altas de dev (pasos 3 a 7) y de QA (pasos 2 a 6) | En curso: falta la primera alta de punta a punta en prd |
| 2. Cuánto consume | «Cuánto consume» y C1; dev paso 12, QA paso 13, prd paso 14 | El costo por caso no se guarda; C1 lo aproxima |
| 3. prd con base por cliente y dos usuarios | prd pasos 4, 5 y 10 | La base propia anda; el analista entra como alias de la Gmail del administrador, sin activar el espacio (D4 d) |
| 4. Correr el prompt de nuevo | «Ensayo del prompt» (E1 a E3) | El ensayo corre en dev y QA; prd no ensaya, a propósito |
| 5. MCP de Meta para WhatsApp | «MCP de WhatsApp (opcional)» y D14 | No hace falta para el alta; queda opcional |

## Glosario

- **Espacio** (en el código, inquilino o tenant): la cuenta de una aseguradora o un productor,
  con sus casos y sus usuarios.
- **Casa** o **espacio de la plataforma**: el espacio propio de ClaimMix en cada ambiente.
  Ahí entra la cuenta de operador y, en dev, el número y la casilla de la plataforma.
- **Operador**: quien administra la plataforma, no un cliente. Ve `/admin/altas` y
  `/admin/cartera`.
- **Autoalta**: el alta que hace el cliente solo, desde `/registro`.
- **En prueba**: un espacio que todavía no paga. Tiene topes de gasto e invitaciones más
  chicos.
- **Base propia** (`t_<hex>`): en prd, cada cliente tiene su propia base de datos en Neon. Su
  nombre empieza con `t_` y sigue con letras y números. **Control** es la base de prd que
  guarda la lista de espacios.
- **Migración**: un cambio en la estructura de una base. Se aplica a mano; los deploys no la
  corren. **Desfase** (`bases.desfase`): alguna base de prd quedó atrás de las migraciones.
- **WABA**: la cuenta de WhatsApp Business de Veltra en Meta, que agrupa los números.
- **Número por código**: el cliente suma su propio número de WhatsApp tipeando el código que
  Meta le manda por SMS o por llamada.
- **Webhook**: la dirección a la que Meta o Google avisan que llegó un mensaje.
- **Pub/Sub**: el servicio de Google que avisa al instante que llegó un mail. Sin él, el
  correo entra con el sondeo diario.
- **Remitente**: la casilla de Gmail de la plataforma que manda los mails del alta y las
  invitaciones.
- **Turnstile**: el desafío anti-robots de Cloudflare en `/registro`.
- **Vercel**: donde corre ClaimMix. Cada ambiente es un proyecto; la configuración son
  variables; una variable nueva vale recién después de un **redeploy** (volver a publicar).
  **Hobby** es su plan gratis.
- **Post-deploy**: la corrida de GitHub Actions que comprueba cada ambiente después de
  publicar. **Smoke**: la parte rápida, que mira que el sitio responda con la versión
  esperada.
- **Ensayo**: conversaciones enteras contra el agente real, sin mandarle nada a nadie.
- **`/api/health` y `CRON_SECRET`**: la página de salud de cada ambiente. Sólo contesta con la
  llave `CRON_SECRET` de ese ambiente, que va en el encabezado `Authorization: Bearer`.
- **p95**: el valor que no supera el 95 % de las mediciones.
- **MCP**: un complemento que le deja a Claude usar WhatsApp para operar o probar.

## Estado al 16/10

Lo leído en `/registro` de cada ambiente el 16/10 y lo que dicen los docs
(`docs/PROJECT_STATUS.md:5053`, `docs/PROMOCION.md:556-576`).

| Tema | dev (`claimmix-dev.vercel.app`) | QA (`claimmix-qa.vercel.app`) | prd (`claimmix.vercel.app`) |
|---|---|---|---|
| Alta | Abierta con Google, correo y Turnstile; sin aviso del número por código | Sólo el botón de Google; no se ven el correo ni Turnstile | Google, correo, Turnstile y el aviso del número por código; falta la prueba de punta a punta (`docs/PROMOCION.md:713-716`) |
| Base propia | No, por excepción (`BASE_POR_CLIENTE` en 0, `docs/PROMOCION.md:560`) | No, por excepción (`docs/PROMOCION.md:784`) | Sí: `BASE_POR_CLIENTE` prendida y la base de casa lista (`docs/PROJECT_STATUS.md:4760-4764`) |
| WhatsApp | El número de la plataforma, en la WABA de Veltra compartida con prd | No tiene, a propósito (`docs/PROMOCION.md:323-327`); sin token hasta su propia WABA (después de A5) | Número por código prendido desde el 09/10, nunca probado contra Meta en vivo (`docs/whatsapp-setup.md`, «Estado al 17/10») |
| Mail | Casilla de la plataforma y push de Pub/Sub hacia `claimmix-dev` (`docs/PROJECT_STATUS.md:4766-4767`) | Sin casilla ni Pub/Sub, a propósito (`docs/PROMOCION.md:323-327`) | Tópico propio `gmail-push-prd`; ninguna casilla conectada hasta que un cliente la conecte (`docs/PROMOCION.md:736-738`) |
| Consumo | Presupuesto mensual no documentado | `AI_TENANT_DAILY_TOKEN_CAP` en 20 M (`docs/PROMOCION.md:253`); el resto no documentado | US$ 50 en total, 1 por espacio en prueba y 30 entre todos (`docs/PROMOCION.md:733-734`) |
| Usuarios | Operadores por `ADMIN_EMAILS`; invitaciones con el remitente cargado | `ADMIN_EMAILS` figura en la lista de QA (`docs/PROMOCION.md:266`), pero no está comprobado que tenga valor | Operador por `ADMIN_EMAILS`; ningún cliente con usuarios todavía |
| Agente | `gemini-3.8-flash`; el espacio de prueba tiene 19 reglas y 207 ejemplos (`docs/PROJECT_STATUS.md:5057`) | `gemini-3.8-flash`; reglas y ejemplos sin documentar | `gemini-3.8-flash`; ninguna regla ni ejemplo |

## Antes de empezar

Lo que se consigue o se decide una sola vez, en este orden. Cuando los docs no dicen cuánto
tarda algo, la guía lo dice así.

- [x] **A1. Decisiones que traban algo.** 17/10.
  - **Quién:** [Dueño].
  - **Dónde:** esta tabla; el detalle de cada una está en «Decisiones pendientes del dueño».
  - **Qué hacer:** aceptar la recomendación o elegir otra opción, y anotarla al lado.

    | Decisión | Recomendación por defecto | Qué destraba |
    |---|---|---|
    | D1. Número por código | (c): dejarlo prendido sólo en prd; el alta del cliente ficticio es la prueba | prd pasos 2 y 7; la fila «Número por código» de la tabla |
    | D2. `BASE_POR_CLIENTE` en dev y QA | 0 en los dos. Es una excepción a «iguales»: la bandera no tiene vuelta y no existe herramienta para pasar los datos de dev | dev paso 5, QA paso 5, A12 |
    | D3. QA con canales reales | Casilla de Gmail de prueba de Gonzalo, sí. Número de WhatsApp, no: ocuparía el único lugar libre de la WABA | QA pasos 6, 7 y 10 |
    | D4. Invitaciones en un espacio en prueba | (d): el administrador invita al analista como un alias `+` de su propia Gmail, sin activar el espacio; la invitación sale sola. (a), un dominio propio que no sea un proveedor abierto, no aplica: no hay dominio propio. (b), activar con cuota 0 desde `/admin/altas`, queda como botón manual | A3; dev paso 8, QA paso 8, prd pasos 10 y 14 |
    | D5. El cliente ficticio, después | Si Veltra sigue sin verificar: borrar su número en WhatsApp Manager para liberar el lugar y suspender el espacio. Purgar la base sólo si hacen falta los MB | prd paso 16 |
    | D6. `ALTA_AUTOMATICA` en QA | 1, igual que dev y prd | QA paso 1 |
    | D7. Cifras de los topes | Los topes del alta y de la prueba, iguales a prd en los tres. `MONTHLY_BUDGET_USD` y `AI_TENANT_DAILY_TOKEN_CAP`: excepción en dev y QA, porque ahí gasta el ensayo | A12 |
    | D8. Quién es operador | El dueño, en los tres. Gonzalo no, en QA: una dirección de `ADMIN_EMAILS` no puede hacer autoalta | A3; QA pasos 1 y 4 |
    | D14. MCP de WhatsApp | No instalarlo para esta guía | «MCP de WhatsApp (opcional)» |
    | D15. Canal de reporte | Un chat o un correo con el dueño | QA paso 12; «Si prueban otros en prd» |

  - **Elegido el 17/10:**
    - **D1: (b).** `ALTA_NUMERO_AUTOMATICO` va en 1 también en dev y QA (prd ya la tiene), y se
      cargó en el lote de A12 el 17/10: hoy está en 1 en los tres. El dueño agregó tres cosas.
      - El único lugar libre de la WABA actual (compartida por dev y prd, la del número de la
        plataforma) es primero del cliente ficticio de prd. En dev, mientras el lugar siga
        libre, el alta tomaría ese lugar: el dueño no elige la opción de teléfono en dev hasta
        terminar el alta ficticia de prd y borrar su número (D5), o hasta A5. Con 2 números en
        la WABA, el código manda cualquier alta siguiente a revisión con `sin_lugar`
        (`src/server/alta/numero-automatico.ts:283`; tope `ALTA_NUMEROS_MAXIMOS_WABA`, 2 por
        omisión, `:97`).
      - QA lleva la bandera en 1 y sigue sin token de WhatsApp: un alta de QA que elija el
        teléfono termina en revisión con `sin_credencial` (`:335`, `:410`).
      - A futuro, una WABA por ambiente. Espera a A5 (ver «Después de A5: una WABA y un token
        por ambiente»).
    - **D2:** `BASE_POR_CLIENTE` en 0 en dev y QA, excepción declarada a «iguales».
    - **D3:** QA con la casilla de Gmail de prueba de Gonzalo. Sin número de WhatsApp hasta que
      QA tenga su propia WABA y su propio token (después de A5).
    - **D4: (d).** Corregido otra vez el 21/10 (#489). El 17/10 quedó anotada (a), pero no hay
      dominio propio (todo es Gmail y `claimmix.vercel.app` es de Vercel); el 20/10 pasó a (b),
      activar cada espacio con cuota 0 antes de invitar al analista. Ahora, en un espacio en
      prueba, el administrador puede invitar a un alias `+` de su propia casilla de Gmail, y la
      invitación sale sola, sin activar nada. La casilla del administrador tiene que tener el
      correo verificado. El botón de activación de `/admin/altas` sigue como estaba, para
      levantar los topes de la prueba cuando el cliente paga.
    - **D5:** después de la prueba, borrar el número del cliente ficticio en WhatsApp Manager y
      suspender el espacio. Purgar la base sólo si faltan MB.
    - **D6:** `ALTA_AUTOMATICA` en 1 en QA.
    - **D7:** los topes del alta y de la prueba, iguales a prd en los tres. `MONTHLY_BUDGET_USD`
      y `AI_TENANT_DAILY_TOKEN_CAP`, más altos en dev y QA (excepción), y en esos dos
      `AI_TENANT_DAILY_TOKEN_CAP` igual a la variable del repo.
    - **D8:** el dueño es operador en los tres. Gonzalo no lo es en QA.
    - **D14:** no instalar el MCP de WhatsApp.
    - **D15:** los reportes van por chat o por correo al dueño.

  - **Salió bien si:** cada fila tiene una opción anotada.
  - **Si falla:** sin D1 no se empieza prd; sin D3, QA se hace con simulaciones; si el analista
    no es un alias de la misma Gmail que el administrador (D4), la invitación termina en el
    rechazo por dominio.
  - **Fuentes:** `docs/PROMOCION.md:779-784` (D2); `docs/PROMOCION.md:268-292` y
    `.github/workflows/deploy-checks.yml:378-383` (D7: el ensayo gasta unos 1,5 M de tokens
    por corrida y el tope de dev y QA tiene que ser igual a la variable del repo);
    `src/app/alta/page.tsx:19-23` (D8).
- [ ] **A2. El nombre de la empresa ficticia.**
  - **Quién:** [Dueño].
  - **Dónde:** el campo «empresa» de `/registro` de prd.
  - **Qué hacer:** elegir un nombre inventado, que no se parezca a una aseguradora ni a una
    empresa real.
  - **Salió bien si:** una búsqueda del nombre en internet no devuelve una empresa.
  - **Si falla:** elegir otro.
  - **Fuentes:** `src/app/registro/page.tsx`.
- [ ] **A3. Las direcciones de correo: administrador, analista y mail agente, por ambiente.**
  - **Quién:** [Dueño]; en QA, Gonzalo.
  - **Dónde:** Gmail. Las cuentas nuevas se crean en
    [accounts.google.com/signup](https://accounts.google.com/signup); los alias no se crean en
    ningún lado.
  - **Qué hacer:** tener tres direcciones en cada ambiente.
    - **Administrador:** un alias `+` de una Gmail: la dirección con `+dev-admin` antes de la arroba. Gmail
      lo entrega en la bandeja de la cuenta sin configurar nada. Hace la autoalta en
      `/registro` por el camino del correo. `ADMIN_EMAILS` compara la dirección exacta, así
      que el alias de una cuenta de operador no cuenta como operador.
    - **Analista:** otro alias `+` de la misma Gmail que el administrador, con `+dev-analista`
      antes de la arroba. Se invita desde `/admin/users` sin activar el espacio (D4 d): en
      prueba el administrador puede invitar a un alias `+` de su propia casilla, y la
      invitación sale sola. Un alias de otra Gmail o una dirección de otro dominio se rechaza
      por dominio. El analista acepta con una contraseña: `/invitacion` no ofrece Google para
      un alias `+`, porque Google devolvería la casilla base y no coincidiría con la
      invitada.
    - **Mail agente:** una cuenta de Gmail propia, no un alias, porque Google conecta la
      cuenta entera. Se conecta en `/configuracion` → «Conectar Gmail»; el agente lee ahí las
      denuncias y desde ahí contesta. Una por ambiente y por cliente: prd rechaza las casillas
      de `CASILLAS_DE_DEV` con `otro_ambiente`, y una casilla ya conectada a otro espacio
      termina en `mailbox_taken`.
    - Por ambiente:
      - dev: una Gmail nueva para el agente; administrador y analista, alias de la Gmail del
        dueño.
      - QA: la Gmail de prueba de Gonzalo para el agente (D3); administrador y analista, alias
        de otra cuenta de Gonzalo. Si tiene una sola, crear una Gmail nueva para el agente.
      - prd: una Gmail nueva para el agente; administrador y analista, alias de la Gmail del
        dueño o de una Gmail del cliente ficticio.
    - El administrador y el analista son alias de la misma Gmail: el servidor compara la
      casilla de fondo, sin puntos ni alias, y gmail.com no se cruza con googlemail.com.
      Además la casilla del administrador tiene que estar verificada; si no, la invitación se
      rechaza por dominio.
    - El administrador y el analista nunca son alias de la Gmail del agente: los mails de alta
      y de invitación caerían en la bandeja que lee el agente.
    - Ninguna de las nueve está en `ADMIN_EMAILS`. Si la del analista lo está, la pantalla
      dice «invitación enviada», pero la invitación se bloquea sin aviso y el mail nunca llega.
    - Los alias de la Gmail personal del dueño no reciben avisos de derivación (veto en
      `src/lib/email/reserved.ts`); la prueba no los necesita.
    - La casilla de la plataforma de dev no se conecta en ningún otro lado.
  - **Salió bien si:** hay nueve direcciones: seis alias y tres cuentas de Gmail, ninguna en
    `ADMIN_EMAILS` y ninguna repetida entre ambientes. El dueño avisa «listo» sin escribirlas.
  - **Si falla:** una persona tiene un solo espacio por ambiente. Con una dirección repetida,
    el alta termina en `ya_tiene_espacio`; con una de `ADMIN_EMAILS`, `/alta` muestra el
    aviso de operador en vez de abrir un espacio.
  - **Fuentes:** `src/server/alta/crear-inquilino.ts:5`, `:37`; `.env.example:404`
    (`ADMIN_EMAILS`), `:295` (`CASILLAS_DE_DEV`); `src/app/alta/page.tsx:19-23`;
    `src/lib/auth/require-operator.ts:42-47` (comparación exacta);
    `src/app/api/admin/users/route.ts:134-153` (dominio y alias propio), `:155-179`
    (invitación a un operador); `src/lib/email/reserved.ts:86-98` (`casillaDeGmail`);
    `src/app/invitacion/page.tsx:162` (sin Google para un alias `+`);
    `src/app/api/admin/gmail-accounts/callback/route.ts` (`otro_ambiente`,
    `mailbox_taken`); `docs/PROMOCION.md:572-574`.
- [ ] **A4. Una SIM libre para el número del cliente ficticio de prd.**
  - **Quién:** [Dueño].
  - **Dónde:** cualquier operadora argentina.
  - **Qué hacer:** conseguir un móvil argentino que reciba SMS o llamadas. No puede estar en
    la app de WhatsApp ni en WhatsApp Business, no puede tener un PIN de dos pasos de otro
    proveedor y no puede ser el número de la plataforma.
  - **Salió bien si:** la SIM recibe un SMS de prueba y el número nunca se usó en WhatsApp.
  - **Si falla:** otra SIM. Una sola alcanza mientras Veltra no esté verificada: queda un
    único lugar libre en la WABA para los tres ambientes (el tope es del portfolio de Veltra,
    no de la WABA: ver A5).
  - **Fuentes:** `docs/whatsapp-setup.md:207-215` («Lo que hace la persona»), `:351-357` («El
    PIN de dos pasos»), `:283-299` («El tope de Meta»).
- [ ] **A5. La verificación del negocio Veltra en Meta.**
  - **Quién:** [Dueño].
  - **Dónde:** Meta Business Suite > Centro de seguridad.
  - **Qué hacer:** pedirla con la constancia de CUIT con la razón social exacta y un
    comprobante de domicilio. El tope de números lo cuenta Meta por portfolio de negocio, no por
    WABA; la documentación de la Cloud API
    (https://developers.facebook.com/docs/whatsapp/cloud-api/phone-numbers) dice: «New business
    portfolios are initially capped at two registered business phone numbers.» Veltra es un
    solo portfolio y ya usa un lugar con el número de la plataforma, así que una WABA nueva
    dentro de Veltra no suma lugares. Con Veltra verificada, el dueño decidió que cada ambiente
    tenga su propia WABA y su propio usuario del sistema. Los pasos están en «Después de A5:
    una WABA y un token por ambiente».
  - **Salió bien si:** Meta muestra el negocio como verificado. Los docs no dicen cuánto
    tarda.
  - **Si falla:** no bloquea esta guía. Hasta que salga, hay un solo número automático para
    los tres ambientes.
  - **Fuentes:** `docs/whatsapp-setup.md:435-436`.
- [ ] **A6. La pantalla de consentimiento de Google, publicada.**
  - **Quién:** [Dueño].
  - **Dónde:** consola de Google Cloud, en los dos proyectos de los clientes OAuth (dev y QA
    comparten uno; prd tiene el suyo, prd paso 1) > APIs y servicios > Pantalla de consentimiento de OAuth.
  - **Qué hacer:** confirmar que las dos están publicadas («In production»).
  - **Salió bien si:** dice publicada, sin verificar. Por eso Google muestra la pantalla de
    app no verificada al conectar Gmail, y hay un tope de 100 usuarios que es del proyecto y
    comparten todos sus clientes: dev y QA uno, prd el suyo. Las cuentas de prueba de dev y QA,
    la casilla de Gonzalo y la del remitente de QA cuentan para el primero.
  - **Si falla:** si dice «Testing», Google vence el permiso de cada casilla a los siete días.
    Publicarla.
  - **Fuentes:** `docs/PROJECT_STATUS.md:517-524`; `docs/PROMOCION.md:645-649`, `:806-807`.
- [ ] **A7. El cliente OAuth de QA y las URI de redirección de los tres hosts.**
  - **Quién:** [Dueño].
  - **Dónde:** consola de Google Cloud > APIs y servicios > Credenciales.
  - **Qué hacer:** confirmar las URI de la tabla «Las URI de Google, una por host» de
    `docs/PROMOCION.md`, con `<host>` igual al `NEXT_PUBLIC_SITE_URL` de cada ambiente. Gmail
    usa un cliente OAuth por ambiente. El de dev y, hasta que prd tenga el suyo (prd, paso 1),
    el de prd (el `GMAIL_CLIENT_ID` de esos proyectos): confirmar
    `<host>/api/admin/gmail-accounts/callback` de sus hosts. El de QA (`claimmix-qa` en esta guía) es
    un cliente «Aplicación web» propio: sirve «ClaimMix QA», que ya existe (19/09), con un
    secreto que el dueño tenga o le agregue, o uno nuevo. Va en el mismo proyecto (la API de Gmail ya está
    habilitada, el consentimiento ya está publicado y QA no tiene Pub/Sub), con dos URI de
    redirección: `https://claimmix-qa.vercel.app/api/admin/gmail-accounts/callback` y
    `http://127.0.0.1:53682/`, la que usa `scripts/token-remitente.mts`. Después, poner el ID
    y el secreto nuevos en `.env.qa.local`, correr el script del paso 1 de QA (que los sube a
    Vercel) y decirle «listo» a [Claude]. En el cliente
    de `GOOGLE_CLIENT_ID` (el login) no cambia nada: confirmar `<host>/api/auth/callback/google`
    de los tres hosts. Los docs no aclaran si ese es otro cliente o el mismo que el de Gmail
    de dev y prd: hay que mirarlo ahí mismo.
  - **Salió bien si:** las siete URI figuran: las de Gmail de dev y prd en su cliente, las dos
    de arriba en `claimmix-qa` y las tres del login.
  - **Estado (20/10):** las URI de Gmail de los tres ambientes están: una sonda sin login
    contra Google, con el cliente de cada ambiente, las dio por aceptadas a todas. La misma
    sonda, con el cliente de login (`GOOGLE_CLIENT_ID`) que manda cada host, aceptó
    `<host>/api/auth/callback/google` en dev y en QA. Dev y QA usan clientes de login
    distintos, cada uno con la URI de su host, así que en dev y QA no falta nada. prd tiene
    su propio cliente de login en su proyecto de GCP y la sonda no lo toca: falta que el
    dueño entre una vez con Google en `https://claimmix.vercel.app`.
  - **Si falla:** al conectar Gmail, Google muestra `redirect_uri_mismatch`. Agregar la URI
    que falta.
  - **Fuentes:** `.env.example:245` (`GMAIL_CLIENT_ID`), `:46-48` (`GOOGLE_CLIENT_ID` y su
    callback); `src/app/api/admin/gmail-accounts/callback`; `src/lib/auth/base-url.ts`;
    `docs/PROMOCION.md:645-649`, `:813-845`.
- [ ] **A8. El hostname de QA en Turnstile.**
  - **Quién:** [Dueño].
  - **Dónde:** Cloudflare > Turnstile, el widget del alta.
  - **Qué hacer:** agregar `claimmix-qa.vercel.app`.
  - **Salió bien si:** el widget lista los tres hosts. Los de dev y prd ya están; el de QA no
    figura en ningún doc.
  - **Si falla:** en QA nadie pasa el desafío y queda el log `registro.turnstile_no_paso`.
  - **Fuentes:** `docs/PROJECT_STATUS.md:5095`.
- [ ] **A9. Una alerta de gasto de Vertex.**
  - **Quién:** [Dueño].
  - **Dónde:** consola de Google Cloud > Facturación > Presupuestos y alertas.
  - **Qué hacer:** crear una alerta para el proyecto que paga Vertex.
  - **Salió bien si:** la alerta figura con un monto y un correo de aviso.
  - **Si falla:** en el repo no existe ninguna alerta de facturación, y no está documentado a
    qué proyecto factura prd (pool `vercel-prd`). Si no se sabe cuál es, [Claude] lo busca
    con el dueño.
  - **Fuentes:** `docs/PROMOCION.md:731`.
- [ ] **A10. `.env.prd.local` a mano.**
  - **Quién:** [Dueño].
  - **Dónde:** la máquina del dueño.
  - **Qué hacer:** tenerlo actualizado. Los scripts de bases de prd que corre [Claude] leen de
    ahí, no de `.env.local`.
  - **Salió bien si:** el archivo existe en la carpeta del repo.
  - **Si falla:** los pasos 3, 5 y 16 de prd no se pueden hacer.
  - **Fuentes:** `scripts/lib/entorno-de-bases.mjs:19`.
- [ ] **A11. Las migraciones, al día en los tres.**
  - **Quién:** [Claude].
  - **Dónde:** GitHub Actions, el último Post-deploy de cada ambiente; `/api/health` de cada
    uno.
  - **Qué hacer:** confirmar que la última corrida de DEV y de QA pasó el paso «Migraciones
    aplicadas», que compara la base de ese ambiente con las migraciones del código. En PRD,
    el paso «Las bases no están desfasadas». Además, `GET /api/health` con el
    `CRON_SECRET` de cada ambiente, y mirar el chequeo `migraciones`.
    `bases.desfase` sólo existe en prd, donde `BASE_POR_CLIENTE` está prendida.
  - **Salió bien si:** las tres corridas están verdes, el chequeo `migraciones` dice «el
    esquema tiene lo que el código espera», y en prd `bases.desfase` es `false`.
  - **Si falla:** nadie sigue con la guía. [Claude], con el OK del dueño, aplica a mano la
    migración que falta en las bases atrasadas y vuelve a mirar. Los deploys no corren
    migraciones.
  - **Fuentes:** `.github/workflows/deploy-checks.yml:684-688`;
    `.github/workflows/post-deploy.yml:297` (base de DEV), `:520` (base de QA), `:672-680`
    (PRD); `src/app/api/health/route.ts:20-25`, `:316-319`; `docs/PROMOCION.md:786`
    («Migrar después de un cambio de esquema»).
- [ ] **A12. El lote de variables, uno por proyecto.**
  - **Quién:** [Claude] arma la lista, [Dueño] carga los secretos y [Claude] pide el
    redeploy.
  - **Dónde:** Vercel, en cada proyecto (`claimmix`, `claimmix-qa` y `claimmix-prd`) >
    Settings > Environment Variables, entorno Production.
  - **Qué hacer:**
    1. [Claude], con el OK del dueño, lista los nombres de cada proyecto con `vercel env ls`
       y los compara con la tabla de abajo y con el paso 1 de cada ambiente. Sólo mira
       nombres. `vercel env pull` no se usa: baja valores a disco y trae vacíos los secretos.
    2. [Dueño] pega en la pantalla de Vercel los secretos que falten. Nunca por chat ni por
       script. Salvo `GMAIL_CLIENT_*` y el remitente de QA y de prd: esos los carga el dueño con
       `token-remitente.mts --vercel` (QA y prd, paso 1). [Claude] puede cargar las banderas y
       los topes que no son secretos.
    3. Un solo redeploy por proyecto, el mismo día (Vercel > Deployments > el último >
       Redeploy). En prd, uno solo. En QA el redeploy es el merge de #474: si se guarda una
       variable en la pantalla de Vercel, rechazar el Redeploy que ofrece.
  - **Salió bien si:** `/registro` de cada ambiente muestra lo que pide el paso 1 de su
    sección, y el Post-deploy de cada uno queda verde.
  - **Si falla:** [Claude] lee el detalle del chequeo que falló y dice qué nombre falta. Se
    corrige en el mismo lote, antes de probar.
  - **Fuentes:** `docs/PROJECT_STATUS.md:117-118`; `docs/PROMOCION.md:586-589` (tope de
    builds), `:706` (redeploy).

### Después de A5: una WABA y un token por ambiente

El dueño quiere una WABA por ambiente, y hoy no se puede por dos razones. El tope de dos
números es por portfolio de negocio, no por WABA (A5): Veltra es un solo portfolio y ya usa un
lugar con el número de la plataforma, así que una WABA nueva dentro de Veltra no suma lugares.
Y cada WABA necesita su propio número de la plataforma, porque el alta lee el nombre visible
de ese número en la misma WABA y `entornoDeMeta` necesita la credencial de esa WABA. Por eso
esto espera a A5, que sube el tope, o a un portfolio aparte. Hasta entonces dev y prd siguen
con la WABA y el token actuales, y QA sigue sin token.

Receta para QA, con las acciones del dueño en Meta Business Suite (los nombres de los menús
pueden variar):

1. [Dueño] Crear la WABA de QA.
2. [Dueño] Registrar en esa WABA un número de plataforma de QA, con otra SIM (no la de A4).
3. [Dueño] En Usuarios > Usuarios del sistema, agregar un usuario del sistema **nuevo**,
   `claimmix-qa`, con rol de administrador.
4. [Dueño] Asignarle dos activos con control total: la app de ClaimMix y la WABA de QA.
5. [Dueño] En `claimmix-qa`, «Generar token»: app de ClaimMix, vencimiento «Nunca» y los
   permisos `whatsapp_business_management` y `whatsapp_business_messaging`. Meta lo muestra
   una sola vez.
6. [Dueño] Pegar el token en la pantalla de Vercel del proyecto `claimmix-qa` como
   `WHATSAPP_ACCESS_TOKEN` (Sensitive), junto con `WHATSAPP_APP_SECRET` y
   `WHATSAPP_VERIFY_TOKEN`.

[Claude] carga los ids que no son secretos (`WHATSAPP_BUSINESS_ACCOUNT_ID`, con el id de la WABA
de QA, y `WHATSAPP_PHONE_NUMBER_ID`) y sube `ALTA_NUMEROS_MAXIMOS_WABA`. Después, un redeploy de
`claimmix-qa` y la «Prueba real en QA» de `docs/whatsapp-setup.md`.

**Nunca apretar «Generar token» en el usuario del sistema que usan dev y prd. Ese token es
permanente y no se rota. El de
QA sale de un usuario nuevo y no toca el actual. Los tokens nunca pasan por el chat.**

Si el dueño quiere separar también dev y prd, la receta es la misma, con un usuario del sistema
y una WABA para cada uno.

- **Fuentes:** `src/server/alta/numero-automatico.ts:97`, `:242`, `:283`, `:335`;
  `docs/whatsapp-setup.md`, «El tope de Meta».

### Lo que tiene que quedar igual en los tres

`pnpm paridad` compara las `banderas` de `/api/health` de dev, QA y prd (ítem 10 del plan) y
lista lo que difiere fuera de las excepciones de esta tabla. El job `paridad` del Post-deploy
lo corre en cada deploy, al lado de los chequeos, y sólo avisa (`::warning` y resumen del run):
nunca pone rojo.
Con `CRON_SECRET`, `/api/health` lista en `banderas` las banderas, topes y modos de esta tabla,
y de los secretos sólo si están cargados (`docs/TESTING.md`, «`/api/health`»). Lo que no está
ahí, como el entrenamiento del agente, se sigue comparando a mano (A12). Las excepciones que
el comparador conoce están en `EXCEPCIONES` de `scripts/lib/paridad.mjs`, cada una con su
motivo; una nueva se agrega ahí y no en este texto. En el log público del run salen sólo la clave y qué
ambientes coinciden (`dev=qa≠prd`); los valores se ven corriéndolo a mano, con `CRON_SECRET`,
`QA_CRON_SECRET`, `PRD_CRON_SECRET` y `PRD_URL` en `.env.local`. «Desconocido» quiere decir que
ningún doc lo dice.

| Variable | Tipo | Igual o excepción | Estado conocido | Cómo comprobarlo |
|---|---|---|---|---|
| `ALTA_AUTOMATICA` (`src/lib/auth/registro-permitido.ts:53`) | bandera | igual (D6) | dev y prd en 1 (`docs/PROJECT_STATUS.md:4763-4764`); QA en 1 desde el 17/10 (A12) | Vercel; una autoalta de prueba |
| `ALTA_NUMERO_AUTOMATICO` (`src/server/alta/numero-automatico-activo.ts:10`) | bandera | igual: 1 en los tres (D1, b); en QA sin token, el alta va a revisión con `sin_credencial` | 1 en los tres: dev y QA desde el 17/10 (A12) | el aviso del número en `/registro` |
| Número por código | bandera y Meta | excepción de hecho aunque la bandera sea igual (D1, b): el tope de Meta es de 2 números por portfolio y uno ya es el de la plataforma, así que queda un solo lugar libre para dev y prd juntos, y es primero del cliente ficticio de prd. QA tiene la bandera pero no token, y sus altas por código van a revisión con `sin_credencial`. QA tiene su propia WABA y su propio token recién después de A5 (la verificación la pide el [Dueño] en Meta Business Suite) | prd prendido; dev y QA con la bandera en 1 desde el 17/10 (A12) | el aviso del número en `/registro`; `docs/whatsapp-setup.md:283-299` |
| `BASE_POR_CLIENTE` (`.env.example:26`) | bandera | excepción (D2): no tiene vuelta | dev 0, QA 0, prd 1 | `/preparando` en el alta; `bases` en `/api/health?deep=1`; `pnpm paridad` |
| Entrenamiento del agente (reglas y ejemplos de `/agente`) | datos de cada espacio | excepción hasta que el entrenamiento base viva en el repo, igual en los tres (`docs/PROJECT_STATUS.md:5055-5063`). No existe un script que copie reglas y ejemplos entre ambientes (`scripts/export-training.mjs:11`) | dev 19 reglas y 207 ejemplos en el espacio de prueba; prd ninguno; QA desconocido | `/agente`, solapas «Reglas de prompt» y «Ejemplos aprobados» (`src/lib/i18n/es-AR.ts:844`, `:852`) |
| `TURNSTILE_SITE_KEY`, `TURNSTILE_SECRET_KEY` (`.env.example:312-313`) | valor y secreto | igual (dev y prd comparten la clave del sitio) | cargadas en los tres (la CSP de QA trae `challenges.cloudflare.com`) | el desafío en `/registro` |
| `ALTA_REMITENTE_CORREO`, `ALTA_REMITENTE_REFRESH_TOKEN` (`.env.example:265-266`) | valor y secreto | excepción: un remitente por ambiente | cargadas en los tres, cada una con el cliente de su ambiente: QA el 18/10 y prd el 19/10 con `token-remitente.mts --vercel <proyecto>` (paso 1 de cada ambiente); la de prd vale desde su próximo deploy | el bloque de correo en `/registro` |
| `GMAIL_CLIENT_ID`, `GMAIL_CLIENT_SECRET` (`.env.example:245-246`) | valor y secreto | excepción: un cliente OAuth por ambiente (decidido el 18/10). dev tiene el suyo, QA el suyo (`claimmix-qa`, en el mismo proyecto de Google Cloud) y prd uno propio (`claimmix-prd`), en su propio proyecto de Google Cloud, `claimmix-prd-veltra` | cargadas en los tres: QA el 18/10 y prd el 19/10 con `token-remitente.mts --vercel <proyecto>` (paso 1 de cada ambiente); las de prd valen desde su próximo deploy | el bloque de correo y «Conectar Gmail» |
| `GMAIL_TOKEN_ENCRYPTION_KEY` (`.env.example:216`) | secreto | excepción: una por base; no se rota sin volver a cifrar | cargada en los tres (QA desde el 15/10) | error del servidor al volver de Google en «Conectar Gmail»; chequeo `gmail` de `/api/health` |
| `ALTA_TOPE_GLOBAL_DIA`, `ALTA_TOPE_BASES`, `ALTA_TOPE_MB` (`src/server/alta/crear-inquilino.ts:52-62`) | valor | igual (D7) | 5, 30 y 350 en los tres: dev y QA desde el 17/10 (A12) | Vercel; contador de `/admin/altas` |
| `ALTA_PRUEBA_DIAS` (`src/lib/billing/plans.ts:190`), `AI_PILOTO_DAILY_TOKEN_CAP` (`:180`) | valor | igual | sin cargar en ningún doc (30 días y 500.000 tokens por omisión) | Vercel |
| `AI_PRUEBA_MONTHLY_USD_POR_INQUILINO`, `AI_PRUEBAS_MONTHLY_BUDGET_USD` (`src/server/ai/budget.ts:464`, `:474`) | valor | igual (D7) | prd 1 y 30 (`docs/PROMOCION.md:733-734`); dev y QA desconocido | Vercel |
| `MONTHLY_BUDGET_USD` (`src/server/ai/tope-mensual.ts:23`) | valor | excepción en dev y QA (D7) | prd 50; dev y QA desconocido (200 por omisión). El guardia, `/api/health` y `/configuracion` leen el mismo tope (#461); con 0 el guardia frena la IA de los clientes y las dos pantallas dicen «IA frenada» | Vercel; `/api/health` pasa a degraded al 80 % (`route.ts:618`) y con 0 |
| `AI_TENANT_DAILY_TOKEN_CAP` (`.env.example:159`) | valor | excepción en dev y QA (D7); en esos dos, igual a la variable del repo (`.github/workflows/deploy-checks.yml:383`) | QA 20 M; dev y prd desconocido | Vercel y Settings > Variables del repo |
| `ALTA_NUMEROS_MAXIMOS_WABA`, `ALTA_TOPE_NUMEROS_DIA` y los cupos de códigos (`.env.example:246-256`) | valor | igual; se sube recién con Veltra verificada | sin cargar (2, 2, 3, 5, 10, 5) | Vercel |
| `ALTA_TOPE_IP_DIA` (`src/server/alta/cupo-por-ip.ts:20`), `ALTA_TOPE_CORREO_POR_IP_DIA`, `ALTA_TOPE_CORREOS_DIA`, `ALTA_TOPE_POR_DESTINATARIO_DIA`, `ALTA_TOPE_INVITACIONES_DIA` (`.env.example:232-237`), `ALTA_TOPE_PLANTILLAS_PRUEBA_DIA` (`src/server/whatsapp/cloud-api.ts:783`) | valor | igual | sin cargar (valores por omisión) | Vercel |
| `ADMIN_EMAILS` (`.env.example:404`), `SIGNUP_ALLOWED_EMAILS` (`:401`) | valor | igual, salvo D8. `ADMIN_EMAILS` habilita al operador junto con el rol owner o admin, el correo verificado y la sesión en el espacio casa (`src/lib/auth/require-operator.ts:55-67`) | QA sin comprobar | entrar a `/admin/altas`: si redirige a `/bandeja`, falta una de las cuatro |
| `GEMINI_TRANSPORT` (`.env.example:118`) en `vertex`, sin `VERTEX_EXTRACTION_MODEL`, `MOCK_AI` y `AI_MOCK` apagadas (`src/server/ai/provider.ts:293`) | valor | igual | iguales desde el 15/10 | Vercel; un caso de prueba que el agente conteste |
| `AGENT_DELIBERATION`, `AGENT_COMPOSE_REPLIES` (`.env.example:91-92`) | bandera | igual | sin documentar | `/api/health` con `CRON_SECRET` |
| `VERTEX_AI_TUNING_ENABLED` (`.env.example:104`), `RETENCION_MODO` (`:471`), `PURGA_ADJUNTOS_MODO` (`:477`), `ALTA_WABA_PROPIA` (`:266`), `ALTA_APP_PROPIA` (`:280`) | bandera | igual | apagadas en los tres | Vercel |
| `WHATSAPP_ACCESS_TOKEN`, `WHATSAPP_BUSINESS_ACCOUNT_ID`, `WHATSAPP_VERIFY_TOKEN`, `WHATSAPP_APP_SECRET` (`.env.example:363-378`) | secreto y valor | dev y prd iguales (comparten app y WABA); QA vacías hasta que tenga su propia WABA y su propio token (después de A5; ver «Después de A5: una WABA y un token por ambiente»), excepción (D3) | dev cargadas; prd según el paso 2 de prd | chequeo `whatsapp` de `/api/health` |
| `WHATSAPP_PHONE_NUMBER_ID` | valor | dev y prd iguales (el id del número de la plataforma), si el dueño acepta el paso 2 de prd; QA vacía hasta su propia WABA (después de A5) | dev cargada; prd vacía según `docs/PROMOCION.md:736-738` | chequeo `whatsapp` de `/api/health` |
| `WHATSAPP_TENANT_ID`, `GMAIL_TENANT_ID`, `GMAIL_USER_EMAIL`, `GMAIL_REFRESH_TOKEN` | valor y secreto | excepción: sólo dev tiene número y casilla de la plataforma | prd vacías según `docs/PROMOCION.md:736-738` | Vercel |
| `PUBSUB_TOPIC`, `PUBSUB_AUDIENCE`, `PUBSUB_SERVICE_ACCOUNT` (`.env.example:327-339`) | valor | excepción: un tópico por ambiente; QA sin Pub/Sub | dev y prd cargadas | log `webhooks.gmail.sin_audiencia_en_produccion` |
| `NEXT_PUBLIC_SITE_URL` (`.env.example:187`), `DEFAULT_TENANT_ID`, `GOOGLE_DEFAULT_TENANT_ID` (`:47-49`) | valor | excepción: uno por ambiente | cargadas | login; respuestas 403 `INVALID_ORIGIN` de `/api/auth` |
| `SLUGS_DE_DEV`, `NUMEROS_DE_DEV`, `CASILLAS_DE_DEV`, `URL_DEL_OTRO_AMBIENTE` (`.env.example:291-297`) | valor | sólo en prd | cargadas en prd | Vercel |
| `CRON_SECRET`, `BETTER_AUTH_SECRET`, `DATABASE_URL`, `DATABASE_URL_APP`, `R2_*`, `WHATSAPP_APP_SECRETS_KEY` | secreto | excepción: uno por ambiente. El `CRON_SECRET` de prd tiene que ser igual al secreto `PRD_CRON_SECRET` de GitHub (`.github/workflows/post-deploy.yml:660`) | cargadas (salvo `WHATSAPP_APP_SECRETS_KEY`, que espera a la app propia) | smoke y `/api/health` |
| Migraciones (hasta la 0051) | esquema | igual | 0050 y 0051 en las bases (`docs/PROJECT_STATUS.md:4761-4762`, `:5076`) | A11; `pnpm esquemas` (`package.json:43`) compara dos bases |

## dev: la cuenta del dueño

dev es el proyecto de Vercel `claimmix`, rama `main`, base `ep-proud-resonance`, en
`https://claimmix-dev.vercel.app` (`docs/PROMOCION.md:560`). Comparte con prd la app de Meta, la
WABA y el cliente OAuth de Google (`docs/PROMOCION.md:572-574`). No lleva base por cliente, así
que el alta termina directo en la bandeja.

**El cliente de dev está partido en dos espacios.** El alta del paso 3 crea un espacio nuevo,
«el espacio de autoalta», con la dirección del dueño que no es de operador. Ahí van el Gmail
del paso 7, el segundo usuario del paso 8 y la denuncia por correo del paso 10. dev no tiene
número por código (la bandera va en 1, pero el dueño no elige esa opción en dev: ver el paso
1), así que la denuncia por WhatsApp del paso 9 entra por el número de la plataforma y cae en
otro espacio: el de la plataforma (el de `WHATSAPP_TENANT_ID`,
`.env.example:372`). El paso 12 lee los dos.

- [ ] **1. Configuración (parte del lote de A12).**
  - **Quién:** [Claude] mira los nombres; [Dueño] pega los secretos que falten.
  - **Dónde:** Vercel, proyecto `claimmix` > Settings > Environment Variables.
  - **Qué hacer:** confirmar que existen con valor, por nombre:
    - Alta: `ALTA_AUTOMATICA` en `1`; `TURNSTILE_SITE_KEY` y `TURNSTILE_SECRET_KEY`; el
      remitente `ALTA_REMITENTE_CORREO` y `ALTA_REMITENTE_REFRESH_TOKEN`, con
      `GMAIL_CLIENT_ID` y `GMAIL_CLIENT_SECRET`; y `ADMIN_EMAILS`.
    - Base: `BASE_POR_CLIENTE` en `0` (D2).
    - Gmail: `GMAIL_TOKEN_ENCRYPTION_KEY`, `PUBSUB_TOPIC`, `PUBSUB_AUDIENCE` y
      `PUBSUB_SERVICE_ACCOUNT`.
    - WhatsApp: `WHATSAPP_ACCESS_TOKEN`, `WHATSAPP_PHONE_NUMBER_ID`, `WHATSAPP_TENANT_ID`,
      `WHATSAPP_BUSINESS_ACCOUNT_ID` y `WHATSAPP_VERIFY_TOKEN`.
    - `ALTA_NUMERO_AUTOMATICO` está en `1` en dev desde el lote de A12 (17/10, D1 b).
      **No elegir la opción del celular en dev** (pedir el código en la tarjeta de
      WhatsApp de Primeros pasos) hasta que el alta del cliente ficticio de prd esté hecha y su
      número borrado (D5), o hasta A5: el único lugar libre de la WABA es primero de prd. Con la
      WABA llena, el pedido de dev va a revisión con `sin_lugar`.
    - `scripts/sync-vercel-env.mjs` sirve sólo para lo suyo, en dev: sube siete variables
      (las `GMAIL_*` de la casilla de la plataforma y `CRON_SECRET`) desde `.env.local`, que
      tiene que estar al día. Nunca para QA ni para prd: se niega a esos dos proyectos, que llevan su propio
      cliente OAuth y se cargan con `token-remitente.mts --vercel` (QA y prd, paso 1).
  - **Salió bien si:** `https://claimmix-dev.vercel.app/registro` muestra el bloque «Crear
    cuenta con mi correo» con el desafío de Turnstile.
  - **Si falla:** si no aparece el bloque, falta alguna de las cuatro variables del
    remitente. Toda variable nueva vale recién después del redeploy de A12.
  - **Fuentes:** `src/lib/auth/registro-permitido.ts:53`; `.env.example:312-313`, `:227-228`,
    `:207-208`, `:26`, `:216`, `:327-339`, `:363-378`;
    `src/server/alta/numero-automatico-activo.ts:10`; `scripts/sync-vercel-env.mjs:1-10`,
    `:25-33`, `:44-56`; `src/lib/i18n/es-AR.servidor.ts:853`;
    `src/server/notify/remitente-sistema.ts:94-100`.
- [ ] **2. El deploy y la salud.**
  - **Quién:** [Claude].
  - **Dónde:** la terminal.
  - **Qué hacer:** `pnpm smoke -- --url https://claimmix-dev.vercel.app --expect-commit <SHA>`
    y `GET /api/health` con el `CRON_SECRET` de dev.
  - **Salió bien si:** el chequeo `whatsapp` no dice «sin configurar» ni «graph respondió
    …», y el de `gmail` no está en rojo.
  - **Si falla:** «sin configurar» quiere decir que faltan `WHATSAPP_ACCESS_TOKEN` o
    `WHATSAPP_PHONE_NUMBER_ID` (ver el paso 6). En cualquier otro caso, Claude lee los logs y
    le dice al dueño qué variable falta. Ojo con el presupuesto: `/api/health` y `/configuracion`
    muestran el tope que corta, el mismo que lee `budget.ts`. Con `MONTHLY_BUDGET_USD` en 0 dicen
    «IA frenada» y el chequeo queda amarillo: la IA de los clientes está apagada a propósito.
  - **Fuentes:** `package.json:23`; `docs/TESTING.md:1068`;
    `src/app/api/health/route.ts:413-416`, `:425`, `:591`, `:610`;
    `src/server/ai/tope-mensual.ts:23`; `src/app/(app)/configuracion/page.tsx:165-166`.
- [ ] **3. Alta.**
  - **Quién:** [Dueño].
  - **Dónde:** una ventana privada, `https://claimmix-dev.vercel.app/registro`.
  - **Qué hacer:** el alias de administrador de A3, por el camino del correo. Llega
    un mail del remitente con un enlace a `/alta/correo?t=` que vale 60 minutos. Ahí se
    elige una contraseña de 8 a 128 caracteres y el espacio se crea en el acto.
  - **Salió bien si:** termina en `/bandeja?bienvenida=1`.
  - **Si falla:**
    - `/registro?e=datos`: la empresa, el celular o la casilla de los términos están mal.
    - `/registro?e=celular`: sólo aparece donde `ALTA_NUMERO_AUTOMATICO` está en 1 (hoy, los
      tres: dev y QA desde el lote de A12, D1 b) y el +54 del campo de WhatsApp viene sin el 9.
    - `/registro?e=intentos`: se llegó a un cupo por IP o del día. Esperar al otro día.
    - `registro_cerrado`, o la tarjeta «cerrada» en `/alta`: `ALTA_AUTOMATICA` no vale
      exactamente `1` y la dirección no está en la lista.
    - Aviso de operador: la dirección está en `ADMIN_EMAILS`.
    - Resultado `alta_cerrada` al crear el espacio: se llegó al tope
      `ALTA_TOPE_GLOBAL_DIA` o falta una función de la base.
    - No llega el mail: la respuesta es siempre neutra (`/login?aviso=revisa_tu_correo`).
      Mirar spam y los cupos `ALTA_TOPE_CORREOS_DIA` y `ALTA_TOPE_POR_DESTINATARIO_DIA`.
  - **Fuentes:** `src/app/alta/correo`; `src/app/registro/actions.ts:59`, `:72`, `:73`,
    `:135`, `:159`, `:184`; `src/app/alta/page.tsx:88-89`;
    `src/lib/auth/registro-permitido.ts:52-53`; `src/server/alta/crear-inquilino.ts:52`,
    `:67`, `:79`; `.env.example:232-233`.
- [ ] **4. El espacio nuevo en `/admin/altas`.**
  - **Quién:** [Dueño], con la cuenta de operador.
  - **Dónde:** `https://claimmix-dev.vercel.app/admin/altas`: «Altas» en el menú lateral de
    la cuenta de operador (#461), o tipeando la URL.
  - **Qué hacer:** buscar el espacio del paso 3.
  - **Salió bien si:** el espacio aparece con su contador de 24 h contra el tope.
  - **Si falla:** si la página lleva a `/bandeja`, a la cuenta le falta una de estas
    condiciones: rol owner o admin; correo verificado y en `ADMIN_EMAILS`; sesión en el
    espacio casa, no en un espacio de autoalta. Si el espacio no figura, [Claude] busca el
    alta en los logs.
  - **Fuentes:** `src/app/(app)/admin/altas`, `page.tsx:101-105`;
    `src/lib/auth/require-operator.ts:55-67`; `src/lib/auth/roles.ts:58`;
    `src/lib/auth/provision.ts:50-57`.
- [ ] **5. Base propia: en dev no aplica.**
  - **Quién:** [Automático].
  - **Dónde:** el alta del paso 3.
  - **Qué hacer:** nada. `BASE_POR_CLIENTE` está en 0 (D2).
  - **Salió bien si:** el alta no pasó por `/preparando`.
  - **Si falla:** si pasó, la bandera quedó prendida en dev. Avisar a Claude antes de seguir,
    porque no tiene vuelta.
  - **Fuentes:** `src/app/preparando`; `docs/PROMOCION.md:779-784`.
- [ ] **6. Número de WhatsApp: el de la plataforma.**
  - **Quién:** [Dueño].
  - **Dónde:** el resultado del paso 2 y la tarjeta de Primeros pasos en `/configuracion`.
  - **Qué hacer:** nada que conectar. dev usa el número de la plataforma, ya conectado, que
    cae en el espacio de la plataforma. El espacio de autoalta no tiene número propio
    mientras el dueño no elija la opción del celular (paso 1), y la tarjeta de Primeros pasos lo
    dice.
  - **Salió bien si:** el paso 2 dio `whatsapp` operativo.
  - **Si falla:** leer el detalle del chequeo.
    - «sin configurar»: faltan `WHATSAPP_ACCESS_TOKEN` o `WHATSAPP_PHONE_NUMBER_ID` en ese
      proyecto de Vercel. El dueño los pega desde su registro: es el mismo token permanente
      que ya usan dev y prd.
    - «graph respondió …»: Meta rechazó el pedido. [Claude] lee el código en los logs y el
      dueño revisa en Meta Business Suite que el usuario del sistema y sus permisos sigan
      vigentes.
    - **Nunca generar un token nuevo en Meta ni tocar `WHATSAPP_APP_SECRET`.** El token es
      permanente, y uno nuevo deja sin servicio a los proyectos que usan el actual. El
      comentario del código que lo llama «long-lived» es viejo y no autoriza a
      regenerarlo.
  - **Fuentes:** `.env.example:372`; `src/app/api/health/route.ts:407-415`, `:424`;
    `docs/whatsapp-setup.md:46-48`.
- [ ] **7. Gmail.**
  - **Quién:** [Dueño].
  - **Dónde:** `/configuracion` del espacio de autoalta, «Conectar Gmail».
  - **Qué hacer:** conectar la Gmail del mail agente de dev (A3). La casilla conectada
    también manda las respuestas del agente. **Aviso:** Google muestra una
    pantalla de app no verificada. Es esperable (A6). Para seguir, entrar al enlace de
    opciones avanzadas de esa pantalla y continuar hacia la app.
  - **Salió bien si:** vuelve con `?gmail=connected` y la casilla aparece en el panel.
  - **Si falla:** el resultado dice por qué.
    - `missing_google_config`: faltan `GMAIL_CLIENT_*`.
    - `missing_refresh_token`, `otro_ambiente`, `mailbox_taken`.
    - `save_failed`: no se pudo guardar la casilla.
    - `invalid_state`: se venció el pedido, o se abrió el connect desde un host que no es el
      de `NEXT_PUBLIC_SITE_URL`.
    - Error del servidor a la vuelta: falta `GMAIL_TOKEN_ENCRYPTION_KEY`, porque el token se
      cifra antes de guardar.
  - **Fuentes:** `src/lib/i18n/es-AR.ts:678`; `/api/admin/gmail-accounts/connect`;
    `src/app/api/admin/gmail-accounts/callback/route.ts:93`;
    `src/lib/security/cifrado.ts:38-39`.
- [ ] **8. Segundo usuario.**
  - **Quién:** [Dueño].
  - **Dónde:** `/admin/users` del espacio de autoalta, «Invitar usuario».
  - **Qué hacer:** el alias de analista de A3, con rol analista, sin activar el espacio
    (D4 d): en prueba, el administrador puede invitar a un alias `+` de su propia casilla de
    Gmail, y el de analista es de la misma casilla que el de administrador. El enlace a
    `/invitacion?t=` vale 72 horas. El analista acepta con una contraseña: la pantalla no
    ofrece Google para un alias `+`.
  - **Salió bien si:** el invitado entra y ve la bandeja del espacio con su rol.
  - **Si falla:**
    - «Durante la prueba sólo podés invitar a personas de tu propio dominio de correo o a un
      alias + de tu misma casilla de Gmail»: el espacio está en prueba y la dirección es de
      otro dominio, de un proveedor abierto o un alias de otra Gmail, o la casilla del
      administrador no tiene el correo verificado (D4).
    - Un espacio en prueba invita a lo sumo a cinco personas por día.
    - La pantalla dice «invitación enviada» y el mail no llega nunca: la dirección está en
      `ADMIN_EMAILS` (A3). [Claude] lo confirma con el log `admin_users.invitacion_a_operador`.
    - La invitación termina en `ENVIO_FALLIDO`: el problema es el remitente.
  - **Fuentes:** `src/app/(app)/admin/users`; `src/lib/i18n/es-AR.ts:825`;
    `src/app/invitacion`, `src/app/invitacion/page.tsx:162`;
    `src/lib/i18n/es-AR.servidor.ts:397`; `src/app/api/admin/users/route.ts:85`,
    `:134-153`, `:155-179`; `src/lib/email/reserved.ts:86-98`.
- [ ] **9. Denuncia por WhatsApp.**
  - **Quién:** [Dueño].
  - **Dónde:** el celular personal; la bandeja del espacio de la plataforma.
  - **Qué hacer:** un mensaje al número de la plataforma de dev, parecido al primer escenario
    del ensayo: un choque con lugar, hora, patente, nombre inventado y póliza, sin heridos.
    Después, las fotos.
  - **Salió bien si:** el caso aparece en la bandeja del espacio de la plataforma (no en el de
    autoalta), la respuesta llega al celular y el caso avanza. En un espacio sin la póliza
    cargada el estado final puede ser distinto al del ensayo, que siembra sus propias
    pólizas.
  - **Si falla:** si no llega nada, Claude mira el log del webhook.
  - **Fuentes:** `scripts/rehearse-conversations.mts:340`.
- [ ] **10. Denuncia por mail.**
  - **Quién:** [Dueño].
  - **Dónde:** otra casilla; la bandeja del espacio de autoalta.
  - **Qué hacer:** un mail a la casilla conectada en el paso 7, con un siniestro de ejemplo.
    Por ejemplo, el incendio con una persona internada, que tiene que derivar a un
    especialista.
  - **Salió bien si:** el caso aparece en el espacio de autoalta con canal de correo, en
    `requiere_especialista`, y la respuesta llega a la casilla que mandó. Con el push de dev
    el caso entra en minutos.
  - **Si falla:** sin push, entra con el sondeo diario de `/api/cron/gmail-poll` a las 03:00
    UTC. Si a la mañana siguiente no está, [Claude] busca
    `webhooks_gmail.mailbox_not_connected` en los logs.
  - **Fuentes:** `scripts/rehearse-conversations.mts:387-398`; `vercel.json:6-7`.
- [ ] **11. Lectura del agente.**
  - **Quién:** [Dueño].
  - **Dónde:** cada caso, en `/casos/[id]`.
  - **Qué hacer:** leer lo que contestó el agente. Tiene que pedir lo que falta, no prometer
    cobertura ni montos, derivar si hay heridos y sonar a una persona. Media respuesta puede
    pasar todas las verificaciones y sonar mal, y eso sólo lo ve una persona.
  - **Salió bien si:** las respuestas cumplen los cuatro criterios. Un caso de WhatsApp bien
    resuelto se puede marcar «Usar como ejemplo de referencia».
  - **Si falla:** anotar lo que sobra o falta, con el número de caso, y seguir el paso E2.
  - **Fuentes:** `src/lib/i18n/es-AR.ts:774`.
- [ ] **12. Consumo de los dos espacios.**
  - **Quién:** [Dueño].
  - **Dónde:** en el espacio de autoalta, `/metricas` y `/admin/facturacion`. En el espacio de
    la plataforma, lo mismo, con la cuenta de operador. Para todos los espacios,
    `/admin/cartera`.
  - **Qué hacer:** anotar el gasto de cada espacio y los casos de los pasos 9 y 10.
  - **Salió bien si:** el caso de WhatsApp suma en el espacio de la plataforma y el de correo
    en el de autoalta.
  - **Si falla:** si un caso no suma en ninguno, avisar a Claude. `/configuracion` muestra el tope
    del proyecto entero (`MONTHLY_BUDGET_USD`), no lo que gastó cada espacio.
  - **Fuentes:** `src/app/(app)/metricas`; `src/app/(app)/admin/facturacion`;
    `src/app/(app)/admin/cartera`; `src/app/(app)/configuracion/page.tsx:165-166`.
- [ ] **13. El ensayo, después de cada deploy de dev.** Es el paso E1 de «Ensayo del
  prompt».

## QA: Gonzalo

QA es el proyecto `claimmix-qa`, rama `qa`, base `ep-wispy-flower`, en
`https://claimmix-qa.vercel.app` (`docs/PROMOCION.md:561`). A propósito, no le escribe a nadie:
no tiene token ni número de WhatsApp (hasta que tenga su propia WABA, después de A5) ni casilla
de la plataforma (`docs/PROMOCION.md:323-327`). Los pasos 6, 7 y 10 dependen de D3. Gonzalo no necesita acceso a Vercel, a GitHub ni a las
consolas: eso lo hacen el dueño y Claude. Gonzalo reporta por el canal de D15, con el
ambiente, la hora, una captura y el número de caso.

- [ ] **1. Configuración (parte del lote de A12).**
  - **Quién:** [Claude] mira los nombres; [Dueño] corre el script del remitente y pega el resto
    de los secretos.
  - **Dónde:** Vercel, proyecto `claimmix-qa` > Settings > Environment Variables, entorno
    Production.
  - **Qué hacer:** confirmar o cargar, por nombre:
    - `GMAIL_CLIENT_ID` y `GMAIL_CLIENT_SECRET`, del cliente OAuth propio de QA
      (`claimmix-qa`, A7), no del de `.env.local`; y `ALTA_REMITENTE_CORREO` y
      `ALTA_REMITENTE_REFRESH_TOKEN`, emitido con ese mismo cliente. `/registro` de QA no
      muestra el correo porque los dos nombres de `GMAIL_CLIENT_*` existen pero vinieron
      vacíos del import del 17/09, y el remitente del 15/10 salió del cliente de dev: un
      refresh token sólo anda con el cliente que lo emitió. No hay nada que pegar en Vercel.
      El [Dueño] crea `.env.qa.local` en la raíz del checkout desde el que corre el script
      (lo cubre `.env.*.local` de `.gitignore`), con `GMAIL_CLIENT_ID` y `GMAIL_CLIENT_SECRET`
      de `claimmix-qa`, y corre, antes del merge de #474:
      `pnpm exec tsx --tsconfig tsconfig.rehearsal.json scripts/token-remitente.mts --vercel
      claimmix-qa --correo <casilla>`. El script sube a `claimmix-qa` el ID y el secreto (como
      sensibles, con los ambientes que ya tienen: Production y Preview; si no existen,
      Production) antes de pedir el consentimiento. Después de autorizar la casilla remitente
      en el navegador, sube el remitente. Se niega si `.env.qa.local` trae el mismo cliente
      que `.env.local` o `.env.prd.local`, y con `--vercel` no lee otro archivo. Las variables valen desde el
      próximo deploy: el merge de #474 es el redeploy de QA.
    - `TURNSTILE_SITE_KEY` y `TURNSTILE_SECRET_KEY`, con el hostname de A8.
    - `ALTA_AUTOMATICA` en `1` (D6), o la dirección de Gonzalo en `SIGNUP_ALLOWED_EMAILS`.
    - `ALTA_NUMERO_AUTOMATICO` en `1` (D1, b), **sin** `WHATSAPP_ACCESS_TOKEN`: el alta que pida
      el celular termina en revisión con `sin_credencial` (paso 7).
    - `GMAIL_TOKEN_ENCRYPTION_KEY`, propia de QA y cargada desde el 15/10. Sin ella no se
      puede guardar una casilla.
    - `ADMIN_EMAILS` con la dirección del dueño, para que el dueño opere `/admin/altas` en QA.
      Además, la cuenta del dueño tiene que tener rol owner o admin, correo verificado y
      sesión en el espacio casa de QA (`10000000-0000-0000-0000-000000000001`), no en un
      espacio de autoalta.
    - Lo que no está en la lista de QA vino vacío al importar: hay que mirar cada nombre.
  - **Salió bien si:** después del merge de #474 (el redeploy de QA), `/registro` de QA
    muestra el correo y Turnstile (paso 2).
  - **Si falla:** si `/admin/altas` lleva al dueño a `/bandeja`, falta una de las condiciones
    de operador. Si el token del remitente salió de otro cliente (el de dev, por ejemplo),
    `/registro` muestra el correo pero los mails no salen: correr de nuevo el mismo comando.
  - **Fuentes:** `docs/PROJECT_STATUS.md:5051`; `.env.example:226`, `:312-313`, `:401`,
    `:216`; `scripts/token-remitente.mts:22-37`, `:56-62`, `:79-97`, `:117-132`, `:274-294`,
    `:296-307`; `docs/PROMOCION.md:236-237`, `:248-266`, `:256`, `:280-281`;
    `src/lib/auth/require-operator.ts:55-67`; `src/app/(app)/admin/altas/page.tsx:101-105`.
- [ ] **2. `/registro` de QA.**
  - **Quién:** [Gonzalo].
  - **Dónde:** `https://claimmix-qa.vercel.app/registro`.
  - **Qué hacer:** abrir la página.
  - **Salió bien si:** aparecen el bloque «Crear cuenta con mi correo» y el desafío de
    Turnstile.
  - **Si falla:** si sólo aparece Google, falta alguna de las cuatro variables del remitente
    o el redeploy. Avisar al dueño por el canal de D15.
  - **Fuentes:** `src/lib/i18n/es-AR.servidor.ts:853`.
- [ ] **3. Alta.**
  - **Quién:** [Gonzalo].
  - **Dónde:** `https://claimmix-qa.vercel.app/registro`.
  - **Qué hacer:** la dirección de Gonzalo, por el camino del correo. El enlace a
    `/alta/correo?t=` vale 60 minutos.
  - **Salió bien si:** termina en `/bandeja?bienvenida=1`, y `/configuracion` muestra
    «Primeros pasos», que sólo aparece para quien administra un espacio de autoalta.
  - **Si falla:** los mismos casos que el paso 3 de dev (en QA, con `ALTA_NUMERO_AUTOMATICO` en 1, `?e=celular` sale si el +54 viene sin el 9). Si
    `/alta` muestra el aviso de operador, la dirección de Gonzalo está en `ADMIN_EMAILS` de
    QA.
  - **Fuentes:** `src/lib/i18n/es-AR.servidor.ts:741`;
    `src/app/(app)/configuracion/page.tsx:148-149`.
- [ ] **4. El espacio de Gonzalo en `/admin/altas`.**
  - **Quién:** [Dueño], con la cuenta de operador.
  - **Dónde:** `https://claimmix-qa.vercel.app/admin/altas`.
  - **Qué hacer:** buscar el espacio de Gonzalo.
  - **Salió bien si:** el espacio aparece con su contador de 24 h.
  - **Si falla:** si la página lleva a `/bandeja`, falta una de las condiciones de operador
    del paso 1.
  - **Fuentes:** `src/lib/auth/require-operator.ts:55-67`.
- [ ] **5. Base propia: en QA no aplica.**
  - **Quién:** [Automático]; [Claude] si algo queda trabado.
  - **Dónde:** el alta del paso 3; GitHub Actions.
  - **Qué hacer:** nada para la base (`BASE_POR_CLIENTE` en 0, D2). El barrido de casos
    trabados de QA corre solo cada 2 h (`barrer-trabados.yml`, desde el lote de las notas
    del 14/10); si hace falta antes, [Claude] lo dispara desde Actions, «Run workflow» con
    `url` = `https://claimmix-qa.vercel.app`. Usa el secreto `QA_CRON_SECRET`.
  - **Salió bien si:** el alta no pasó por `/preparando`.
  - **Si falla:** si pasó, avisar a Claude antes de seguir (como el paso 5 de dev).
  - **Fuentes:** `.github/workflows/barrer-trabados.yml:87-89`, `:152`.
- [ ] **6. Gmail (D3: la casilla de prueba de Gonzalo).**
  - **Quién:** [Gonzalo].
  - **Dónde:** `/configuracion`, «Conectar Gmail».
  - **Qué hacer:** la Gmail del mail agente de QA (A3), una casilla de prueba de Gonzalo que
    no se use en dev ni en prd. La casilla conectada también manda las respuestas del agente.
    **Aviso:** Google muestra una pantalla de app no verificada; es esperable. Para seguir,
    entrar al enlace de opciones avanzadas de esa pantalla y continuar hacia la app.
  - **Salió bien si:** vuelve con `?gmail=connected`.
  - **Si falla:** `missing_google_config`: faltan `GMAIL_CLIENT_*`. `redirect_uri_mismatch`
    en la pantalla de Google: falta el callback de QA en el cliente `claimmix-qa` (A7). Error
    del servidor a la vuelta: falta `GMAIL_TOKEN_ENCRYPTION_KEY`. Avisar al dueño por D15.
  - **Fuentes:** `src/app/api/admin/gmail-accounts/callback/route.ts:93`.
- [ ] **7. Número de WhatsApp: QA no tiene token.**
  - **Quién:** [Gonzalo], y el [Dueño] para mirar el resultado en `/admin/altas`.
  - **Dónde:** la tarjeta de WhatsApp de Primeros pasos, en `/configuracion`; el resultado, en
    `https://claimmix-qa.vercel.app/admin/altas`.
  - **Qué hacer:** QA muestra la opción del celular (la bandera va en 1, D1 b) pero no tiene
    token de WhatsApp. Gonzalo elige la opción del celular y pide el código. El [Dueño] mira
    el espacio en `/admin/altas`.
  - **Salió bien si:** el pedido termina en revisión con `sin_credencial` en `/admin/altas`.
    Es el resultado esperado hasta que QA tenga su propia WABA y su propio token (después de
    A5, ver «Después de A5: una WABA y un token por ambiente»). Mientras tanto no hay número
    conectado en QA ni «Prueba real en QA» (`docs/whatsapp-setup.md`).
  - **Si falla:** si QA manda de verdad un código por SMS o por llamada, avisar al dueño: se
    cargó un token de WhatsApp en QA y ocupa el lugar libre de la WABA, que es primero del
    cliente ficticio de prd (D1).
  - **Fuentes:** `src/server/alta/numero-automatico.ts:335`, `:410`;
    `docs/PROMOCION.md:325-327`; `docs/whatsapp-setup.md:359`.
- [ ] **8. Segundo usuario.**
  - **Quién:** [Gonzalo].
  - **Dónde:** `/admin/users`, «Invitar usuario».
  - **Qué hacer:** Gonzalo invita al alias de analista de A3, sin activar el espacio (D4 d):
    en prueba, un alias `+` de la misma Gmail que el alias de administrador entra directo. El
    analista acepta con una contraseña.
  - **Salió bien si:** el invitado entra con su rol.
  - **Si falla:** si sale el rechazo por dominio, el alias es de otra Gmail o la casilla del
    administrador no tiene el correo verificado. Si dice «invitación enviada» y el mail no
    llega, la dirección está en `ADMIN_EMAILS` (A3).
  - **Fuentes:** `src/app/api/admin/users/route.ts:134-153`, `:155-179`;
    `src/lib/email/reserved.ts:86-98`.
- [ ] **9. Denuncia por WhatsApp: el transcripto del ensayo.**
  - **Quién:** [Claude] lo copia; [Dueño] se lo manda; [Gonzalo] lo lee.
  - **Dónde:** el paso «Ensayar las conversaciones» del Post-deploy de QA.
  - **Qué hacer:** sin número, se lee el ensayo. El Post-deploy de QA corre las conversaciones
    y repite las que difieren. [Claude] copia el transcripto en un archivo de texto y el
    dueño se lo manda a Gonzalo por D15.
  - **Salió bien si:** las conversaciones de WhatsApp suenan bien de punta a punta.
  - **Si falla:** Gonzalo anota lo que suena mal con el nombre del escenario y lo manda por
    D15.
  - **Fuentes:** `.github/workflows/deploy-checks.yml:349-359`.
- [ ] **10. Denuncia por mail.**
  - **Quién:** [Gonzalo].
  - **Dónde:** otra casilla, o «Simular nuevo email» en `/bandeja`.
  - **Qué hacer:** con casilla conectada (paso 6), un mail desde otra casilla con un
    siniestro de ejemplo. Sin casilla, «Simular nuevo email».
  - **Salió bien si:** aparece el caso y el agente contesta.
  - **Si falla:** QA no tiene Pub/Sub, así que el mail entra con el sondeo diario de las 03:00
    UTC, o antes si [Claude] llama a `GET /api/cron/gmail-poll` con el `CRON_SECRET` de QA,
    que sondea todas las casillas. Si a la mañana siguiente no está, avisar por D15.
  - **Fuentes:** `vercel.json:6-7`; `src/app/api/cron/gmail-poll/route.ts:48`;
    `src/lib/i18n/es-AR.ts:142`.
- [ ] **11. Varias denuncias juntas.**
  - **Quién:** [Gonzalo].
  - **Dónde:** `/agente`, solapa «Simulación en lote».
  - **Qué hacer:** un lote chico, de 5 a 10 casos. Se admiten de 1 a 50 casos por lote y dos
    lotes cada diez minutos, pero el espacio de Gonzalo está en prueba y corta a los 500.000
    tokens por día: unas 39 llamadas al modelo, y cada caso usa al menos una. Más de unas 39
    llamadas en un día chocan con el tope. Los casos salen como correo simulado.
  - **Salió bien si:** todos terminan en un estado y ninguno queda trabado.
  - **Si falla:** si el lote se corta a mitad, es el tope de la prueba: anotar en qué caso
    cortó y seguir al otro día. Si un caso queda trabado, avisar por D15 (paso 5).
  - **Fuentes:** `src/lib/i18n/es-AR.ts:846`;
    `src/app/api/admin/batch-simulate/route.ts:255`; `src/lib/billing/plans.ts:163-180`.
- [ ] **12. Lectura del agente.**
  - **Quién:** [Gonzalo].
  - **Dónde:** cada caso de los pasos 9 a 11.
  - **Qué hacer:** los mismos criterios que el paso 11 de dev. El espacio nuevo no trae
    reglas ni ejemplos: sólo los patrones globales.
  - **Salió bien si:** las respuestas cumplen los cuatro criterios.
  - **Si falla:** Gonzalo manda por D15 lo que suena mal: ambiente, hora, captura y número de
    caso. El dueño sigue el paso E2.
- [ ] **13. Consumo.**
  - **Quién:** [Gonzalo].
  - **Dónde:** `/metricas` y `/admin/facturacion` del espacio.
  - **Qué hacer:** contar los casos de los pasos 10 y 11.
  - **Salió bien si:** los casos aparecen contados.
  - **Si falla:** si la simulación en lote se cortó, es el tope de la prueba: 500.000 tokens
    por día o el dólar del mes. Avisar por D15.
  - **Fuentes:** `src/lib/billing/plans.ts:180` (`AI_PILOTO_DAILY_TOKEN_CAP`);
    `src/server/ai/budget.ts:464` (`AI_PRUEBA_MONTHLY_USD_POR_INQUILINO`).

## prd: el cliente ficticio

prd es el proyecto `claimmix-prd`, rama `prd`, base de control `neondb` (host `ep-sweet-salad`,
`docs/PROMOCION.md:811`) y una base `t_<hex>` por cliente, en `https://claimmix.vercel.app`
(`docs/PROMOCION.md:562`). El único lugar libre de la WABA va acá primero: la bandera del número
está prendida, falta la prueba de punta a punta y la primera alta real hace de prueba
(`docs/whatsapp-setup.md`, «Estado al 17/10»). Dev y QA reciben la bandera en el lote de A12
(D1, b), pero ninguno ocupa ese lugar antes: QA no tiene token, y en dev nadie pide el código
hasta que esta alta termine y su número se borre (D5), o hasta A5.

- [ ] **1. Configuración (parte del lote de A12).**
  - **Quién:** [Claude] mira los nombres; [Dueño] pega los secretos y corre el script del
    remitente. [Claude] corre los comandos de Google Cloud, con el OK del dueño.
  - **Dónde:** Vercel, `claimmix-prd` > Settings > Environment Variables.
  - **Qué hacer:** confirmar, por nombre, las variables de la tabla «Lo que tiene que quedar
    igual en los tres» que corresponden a prd: `ALTA_AUTOMATICA`, `BASE_POR_CLIENTE`,
    `ALTA_NUMERO_AUTOMATICO`, las dos de Turnstile, el remitente con `GMAIL_CLIENT_*`,
    `GMAIL_TOKEN_ENCRYPTION_KEY`, `PUBSUB_TOPIC`, `PUBSUB_AUDIENCE`,
    `PUBSUB_SERVICE_ACCOUNT`, `ADMIN_EMAILS`, `NEXT_PUBLIC_SITE_URL`,
    `WHATSAPP_ACCESS_TOKEN`, `WHATSAPP_BUSINESS_ACCOUNT_ID`, `WHATSAPP_VERIFY_TOKEN`,
    `NUMEROS_DE_DEV` y los topes `ALTA_TOPE_GLOBAL_DIA`, `ALTA_TOPE_BASES` y `ALTA_TOPE_MB`.
    Las que falten, el dueño las pega a mano en esa pantalla: nunca por script ni por chat.
    Con una excepción: `GMAIL_CLIENT_ID`, `GMAIL_CLIENT_SECRET` y el remitente
    (`ALTA_REMITENTE_CORREO` y `ALTA_REMITENTE_REFRESH_TOKEN`) los carga el dueño con
    `pnpm exec tsx --tsconfig tsconfig.rehearsal.json scripts/token-remitente.mts --vercel
    claimmix-prd --correo <casilla>`, desde `.env.prd.local` (en la raíz del checkout; lo
    cubre `.env.*.local` de `.gitignore`) y con el cliente del proyecto de Google Cloud propio
    de prd (decisión del dueño del 18/10: proyecto propio, cargado por el script, con la misma
    cuenta de facturación). El script sube el ID y el secreto (como sensibles, con los
    ambientes que ya tienen) antes de pedir el consentimiento, y después el remitente. Se
    niega si `.env.prd.local` trae el mismo cliente que `.env.local` o `.env.qa.local`. Las variables valen
    desde el próximo deploy de `claimmix-prd`. El script llama a la CLI de Vercel (`vercel api`)
    con la sesión ya iniciada: si `vercel` no está en el PATH falla con «"vercel" no se
    reconoce…»; se instala con `npm i -g vercel`.
    - **`scripts/sync-vercel-env.mjs` no se usa en prd:** se niega a `claimmix-prd` y a
      `claimmix-qa`, y sólo carga `claimmix` (dev).
    - **Antes: el proyecto de Google Cloud propio de prd.** El cliente de dev no sirve para
      prd: Gmail registra el aviso en un tema del mismo proyecto que el cliente OAuth, y un
      refresh token sólo anda con el cliente que lo emitió. En este orden:
      1. [Claude], con el OK del dueño, una consulta de sólo lectura que confirme que prd no
         tiene casillas conectadas: `SELECT count(*) FROM gmail_accounts` en `neondb` y en
         cada base `t_<hex>` (salen de `tenant_bases`; `cadenaConBase` está en
         `scripts/lib/entorno-de-bases.mjs:38`), con el `DATABASE_URL` de `.env.prd.local`: el
         de la app pasa por RLS y devolvería 0 aunque haya casillas. Si hay una, el cambio de
         cliente la rompe: parar y avisar al dueño.
      2. [Dueño] Crea el proyecto y le asocia la misma cuenta de facturación; publica la
         pantalla de consentimiento; crea el cliente web `claimmix-prd` con dos URI de
         redirección, `https://claimmix.vercel.app/api/admin/gmail-accounts/callback` y
         `http://127.0.0.1:53682/`; y pone su ID y su secreto en `.env.prd.local`.
      3. [Claude], con el OK explícito del dueño para los permisos de IAM, corre en ese
         proyecto (`<PROYECTO>` es su ID y `<PUBSUB_AUDIENCE_ACTUAL_DE_PRD>` el valor que
         hoy tiene `PUBSUB_AUDIENCE` en `claimmix-prd`), con la cuenta dueña del proyecto
         (`gcloud --account <cuenta>`, sin cambiar la configuración global):

         ```bash
         gcloud services enable gmail.googleapis.com pubsub.googleapis.com \
           iam.googleapis.com --project=<PROYECTO>

         gcloud pubsub topics create gmail-push-prd --project=<PROYECTO>
         gcloud pubsub topics add-iam-policy-binding gmail-push-prd --project=<PROYECTO> \
           --member=serviceAccount:gmail-api-push@system.gserviceaccount.com \
           --role=roles/pubsub.publisher

         gcloud iam service-accounts create gmail-push-prd --project=<PROYECTO> \
           --display-name="Push de Gmail de prd"

         gcloud pubsub subscriptions create gmail-push-prd-sub --project=<PROYECTO> \
           --topic=gmail-push-prd \
           --push-endpoint=https://claimmix.vercel.app/api/webhooks/gmail \
           --push-auth-service-account=gmail-push-prd@<PROYECTO>.iam.gserviceaccount.com \
           --push-auth-token-audience=<PUBSUB_AUDIENCE_ACTUAL_DE_PRD> \
           --ack-deadline=60 --message-retention-duration=7d --expiration-period=never

         gcloud pubsub subscriptions describe gmail-push-prd-sub --project=<PROYECTO> \
           --format='value(pushConfig.oidcToken.serviceAccountEmail)'
         ```

         El último comando tiene que imprimir la cuenta que el punto 5 pone en
         `PUBSUB_SERVICE_ACCOUNT`. Sin `--expiration-period=never` la suscripción se borra
         sola después de 31 días sin actividad. En un proyecto creado después del 8/4/2021 el
         agente de servicio de Pub/Sub ya puede firmar el token del push, así que no hace falta
         darle `roles/iam.serviceAccountTokenCreator`.
      4. [Dueño] Corre el script de arriba.
      5. [Claude] Cambia `PUBSUB_TOPIC` de `claimmix-prd` a
         `projects/<PROYECTO>/topics/gmail-push-prd` y `PUBSUB_SERVICE_ACCOUNT` a
         `gmail-push-prd@<PROYECTO>.iam.gserviceaccount.com`. Son nombres, no secretos.
         `PUBSUB_AUDIENCE` queda como está.
      6. Un solo redeploy de `claimmix-prd`, que cuenta como la promoción del día. Entre el
         punto 4 y este redeploy no se promueve nada a prd: cualquier deploy nuevo tomaría el
         cliente nuevo con el tema viejo.
    - `CRON_SECRET` de prd tiene que ser igual al secreto `PRD_CRON_SECRET` de GitHub.
  - **Estado (19/10):** hecho. Puntos 1 a 5 en `claimmix-prd-veltra`, con la app publicada y
    el remitente emitido con `veltra.claimmix@gmail.com`; el punto 6 fue la promoción a prd
    #477 (`48fb6cd6`), con el Post-deploy de PRD en verde. Con OK del dueño, el 19/10 se
    borraron el tema `gmail-push-prd` y la suscripción `gmail-push-prd-sub` viejos del
    proyecto de dev. La cuenta de servicio `pubsub-push-gmail` de ese proyecto queda: también
    la usa la suscripción de dev, `gmail-inbound-push`.
  - **Salió bien si:** después del redeploy, el log del paso «Smoke de prd» del Post-deploy
    PRD lista cada chequeo sin «sin configurar», salvo `whatsapp` hasta el paso 2. Y
    `https://claimmix.vercel.app/registro` muestra el correo, Turnstile y el aviso del número.
  - **Si falla:** [Claude] lee ese log, o pide `GET /api/health` con el `CRON_SECRET` de prd,
    y dice qué variable falta. Si el smoke dice «CRON_SECRET local no coincide», el de Vercel
    y el de GitHub son distintos: el Post-deploy PRD y el barrido quedan en rojo. Si `token-remitente.mts` se niega porque
    `.env.prd.local` trae el mismo cliente que otro ambiente, el archivo quedó con el de dev o
    el de QA: poner el de `claimmix-prd`.
  - **Fuentes:** `docs/PROMOCION.md:723-738`, `:813-845`; `scripts/token-remitente.mts:22-37`,
    `:56-62`, `:79-97`, `:117-132`, `:274-294`, `:296-307`; `scripts/sync-vercel-env.mjs:44-56`;
    `scripts/lib/entorno-de-bases.mjs:19`, `:38`; `src/app/api/webhooks/gmail/route.ts:94`,
    `:164`; `.github/workflows/post-deploy.yml:657-669`, `:660`;
    `scripts/smoke-production.mts:254`, `:265-269`.
- [ ] **2. Requisitos del número por código, antes del alta.**
  - **Quién:** [Dueño] lo que está en Meta; [Claude] el resto.
  - **Dónde:** Meta Business Suite y Vercel (`claimmix-prd`).
  - **Qué hacer:** un paso cerrado. Si falta un requisito, no se hace el paso 4: el alta pide
    el número enseguida, y un intento fallido puede gastar el único lugar libre de la WABA.
    1. [Claude] La migración 0049 está en las bases de prd (A11; comprobado el 15/10).
    2. [Claude] `ALTA_NUMERO_AUTOMATICO` en 1 en prd (ya prendida).
    3. [Dueño] En Meta Business Suite > Usuarios del sistema, el token tiene
       `whatsapp_business_management` y `whatsapp_business_messaging`.
    4. [Dueño] En Meta, la app de ClaimMix está en `subscribed_apps` de la WABA.
    5. [Claude] Por nombre: `WHATSAPP_ACCESS_TOKEN`, `WHATSAPP_BUSINESS_ACCOUNT_ID`,
       `WHATSAPP_VERIFY_TOKEN`, `NUMEROS_DE_DEV`, `ADMIN_EMAILS` y el remitente.
       `NEXT_PUBLIC_SITE_URL` con https (`https://claimmix.vercel.app`).
    6. [Dueño] `WHATSAPP_PHONE_NUMBER_ID`, el id del número de la plataforma. Recomendación:
       cargarla. Sin ella el pedido termina en `sin_credencial`. Con `WHATSAPP_TENANT_ID` y
       `GMAIL_TENANT_ID` vacías, no le asigna el número de la plataforma a ningún espacio de
       prd: ni lo que entra ni lo que sale. `docs/PROMOCION.md:736-738` la deja vacía a
       propósito; si el dueño acepta, [Claude] corrige ese doc.
    7. Un redeploy de `claimmix-prd`, que cuenta como la promoción del día.
  - **Salió bien si:** el chequeo `whatsapp` ya no dice «sin configurar». Se ve en el log del
    paso «Smoke de prd» del Post-deploy PRD, o con `GET /api/health` y el `CRON_SECRET` de prd.
  - **Si falla:** «graph respondió …»: [Claude] lee el código y el dueño revisa los permisos
    del token (punto 3). Nunca generar un token nuevo (dev, paso 6).
  - **Fuentes:** `docs/whatsapp-setup.md:178-205`, `:46-48`; `docs/PROMOCION.md:577-600`,
    `:770`; `src/server/whatsapp/numeros.ts:49-54`, `:174-177`, `:409-411`;
    `src/server/alta/numero-automatico.ts:243`; `src/app/api/health/route.ts:412-415`;
    `.github/workflows/post-deploy.yml:657`; `scripts/smoke-production.mts:265-269`;
    `docs/PROJECT_STATUS.md:5267-5272`.
- [ ] **3. Antes del alta: salud de las bases.**
  - **Quién:** [Claude].
  - **Dónde:** la terminal.
  - **Qué hacer:** `GET /api/health?deep=1` con el `CRON_SECRET` de prd. Ese pedido hace una
    subida real a R2 y una llamada real al modelo: no repetirlo sin motivo. Después,
    `node scripts/purgar-bases.mjs --env prd` (sin `--apply`: sólo lista) para ver si
    quedaron bases sobrantes de pruebas anteriores.
  - **Salió bien si:** `bases.desfase` es `false`, no hay bases en `fallida` ni
    `creandoViejas`, y la lista de sobrantes está vacía.
  - **Si falla:** con desfase, A11. Con sobrantes, el dueño decide cada una (borrar no se
    deshace).
  - **Fuentes:** `src/app/api/health/route.ts:20-25`; `docs/PROMOCION.md:715`.
- [ ] **4. Alta.**
  - **Quién:** [Cliente ficticio].
  - **Dónde:** una ventana privada, `https://claimmix.vercel.app/registro`.
  - **Qué hacer:** la empresa de A2, el alias de administrador de A3, el nombre de quien hace
    de cliente y el celular de la SIM de A4, con el 9. Camino del correo: el mail del
    remitente trae el enlace a `/alta/correo?t=` (60 minutos).
  - **Salió bien si:** pasa a `/preparando`.
  - **Si falla:** los mismos casos que el paso 3 de dev. Acá sí puede salir `?e=celular`: el
    +54 vino sin el 9.
  - **Fuentes:** `src/app/registro/actions.ts:73`.
- [ ] **5. Base propia.**
  - **Quién:** [Automático]; [Claude] si se traba.
  - **Dónde:** `/preparando`.
  - **Qué hacer:** esperar. La pantalla consulta cada 5 segundos mientras se crea la base
    `t_<hex>`.
  - **Salió bien si:** en unos minutos pasa sola a la bandeja.
  - **Si falla:** si a los 15 minutos no terminó, o la base falló, la pantalla ofrece
    «Reintentar» (tres veces cada diez minutos). Si sigue fallando, [Claude], con el OK del
    dueño, corre `pnpm exec
    tsx --tsconfig tsconfig.rehearsal.json scripts/preparar-base.mts --env prd --tenant
    <uuid>`. Además, `/api/cron/reap-stuck` vuelve a lanzar las bases que quedaron a medias:
    lo llama Vercel una vez por día y, en prd, el barrido de Actions cada 2 h.
  - **Fuentes:** `src/app/preparando`; `docs/PROMOCION.md:704`;
    `src/app/api/cron/reap-stuck/route.ts:18-20`; `vercel.json:10-11`;
    `.github/workflows/barrer-trabados.yml:86`.
- [ ] **6. El espacio en `/admin/altas`.**
  - **Quién:** [Dueño], con la cuenta de operador.
  - **Dónde:** `https://claimmix.vercel.app/admin/altas`.
  - **Qué hacer:** buscar el espacio del cliente ficticio.
  - **Salió bien si:** el espacio figura con el número en estado pedido y el contador de 24 h.
  - **Si falla:** si no figura, [Claude] busca el alta en los logs. Si la página lleva a
    `/bandeja`, falta una condición de operador (dev, paso 4).
- [ ] **7. Número de WhatsApp.**
  - **Quién:** [Cliente ficticio]; [Claude] mira los logs.
  - **Dónde:** `/configuracion` (o desde `/preparando`).
  - **Qué hacer:** «Por SMS»; si no llega, «Por llamada». Escribir el código.
  - **Salió bien si:** dice «Listo» y el número queda conectado.
  - **Si falla:** el aviso dice el motivo, y qué hacer ante cada uno está en los docs:
    `sin_lugar` (la WABA está llena o se agotó el cupo diario), `sin_credencial` (paso 2),
    `rechazo`, `sin_webhook` o `incierto`. [Claude] mira en los logs
    `whatsapp.alta_numero.graph` y `alta.numero_en_revision`, y anota los códigos de Meta y si
    el número entró con el 9.
  - **Fuentes:** `src/lib/i18n/es-AR.servidor.ts:728-729`; `docs/whatsapp-setup.md:326-345`,
    `:369-370`.
- [ ] **8. El número en WhatsApp Manager.**
  - **Quién:** [Dueño].
  - **Dónde:** Meta Business Suite > WhatsApp Manager, la WABA de Veltra.
  - **Qué hacer:** mirar el estado del nombre visible del número nuevo.
  - **Salió bien si:** el número figura y el nombre visible está aprobado o en revisión.
  - **Si falla:** si quedó un número sobrante de un intento fallido, borrarlo ahí. ClaimMix
    no borra números, y uno abandonado ocupa el lugar.
  - **Fuentes:** `docs/whatsapp-setup.md:347-348`.
- [ ] **9. Gmail.**
  - **Quién:** [Cliente ficticio].
  - **Dónde:** `/configuracion`, «Conectar Gmail».
  - **Qué hacer:** la Gmail del mail agente de prd (A3). **Aviso:** Google muestra una
    pantalla de app no verificada; es esperable. Para seguir, entrar al enlace de opciones
    avanzadas de esa pantalla y continuar hacia la app.
  - **Salió bien si:** vuelve con `?gmail=connected`. prd tiene push propio
    (`gmail-push-prd`), así que el correo entra en minutos.
  - **Si falla:** con `otro_ambiente`, la casilla figura en `CASILLAS_DE_DEV`. Los demás
    resultados, como en el paso 7 de dev.
- [ ] **10. Segundo usuario.**
  - **Quién:** [Cliente ficticio].
  - **Dónde:** `/admin/users`, «Invitar usuario».
  - **Qué hacer:** invitar al alias de analista de A3, sin activar el espacio (D4 d).
    - En prueba, un alias `+` de la misma Gmail que el alias de administrador entra directo.
      El paso ya no tiene que esperar al 14.
    - El analista acepta con una contraseña: `/invitacion` no ofrece Google para un alias `+`.
    - El espacio sigue en prueba, así que el tope de un dólar del paso 14 sigue valiendo.
    - SSO no sirve para esto: pide un dominio corporativo verificado por DNS y un proveedor
      OIDC.
  - **Salió bien si:** el invitado entra con su rol y ve la misma bandeja.
  - **Si falla:** el texto del rechazo dice si fue por dominio o por tope (cinco por día en
    prueba). Si es por dominio, el alias es de otra Gmail o la casilla del administrador no
    tiene el correo verificado. Si dice «invitación enviada» y el mail no llega, la
    dirección está en `ADMIN_EMAILS` (A3).
  - **Fuentes:** `src/app/api/admin/users/route.ts:85`, `:134-153`, `:155-179`;
    `src/lib/email/reserved.ts:86-98`; `src/app/api/admin/sso/route.ts:6-11`.
- [ ] **11. Denuncia por WhatsApp.**
  - **Quién:** [Dueño].
  - **Dónde:** el celular personal, no la SIM del cliente.
  - **Qué hacer:** un mensaje al número del paso 7 con el choque de ejemplo, y después «ok» y
    «gracias», que no tienen que generar respuesta.
  - **Salió bien si:** el caso aparece en la bandeja del cliente ficticio, no en la de casa, y
    la respuesta llega al celular.
  - **Si falla:** si el mensaje no aparece, [Claude] busca
    `whatsapp.webhook.numero_desconocido` en los logs: el número quedó sin su webhook propio.
  - **Fuentes:** `scripts/rehearse-conversations.mts:545-546`.
- [ ] **12. Denuncia por mail.**
  - **Quién:** [Dueño].
  - **Dónde:** otra casilla.
  - **Qué hacer:** un mail a la casilla del paso 9 con la pregunta de cotización, que no tiene
    que abrir una denuncia, y otro con un siniestro.
  - **Salió bien si:** la cotización queda `no_relevante` sin respuesta, y el siniestro abre un
    caso con respuesta.
  - **Si falla:** si no entra ninguno en media hora, [Claude] busca
    `webhooks_gmail.mailbox_not_connected` en los logs.
  - **Fuentes:** `scripts/rehearse-conversations.mts:483`.
- [ ] **13. Lectura del agente.**
  - **Quién:** [Dueño].
  - **Dónde:** cada caso de los pasos 11 y 12.
  - **Qué hacer:** los criterios del paso 11 de dev. prd no tiene reglas ni ejemplos, así que
    conviene comparar con la misma denuncia en dev: las diferencias son lo que hoy aporta el
    entrenamiento del espacio de dev. En prd, esta lectura es la prueba del prompt: prd no
    ensaya (E3).
  - **Salió bien si:** las respuestas cumplen los cuatro criterios.
  - **Si falla:** anotar con el número de caso y seguir el paso E2.
- [ ] **14. Consumo.**
  - **Quién:** [Dueño].
  - **Dónde:** `/metricas` como cliente; `/admin/cartera` y `/admin/altas` como operador.
  - **Qué hacer:** anotar el gasto del espacio.
  - **Salió bien si:** en prueba, el gasto está debajo del dólar del mes. Con D4 (d) el espacio
    sigue en prueba durante todo el paso, también con el analista adentro. Si el dueño lo
    activa a mano, ya no hay ese tope: el gasto se compara con el presupuesto de prd (US$ 50
    en total).
  - **Si falla:** si el espacio llegó al dólar, el agente deja de analizar y el equipo recibe
    un mail por día. Esperar al mes siguiente o que el dueño active el espacio con cuota 0
    desde `/admin/altas`.
  - **Fuentes:** `docs/PROMOCION.md:733-734`; `src/server/notify/specialist-alert.ts:344-352`.
- [ ] **15. Las 24 h siguientes: los logs.**
  - **Quién:** [Claude].
  - **Dónde:** los logs de prd.
  - **Qué hacer:** buscar los eventos `whatsapp.webhook.numero_desconocido` y
    `webhooks_gmail.mailbox_not_connected`; las respuestas 403 de `/api/auth` con el código
    `INVALID_ORIGIN` de better-auth (se buscan por estado 403 en `/api/auth`: no es un evento
    del código); y los 404 de `/denuncia`.
  - **Salió bien si:** no aparece ninguno.
  - **Si falla:** Claude le dice al dueño qué apareció y qué variable o paso lo explica. Un
    `INVALID_ORIGIN` suele ser `NEXT_PUBLIC_SITE_URL` mal cargada.
  - **Fuentes:** `docs/PROMOCION.md:296-299`, `:773-777`.
- [ ] **16. El cliente ficticio, según D5.**
  - **Quién:** [Dueño]; [Claude] la purga, con OK.
  - **Dónde:** `/admin/altas`; WhatsApp Manager; la terminal.
  - **Qué hacer:** si Veltra no está verificada, borrar el número del cliente ficticio en
    WhatsApp Manager para liberar el lugar de la WABA, y suspender el espacio en
    `/admin/altas`. Si además se borra la base, [Claude] corre `node scripts/purgar-bases.mjs
    --env prd --tenant <uuid> --apply`. **El borrado de la base no se puede deshacer.**
  - **Salió bien si:** el espacio figura suspendido, y el número ya no está en la WABA.
  - **Si falla:** si la purga da error, [Claude] la vuelve a listar sin `--apply` y se lo
    muestra al dueño.
  - **Fuentes:** `docs/PROMOCION.md:715`; `docs/whatsapp-setup.md:347-348`.

## Si prueban otros en prd

Para quien no es el dueño ni Gonzalo y prueba ClaimMix en prd.

- **Quién manda el enlace:** [Dueño]. El enlace es `https://claimmix.vercel.app/registro`.
  Texto sugerido: «Probá ClaimMix con una empresa inventada y datos inventados, nunca de
  asegurados reales. Usá un correo que puedas abrir. Si algo no anda, mandame una captura con
  la hora».
- **Qué van a ver:** el alta con correo o Google, Turnstile, la base propia en
  `/preparando` y la pantalla de app no verificada de Google al conectar Gmail. **No van a
  tener número propio de WhatsApp:** mientras Veltra no esté verificada, el lugar libre lo
  ocupa el cliente ficticio y el pedido siguiente termina en revisión con `sin_lugar`.
- **Cómo reportan:** por el canal de D15, con el ambiente, la hora, una captura y, si lo hay,
  el número de caso.
- **Quién mira:** [Dueño], `/admin/altas` una vez por día. Al operador le llega un mail
  cuando las altas del día llegan al 80 % del tope.
- **Los topes con que chocan, y qué hacer:**
  - `ALTA_TOPE_GLOBAL_DIA` (5 altas por día en prd): el alta termina en `alta_cerrada`.
    Esperar al otro día o subir la cifra (D7).
  - `ALTA_TOPE_BASES` (30) y `ALTA_TOPE_MB` (350): suspender los espacios de prueba
    abandonados y, con OK por cada uno, purgar su base, que no se deshace.
  - 100 usuarios de Google entre dev, QA y prd: pedir la verificación (D10).
  - US$ 1 de IA por espacio y US$ 30 entre todas las pruebas: el agente deja de analizar.
    Activar con cuota 0 a quien siga probando, a mano desde `/admin/altas`, o esperar al mes
    siguiente.
  - Invitaciones: cinco por día y, en prueba, del mismo dominio o un alias `+` de la propia
    casilla de Gmail (D4 d).
- **Fuentes:** `docs/whatsapp-setup.md:283-299`; `src/server/alta/aviso-operador.ts:30-35`;
  `docs/PROMOCION.md:727-734`; `src/server/alta/crear-inquilino.ts:52-62`, `:79`.

## Ensayo del prompt

El pedido 4: correr el prompt de nuevo cada vez que cambia algo del agente.

- [ ] **E1. El ensayo, después de cada deploy de dev o QA.**
  - **Quién:** [Claude].
  - **Dónde:** la terminal; el Post-deploy de QA ya ensaya solo.
  - **Qué hacer:** `pnpm check` completo después de cada deploy, y `pnpm check --local`
    mientras se trabaja. Para un solo escenario, `pnpm rehearse <escenario>`.
  - **Salió bien si:** todas las conversaciones pasan.
  - **Si falla:** si el rojo es del Post-deploy, leer el log del paso fallido (`--log-failed`)
    y hacer hasta dos reruns. Si sigue rojo, el escenario solo con `pnpm rehearse
    <escenario>` y `pnpm smoke` como evidencia.
  - **Fuentes:** `package.json:22`, `:23`, `:28`; `scripts/check-everything.mts:43-46`;
    `docs/TESTING.md:186-188`; `docs/PROJECT_STATUS.md:5273`; `AGENTS.md`, «Probar cambios».
- [ ] **E2. Leer el transcripto.**
  - **Quién:** [Dueño]; en QA, Gonzalo con el texto del paso 9.
  - **Dónde:** el transcripto que imprime el ensayo.
  - **Qué hacer:** leerlo con los criterios del paso 11 de dev.
  - **Salió bien si:** las respuestas suenan a una persona y cumplen los criterios.
  - **Si falla:** hay dos caminos.
    - Una regla en la consola del espacio: `/agente`, solapa «Reglas de prompt». Vale sólo para
      ese espacio, así que agranda la excepción de la fila «Entrenamiento del agente».
    - [Claude] cambia el prompt con un PR a `qa` y `pnpm check`, y el mismo día a main y prd.
      Es el camino que mantiene iguales los tres.
  - **Fuentes:** `src/lib/i18n/es-AR.ts:852`; `docs/PROJECT_STATUS.md:5055-5063`.
- [ ] **E3. prd no ensaya, a propósito.**
  - **Quién:** [Dueño].
  - **Dónde:** prd, pasos 11 a 13.
  - **Qué hacer:** en prd la prueba es la denuncia manual. Después de una promoción que toque
    el agente, repetir los pasos 11 y 12 de prd con un caso nuevo.
  - **Salió bien si:** el paso 13 de prd sale bien.
  - **Si falla:** E2.
  - **Fuentes:** `docs/PROMOCION.md:596-599`.

## MCP de WhatsApp (opcional)

El pedido 5. Un MCP le deja a Claude mandar mensajes de WhatsApp por la misma API oficial, para
operar o probar. **No es lo que hace que ClaimMix reciba denuncias**, y no hace falta para el
alta. Recomendación: no instalarlo (D14).

- [ ] **M1. Sólo si el dueño lo quiere.**
  - **Quién:** [Dueño + Claude].
  - **Dónde:** la configuración local de Claude en la máquina del dueño (`.mcp.json`, que el
    repo ignora). **Nunca en el repo.**
  - **Qué hacer:** instalar uno de los dos servidores que nombra la Parte D de
    `docs/whatsapp-setup.md` (los dos usan la API oficial de Meta), según su README. Usa las
    mismas credenciales de Meta: el token permanente de `WHATSAPP_ACCESS_TOKEN`, el id del
    número y el de la WABA. **Riesgo:** ese token queda en manos de código de terceros que
    ClaimMix no revisó, y es el mismo que usan dev y prd. Nunca usar un servidor que empareje
    una cuenta personal por QR.
  - **Salió bien si:** Claude lee las plantillas de la WABA, o manda un mensaje de prueba al
    celular del dueño.
  - **Si falla:** desinstalarlo y borrar su entrada de la configuración local. No afecta al
    alta.
  - **Fuentes:** `docs/whatsapp-setup.md:93-128`; `.gitignore:88`.

## Cuánto consume

**Dónde mirar.**

- `/metricas`: cualquier rol del espacio.
- `/admin/facturacion`: administración del espacio. Trae `cost_per_billable_claim_usd`, lo más
  parecido a un costo por denuncia que existe hoy.
- `/admin/cartera` y `/admin/altas`: operador, todos los espacios.
- `/api/admin/provider-usage` (`src/app/api/admin/provider-usage`): llamadas y latencia, sin
  dólares.
- `/api/health` con `CRON_SECRET`: pasa a degraded al 80 % del presupuesto mensual y a down al
  100 %, y el barrido de Actions lo muestra amarillo o rojo. Con `MONTHLY_BUDGET_USD` en 0
  dice «IA frenada» y queda en degraded, no en down, para no tumbar el deploy.
- Fuera de ClaimMix: la consola de Google Cloud (Facturación) para el gasto real de Vertex, la
  consola de Neon para los MB de cada proyecto, el panel de Vercel para el uso, y Actions para
  los minutos.
- Los 100 usuarios de Google: ClaimMix no lleva la cuenta (no existe). El dueño la mira en la
  consola de Google y la anota al lado de cada cuenta de prueba (ítem 8 del plan).

**Topes, en el orden en que cortan.** Prueba vencida; presupuesto mensual del proyecto
(`MONTHLY_BUDGET_USD`, 200 por omisión, de todos los espacios menos la demo; `.env.example:193`); tope diario por espacio (`AI_TENANT_DAILY_TOKEN_CAP`, 5 M por
omisión); tope de lo anónimo (`AI_ANONIMO_DAILY_TOKEN_CAP`, 60 % del anterior); tope por usuario
(`AI_USER_DAILY_TOKEN_CAP`, 2 M en el código; `.env.example:184` trae 100000 de ejemplo); y,
en prueba, el dólar por espacio, el pozo de US$ 30 entre todas las pruebas y los 500.000 tokens
diarios del plan piloto (unas 39 llamadas al p95 de 12.730 tokens, `src/lib/billing/plans.ts:163-180`).

**Avisos.** Cuando un tope deja sin analizar las denuncias de un espacio (cualquiera menos el
de una persona), el equipo del espacio recibe un mail por día, que sale de la casilla de Gmail
que el espacio conectó; sin casilla conectada, el aviso no sale
(`src/server/notify/specialist-alert.ts:344-352`, `src/server/worker/extract.ts:862-863`).
Al operador sólo le llega el aviso de que las altas del día llegaron al 80 % del tope, desde
la casilla remitente (`src/server/alta/aviso-operador.ts:30-35`).

**Costo por caso.** No existe: el uso de IA no se guarda por caso. Se aproxima con el paso C1.
El costo que muestra ClaimMix es estimado a precio de lista (`src/server/ai/budget.ts:72`), con
los tokens en caché cobrados enteros, así que la factura de Google puede salir algo menor. El
costo con `gemini-3.8-flash` no está medido; se estima en unas cinco veces el de 2.5
(`docs/PROJECT_STATUS.md:4871`).

- [ ] **C1. Medir el costo por caso.**
  - **Quién:** [Dueño] dispara el lote y le pasa los números a [Claude]; [Claude] hace la
    cuenta y la anota en esta guía.
  - **Dónde:** dev, el espacio de la plataforma, que no está en prueba y no lo cortan los
    topes de la prueba. Si no, un espacio activado a mano desde `/admin/altas`. `/agente`,
    «Simulación en lote», y `/admin/facturacion`.
  - **Cuándo:** después del paso 12 de dev.
  - **Qué hacer:** anotar el gasto del mes en `/admin/facturacion`; correr un lote de 20
    casos; esperar a que terminen; volver a anotar.
  - **Salió bien si:** la diferencia de gasto dividida por los casos terminados da el costo
    medio por caso simulado, y queda anotado con la fecha y el modelo.
  - **Si falla:** si corta un tope, anotar en qué caso cortó, y repetir al otro día o en un
    espacio activado. No medir en un espacio en prueba: el dólar del mes y los 500.000 tokens
    cortan antes y el número sale mal.
  - **Fuentes:** `src/lib/i18n/es-AR.ts:846`; `src/server/ai/budget.ts:464`, `:585-587`;
    `src/lib/billing/plans.ts:180`.

**Límites de los planes gratis.**

- Vercel Hobby: crons a lo sumo diarios, un tope diario de builds compartido por los tres
  proyectos y uso no comercial (`docs/PROMOCION.md:586-589`, `:809-810`).
- Google OAuth sin verificar: 100 usuarios por proyecto, entre dev, QA y prd.
- GitHub Actions: gratis desde que el repo es público; los flujos programados se apagan tras 60
  días sin commits.
- Neon Free: 500 MB por proyecto (`docs/PROMOCION.md:727-728`); por eso el plan de prd pone
  `ALTA_TOPE_MB` en 350. Las horas de cómputo de Neon y los límites de R2 no están documentados.
- Meta: 2 números por portfolio mientras Veltra no esté verificada.

## Plan para que el alta sea automática

Los ítems 1, 5, 6 y 12 entraron por #461, el 2 y el 3 por #475, y el 4, el 11 y el 13 por #484, y el 9 por #487 (lote 1 de la prueba del alta), y el 14 en el lote de las notas del 14/10, y el 10 en la rama `ci/paridad-banderas`. El resto no existe todavía: sus nombres de
archivos, funciones y textos son propuestas. Van numerados por prioridad (1 es lo primero), y cada uno entra por el camino de
siempre: PR a `qa`, `pnpm check`, main y prd el mismo día. Tamaño: chico (un PR de un día),
mediano (unos días) o grande (una semana o más, o una migración). Entre paréntesis, el nombre
que tenía en la versión anterior de esta guía.

| # | Ítem | Qué gana el dueño | Qué cambia para el cliente | Hecho cuando | Tamaño | Depende de |
|---|---|---|---|---|---|---|
| 1 | Enlace a `/admin/altas` en el menú del operador (P12) | No tiene que tipear la URL | Nada | El operador ve el enlace en el menú lateral y un admin de un cliente no lo ve. **Hecho en #461** | chico | nada |
| 2 | Gmail: mismo origen en el connect y el callback, casilla vencida visible en el panel, `--solo` en `sync-vercel-env.mjs` y una URI de redirección por host en PROMOCION (P10) | Deja de ver «conectada» con un token revocado; sincroniza una variable sin copiar la casilla de dev | Ve que su casilla venció y la reconecta | Una casilla con el permiso revocado aparece vencida en `/configuracion`, y un test fija el origen. **Hecho en #475** | mediano | nada |
| 3 | Banderas del alta en `/api/health`, detrás de `CRON_SECRET`: sólo booleanos, números y nombres de modo (P1) | Sabe qué está prendido en cada ambiente sin abrir Vercel | Nada | `/api/health` de los tres lista las banderas, y la revisión de seguridad (Fable u Opus) la aprueba. **Hecho en #475** | mediano | nada |
| 4 | El número conectado a mano desde `/admin/altas` también fija su webhook, y el panel muestra los lugares libres de la WABA (P9) | Conectar un número a mano deja de depender de la Callback URL de la app de Meta | Su número recibe mensajes en el ambiente correcto | Un número conectado a mano recibe un mensaje en su espacio, y el panel muestra los lugares libres; revisión de seguridad aprobada. **Hecho en #484**, con la revisión de Fable sin hallazgos. Falta probarlo con una persona: un número con lugar libre en la WABA, conectado a mano, recibe un mensaje. Hasta A5, no conectar a mano en dev un número de prd: dev le pondría su webhook | mediano | nada |
| 5 | Tiempos del alta en `/admin/altas`: mediana y p95 de 30 días, desde `tenant_bases` (P6) | Ve cuánto tarda la base sin pedir SQL | Nada | `/admin/altas` de prd muestra los dos números. **Hecho en #461** | chico | nada |
| 6 | `/configuracion` y `/api/health` muestran el tope real de `MONTHLY_BUDGET_USD` (nuevo) | El semáforo y la pantalla dicen la cifra que corta | Ve su tope real | Con `MONTHLY_BUDGET_USD` en 50, las dos muestran 50; con 0, dicen «IA frenada», porque el guardia frena. **Hecho en #461.** Que 0 quiera decir «sin tope» lo decide el dueño | chico | nada |
| 7 | Aviso por mail al operador al 80 % y al 100 % del presupuesto, del pozo de pruebas, de las bases y de los MB (P3) | Se entera antes del corte | No se queda sin servicio sin aviso | Un tope de prueba bajado a mano en QA dispara el mail | mediano | Decisión: las cifras de `ALTA_TOPE_MB` y `ALTA_TOPE_BASES`, iguales en los tres |
| 8 | Aviso de los 100 usuarios de Google y de los lugares libres de la WABA (nuevo) | Sabe cuántos lugares quedan antes de que un cliente choque | No queda trabado en Google ni en `sin_lugar` sin que nadie lo sepa | El operador recibe un mail al llegar a 80 usuarios y cuando la WABA se llena | mediano | 4 y 7 |
| 9 | Prueba automática del alta por el enlace del correo, de punta a punta, en QA: `pnpm alta:probar` (`scripts/probar-alta.mts`), un guión nuevo. No parte de `pnpm onboard`, que prueba el alta de un inquilino por el operador y no la autoalta (nuevo) | Cada deploy de QA prueba `/registro`, el alta por el enlace del correo y la base (la función de la 0048 y los cupos por red) sin una persona. No prueba Turnstile, Gmail ni el alta con Google: siguen a mano | Menos altas rotas | El job «Alta automática en QA» corre en el Post-deploy de QA y queda rojo si el alta se rompe o QA queda sucia. Si no puede probar (red, tope de QA lleno, otro commit, candado ocupado) sale verde y el resumen del run dice «corrió SIN PODER PROBAR». **Hecho con el merge del lote 1** (`docs/TESTING.md`, capa 11). El lote 2 queda pendiente del dueño | grande | 3 |
| 10 | `pnpm paridad` y un job en el Post-deploy que compara los tres ambientes (P2) | La regla de iguales se comprueba sola en cada deploy | Nada | El job lista las diferencias contra la tabla de excepciones. **Hecho en la rama `ci/paridad-banderas`**: corre en cada deploy, al lado de los chequeos, sólo avisa (`::warning` y resumen del run) y nunca pone rojo; en el log público salen las claves, no los valores | mediano | 3. Decisión del dueño: si algún día bloquea en vez de avisar |
| 11 | Una vista de consumo en `/admin/cartera`: IA, pruebas, bases, MB y costo medio por denuncia (P4) | Una sola pantalla en vez de cuatro | Nada | `/admin/cartera` muestra los cinco números por espacio. **Hecho en #484** | mediano | nada |
| 12 | `.env.example` completo y fijado por un test (P11) | Las variables que faltan dejan de faltar en silencio | Nada | Un test falla si el código lee una variable que no está en `.env.example`. **Hecho en #461** | chico | nada |
| 13 | Registro único de topes, `src/lib/topes.ts` (P0) | Los topes se leen en un solo lugar | Nada | Todos los topes salen de ese archivo. **Hecho en #484**; `tests/unit/lib/topes-unico.test.ts` lo fija | mediano | nada. Los ítems 3, 7 y 10 se pueden hacer sin él |
| 14 | Barrido programado de QA en `barrer-trabados.yml` (P13) | Nada que disparar a mano | Nada | La corrida programada aparece en Actions. **Hecho en el lote de las notas del 14/10**, cada 2 h como prd. | chico | Nada (cadencia fijada en cada 2 h) |
| 15 | Costo por caso: una migración que agrega el caso al uso de IA, con mediana y p95 (P5) | Sabe cuánto cuesta cada denuncia, sin C1 | Nada | `/admin/facturacion` muestra el costo por caso | grande | Decisión: si vale una migración en todas las bases (receta de pausa para migrar) |
| 16 | `/alta` con un dominio que ya tiene espacio: botón «pedir acceso» y mail a sus administradores, con respuesta neutra (P7) | Menos pedidos a mano | Llega al espacio de su empresa sin escribirle a nadie | Un alta con un dominio existente manda el mail a los administradores | mediano | Decisión: revierte `src/app/alta/page.tsx:19-23` |
| 17 | Comprobar en qué zona horaria cortan el día y el mes del presupuesto, y fijarla (P14) | Los cortes coinciden con el mes que mira | El corte diario cae a una hora previsible | Un test fija la zona | chico | Decisión: mes argentino o mes de la factura de Google (supuesto: argentino) |
| 18 | Correo que no sea Gmail (nuevo). Hoy no existe: sólo hay webhooks de Gmail y de WhatsApp (`src/app/api/webhooks`). Mientras tanto, el formulario web de `/denuncia/[slug]`, que se prende en `/agente`, solapa «Formulario web» | Puede vender a quien no usa Gmail | Conecta su correo, sea cual sea | Un cliente con otro proveedor recibe denuncias por correo | grande | Decisión: qué proveedores |
| 19 | Cobro y activación sin operador (nuevo). Hoy no existe: activar es un paso del operador | No activa a mano cada cliente que paga | Paga y queda activo solo | Un pago de prueba activa el espacio sin tocar `/admin/altas` | grande | Decisión: medio de pago y lo que pida el abogado |
| 20 | El entrenamiento base llega a cada espacio nuevo sin sembrarlo (P8) | Un cliente nuevo arranca con el mismo agente que dev | Mejores respuestas desde el primer caso | Un espacio nuevo de prd responde con las reglas base | grande | Bloqueado por «El agente aprende de la consola» (`docs/PROJECT_STATUS.md:5055-5063`) |

**Lo que no se puede automatizar, y por qué.**

- Los trámites de Meta: la verificación del negocio, Tech Provider, App Review y la configuración
  de Embedded Signup (`META_ES_CONFIG_ID`, `.env.example:270`). Los hace una persona en la
  consola de Meta.
- El código por SMS o llamada: lo tipea el cliente, que es quien tiene la SIM. La aprobación de
  plantillas la decide Meta.
- Borrar números de la WABA: ClaimMix no lo hace; se hace en WhatsApp Manager.
- La verificación de Google OAuth: la pide el dueño, y verificar permisos restringidos de Gmail
  puede exigir una evaluación paga, que choca con no sumar planes pagos.
- Las URI de redirección, el consentimiento, Pub/Sub y las alertas de facturación en la consola
  de Google, y los hostnames de Turnstile en Cloudflare: viven fuera del repo y piden la sesión
  del dueño.
- Cargar el valor de un secreto en Vercel: sólo el dueño.
- El consumo real de Neon: sólo se ve en su consola.
- Aplicar una migración: se aplica a mano en cada base, porque los deploys no corren
  migraciones.
- Elegir las cifras de los topes, los textos legales y lo que pida el abogado.
- Leer los transcriptos del ensayo y juzgar si una respuesta suena bien.
- Las altas de punta a punta con correo y SIM reales.
- Las decisiones del dueño.

## Cuando entra un cliente real

Antes de todo, una pregunta al cliente: **qué correo usa para recibir denuncias.** Sólo existe
conexión para Gmail y Google Workspace («Conectar Gmail»). Para otro proveedor no existe
(ítem 18 del plan); mientras tanto, el formulario web de `/denuncia/[slug]` y WhatsApp.

Con todo lo anterior hecho, a un cliente real le queda:

- [ ] 1. [Cliente] `/registro` con su empresa, su correo y su celular; confirmar el correo con
  el enlace (60 minutos) o entrar con Google. Salió bien si llega a `/preparando`. Si falla,
  los casos del paso 3 de dev.
- [ ] 2. [Automático] La base propia en `/preparando`. Salió bien si pasa sola a la bandeja. Si
  falla, el paso 5 de prd.
- [ ] 3. [Cliente] El número: una SIM libre, «Por SMS» o «Por llamada» y el código. Salió bien
  si dice «Listo». Mientras Veltra no esté verificada, a partir del segundo número todo va a
  revisión con `sin_lugar`: el dueño sigue el paso 2 de la lista de abajo.
- [ ] 4. [Cliente] «Conectar Gmail» con la casilla donde recibe las denuncias, pasando la
  pantalla de app no verificada. Salió bien si vuelve con `?gmail=connected`. Si falla, los
  resultados del paso 7 de dev.
- [ ] 5. [Cliente] Invitar a su equipo desde `/admin/users`: en prueba, sólo direcciones de su
  propio dominio o un alias `+` de su propia casilla de Gmail (D4 d), y hasta 5 por día. Salió
  bien si cada invitado entra con su rol. Si falla, el texto del rechazo dice si fue por
  dominio o por tope.

Y al dueño:

- [ ] 1. [Dueño] Mirar el espacio nuevo en `/admin/altas`: número, casilla y estado. Si no
  figura, [Claude] busca el alta en los logs.
- [ ] 2. [Dueño] Si el número quedó en revisión, resolverlo según la tabla de
  `docs/whatsapp-setup.md:326-345`. Si el motivo es `sin_webhook`, el número quedó conectado
  pero sin su webhook propio; qué hacer está en `docs/whatsapp-setup.md:345`.
- [ ] 3. [Dueño] Si hace falta, extender la prueba (de 1 a 90 días, nunca acorta) desde
  `/admin/altas`. Salió bien si la fecha de vencimiento cambió.
- [ ] 4. [Dueño] Cuando paga, activarlo desde `/admin/altas` con su plan y su cuota: deja de
  estar en prueba y se le levantan los topes de la prueba
  (`src/server/alta/panel-operador.ts:1224-1229`). Salió bien si `/admin/cartera` lo muestra
  activo.
- [ ] 5. [Dueño] Contar el cliente contra el tope de 100 usuarios de Google y contra los MB de
  Neon.

## Decisiones pendientes del dueño

A1 resume las que traban algo, con su recomendación. Acá va el detalle.

- **D1. El número por código.** Estaba prendido sólo en prd (desde el 09/10); desde el 17/10
  lo está en los tres, y nunca se probó contra Meta en vivo. Opciones: (a) apagarlo en prd
  hasta probarlo en otro lado; (b)
  prenderlo también en dev y QA, sabiendo que ocupa el único lugar libre de la WABA mientras
  el negocio no esté verificado, y que QA no tiene token de WhatsApp; (c) dejarlo como está y
  que el alta del cliente ficticio de prd sea la prueba, como proponía
  `docs/whatsapp-setup.md` antes del 17/10. **Recomendación: (c).** **Elegido el 17/10: (b).**
  La bandera va en 1 en los tres y se carga en el lote de A12. El único lugar libre de la WABA
  actual es primero del cliente ficticio de prd, y en dev nadie pide el código hasta que esa
  alta termine y su número se borre (D5), o hasta A5. QA no tiene token: su alta por código va a
  revisión con `sin_credencial`. `docs/whatsapp-setup.md` y `docs/PROJECT_STATUS.md` ya lo dicen.
- **D2. `BASE_POR_CLIENTE` en dev y QA.** Los docs la dejan en 0 para siempre en dev y QA
  (`docs/PROMOCION.md:784`); la regla de ambientes iguales pide lo mismo que prd. Prenderla en
  dev dejaría huérfanos los datos de dev en la base de control, y no existe herramienta para
  pasarlos. No tiene vuelta. **Recomendación: 0, como excepción declarada a «iguales».**
  **Elegido el 17/10:** 0 en dev y QA.
- **D3. QA con canales reales.** QA no le escribe a nadie, a propósito. **Recomendación:** una
  casilla de Gmail de prueba de Gonzalo, que sólo contesta a quien le escribe; número de
  WhatsApp no, porque ocuparía el único lugar libre de la WABA y QA no tiene token. **Elegido
  el 17/10:** la casilla de Gmail de prueba de Gonzalo; sin número de WhatsApp hasta que QA
  tenga su propia WABA y su propio token (después de A5).
- **D4. Invitaciones en un espacio en prueba.** Con gmail.com se rechazan, salvo en la opción
  (d). Opciones: (a) usar direcciones de un dominio propio que no sea un proveedor abierto;
  (b) activar el espacio desde `/admin/altas` con cuota 0, que levanta los topes de la prueba
  y lo cuenta como activo en la cartera; (c) quedarse con el rechazo como resultado esperado,
  y el pedido 3 queda sin cumplir en prd; (d) dejar que el administrador invite a un alias `+`
  de su propia casilla de Gmail, que tiene que tener el correo verificado: la invitación sale
  sola y no activa nada. SSO no sirve: pide un dominio corporativo verificado por DNS y un
  proveedor OIDC (`src/app/api/admin/sso/route.ts:6-11`). **Recomendación: (a) si el dueño
  tiene el dominio; si no, (b), sabiendo que cambia el paso 14 de prd.** El 17/10 quedó
  anotada (a). **Corregido el 20/10: (b).** No hay dominio propio: todo es Gmail.
  **Corregido el 21/10 (#489): (d).** El administrador de cada espacio de prueba invita al
  analista como un alias `+` de su misma Gmail, sin esperar a que el dueño active el espacio
  y sin pasar por el paso 14 de prd. No se abre nada hacia afuera: Gmail entrega el alias en la
  casilla del propio administrador, así que el mail del remitente nunca llega a un tercero. Un
  alias de otra Gmail o una casilla sin verificar sigue rechazado por dominio. Para invitar a
  un compañero con su propia Gmail hace falta (b) o (a); el botón de activación de
  `/admin/altas` no cambió.
- **D5. El cliente ficticio de prd, después.** Conservarlo como cliente de prueba permanente
  (ocupa una base, MB y el número) o suspenderlo y purgar su base, que no se deshace.
  **Recomendación:** si Veltra sigue sin verificar, borrar su número en WhatsApp Manager para
  que el primer cliente real tenga lugar, y suspender el espacio; purgar la base sólo si hacen
  falta los MB. **Elegido el 17/10:** la recomendación.
- **D6. `ALTA_AUTOMATICA` en QA.** Prenderla para que Gonzalo haga autoalta, o poner sólo la
  dirección de Gonzalo en `SIGNUP_ALLOWED_EMAILS`. **Recomendación: prenderla en 1**, igual que
  dev y prd. **Elegido el 17/10:** 1 en QA.
- **D7. Cifras de los topes:** `ALTA_TOPE_GLOBAL_DIA`, `ALTA_TOPE_BASES`, `ALTA_TOPE_MB`,
  `MONTHLY_BUDGET_USD` y los `AI_*`. **Recomendación:** los del alta y los de la prueba, iguales
  a prd en los tres. `MONTHLY_BUDGET_USD` y `AI_TENANT_DAILY_TOKEN_CAP`, excepción en dev y QA:
  ahí gasta el ensayo, unos 1,5 M de tokens por corrida, y el tope de dev y QA tiene que ser
  igual a la variable del repo (`docs/PROMOCION.md:283-292`). **Elegido el 17/10:** la
  recomendación.
- **D8. Quién es operador en cada ambiente** (`ADMIN_EMAILS`, que habilita junto con el rol
  owner o admin, el correo verificado y la sesión en el espacio casa), si Gonzalo lo es en QA,
  y si se unifican los tres lectores de esa variable, que cambia quién es administrador
  (`docs/AUDITORIA-2026-09.md:438`, `:543`). **Recomendación:** el dueño en los tres; Gonzalo
  no, porque una dirección de operador no puede hacer autoalta. **Elegido el 17/10:** el dueño
  es operador en los tres y Gonzalo no lo es en QA.
- **D9.** Pedir la verificación del negocio en Meta (A5).
- **D10.** Seguir con el tope de 100 usuarios de Google o pedir la verificación, que puede ser
  paga.
- **D11.** Vercel Hobby es de uso no comercial y prd con clientes que pagan choca con eso
  (`docs/PROMOCION.md:809-810`).
- **D12.** La política de privacidad nombra `gmail.readonly`, que el código no pide
  (`src/app/privacy/page.tsx:75`): ese texto lo cambia el dueño.
- **D13.** Las decisiones de los ítems 7, 10, 14, 15, 16, 17, 18 y 19 del plan.
- **D14. MCP de WhatsApp.** Opcional, sobre la API oficial; no hace falta para el alta y le da
  el token permanente a código de terceros (`docs/whatsapp-setup.md:93-128`).
  **Recomendación: no instalarlo por ahora.** Si el dueño lo quiere, el paso M1. **Elegido el
  17/10:** no instalarlo.
- **D15. Canal de reporte** de Gonzalo y de quienes prueben en prd. En el repo no existe.
  **Recomendación:** un chat o un correo con el dueño, y siempre con el ambiente, la hora, una
  captura y el número de caso. **Elegido el 17/10:** los reportes van por chat o por correo al
  dueño.

## Qué hace Claude

Apenas el dueño avise, Claude puede:

- Listar los nombres de las variables de los tres proyectos con `vercel env ls` y armar la
  lista de diferencias de A12 (`docs/PROJECT_STATUS.md:117-118`).
- Cargar en Vercel las banderas que no son secretas (`ALTA_AUTOMATICA`, `ALTA_NUMERO_AUTOMATICO`,
  topes) en el ambiente que el dueño diga, y pedir un redeploy por proyecto.
- Confirmar las migraciones de los tres (A11) y, con el OK del dueño, aplicar la que falte.
- Correr `pnpm smoke`, `/api/health?deep=1`, `pnpm check` y el ensayo de un escenario, leer
  los transcriptos y pasar a texto el de QA para Gonzalo.
- Leer los logs de cada alta y de cada número (`whatsapp.alta_numero.graph`,
  `alta.numero_en_revision`, `registro.turnstile_no_paso`, `admin_users.invitacion_a_operador`)
  y decir qué falta.
- En prd, listar bases sobrantes y, con el OK explícito del dueño para cada una, reintentar una
  base trabada con `preparar-base.mts` o purgarla (purgar no se deshace).
- En el proyecto de Google Cloud propio de prd, con el OK explícito del dueño para los
  permisos de IAM: habilitar las APIs y crear el tema, la cuenta de servicio y la suscripción
  de Pub/Sub (prd, paso 1).
- Disparar el barrido de QA desde Actions si hace falta antes de su corrida de cada 2 h.
- Hacer la cuenta del costo por caso de C1.
- Implementar los ítems del plan en orden, cada uno en su PR a `qa` y el mismo día a main y prd,
  con la revisión de seguridad en Fable (u Opus) para los ítems 3 y 4.

Claude no carga valores de secretos: el cliente de Gmail y el remitente de QA y de prd los carga
el dueño con `token-remitente.mts` (QA, paso 1; prd, paso 1). Claude no entra a las consolas
de Google, Meta, Cloudflare ni Neon con la sesión del dueño, y no decide nada de la lista de
arriba.

## Referencias

- `docs/whatsapp-setup.md`: Parte B, la app de Meta (`:38`); Parte D, el MCP (`:93`); Parte E,
  reabrir tras 24 h y la plantilla (`:130`); Parte F, el número por código (`:162`), con «Antes
  de prenderlo» (`:178`), «Lo que hace la persona» (`:207`), «El tope de Meta» (`:283`), «Los
  topes» (`:301`), «Qué hace el operador ante cada aviso» (`:326`) y «Prueba real en QA»
  (`:359`); Parte G, la WABA propia (`:389`); Parte H, la app propia (`:608`).
- `docs/PROMOCION.md`: «Las diecisiete variables de claimmix-qa» (`:234`), «Los ambientes»
  (`:556`), «El camino a prd» (`:577`), «Las dos fases» (`:632`), «BASE_POR_CLIENTE es de ida»
  (`:779`), «Migrar después de un cambio de esquema» (`:786`) y «Lo que queda abierto» (`:801`).
- `docs/TESTING.md`: `pnpm rehearse` (`:56`), `pnpm smoke` (`:256`), `pnpm knock` (`:489`),
  `pnpm bases:probar` (`:815`), «Cuándo correr qué» (`:857`), «Lo que corre solo» (`:882`) y
  `/api/health` (`:1068`).
- `docs/PROJECT_STATUS.md`: estado del alta y de prd (`:4760-4768`), la promoción del 16/10 y lo
  que todavía no es igual (`:5051-5053`), «El agente aprende de la consola» (`:5055`), las
  decisiones de A1 (`:5190-5196`), lo que espera al dueño (`:5209`) y el número por código
  (`:5256-5261`).
