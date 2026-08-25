# Los patrones — cómo se llama cada cosa y de dónde sale

> La versión sin jerga está en [ARQUITECTURA-EN-CASTELLANO.md](./ARQUITECTURA-EN-CASTELLANO.md).
> Esta es la misma arquitectura con los nombres técnicos, para poder discutirla
> con cualquier programador y para buscar material sobre cada pieza.

---

## Cómo se llama, en una frase

**Un núcleo funcional con puertos y adaptadores, organizado en rebanadas
verticales, sobre una capa de acceso a datos con tenencia obligatoria, y una
cañería de ejecución durable.**

Es una **composición**, no una arquitectura de marca. Eso es deliberado: cada
patrón resuelve un problema medido de este sistema, y ninguno de los cuatro
alcanza solo. Desconfiá de quien te ofrezca una sola palabra para todo esto —
«Clean Architecture» o «DDD» dichos así, sin decir qué parte y para qué, suelen
significar «capas porque sí».

---

## El mapa: empleado → patrón

| Empleado | Patrón | De dónde sale | Carpeta |
|---|---|---|---|
| ⚖️ El que decide | **Functional Core, Imperative Shell** | Gary Bernhardt, *Boundaries* (2012) | `src/core/` |
| 📥📤 Recepción y cadete | **Ports & Adapters (Hexagonal)** | Alistair Cockburn (2005) | `src/adapters/` |
| 🔤 El traductor | **Anti-Corruption Layer** | Eric Evans, *DDD* (2003) | `src/adapters/ai/` |
| 🗄️ El archivo | **Data Access Layer + DTOs** | recomendación explícita de Next.js 16 | `src/data/` |
| 🗄️ El archivero que mira | **Row-Level Security · defensa en profundidad** | Postgres + OWASP | base de datos |
| 🗒️ El capataz | **Durable Execution / orquestación de flujos** | linaje Temporal · Inngest | `src/workflows/` |
| 🧑‍💼 El mostrador | **Vertical Slice Architecture** | Jimmy Bogard | `src/features/` |

---

## Cada patrón: qué es, por qué acá, y con qué se lo arruina

### 1. Functional Core, Imperative Shell → `src/core/`

**Qué es.** Partir el programa en dos: un *núcleo* de funciones puras —misma
entrada, misma salida, sin efectos— y una *cáscara* imperativa que hace la
entrada/salida y llama al núcleo. Toda la lógica difícil vive en el núcleo;
toda la impureza, en la cáscara, que es tonta.

**Por qué acá.** Porque las decisiones del producto —qué falta, si urge, si
volver a preguntar— son la parte que más cambia y la más cara de probar hoy.
Hecha pura, se prueba con dos objetos y sin red. Es lo que baja los 349 mocks.

**Con qué se lo arruina.** Dejando entrar el reloj o el azar «porque es sólo
una línea». Una función que llama a `Date.now()` deja de ser pura: la fecha se
pasa como parámetro. Suena pedante hasta la primera vez que un test falla sólo
a la medianoche.

### 2. Ports & Adapters (Hexagonal) → `src/adapters/`

**Qué es.** El dominio define *puertos* (interfaces: «necesito algo que sepa
mandar un mensaje») y afuera se escriben *adaptadores* que los cumplen (Gmail,
WhatsApp). La dependencia apunta hacia adentro: el dominio no sabe quién lo
implementa.

**Por qué acá.** Porque el 100 % de los incidentes de esta semana fueron el
borde: el permiso que vence, el push que muere, el 500 de Google. Aislar el
borde no evita que falle —nada lo evita— pero hace que falle **en un solo lugar
identificable**, y que se pueda probar sin el proveedor.

**Con qué se lo arruina.** Poniendo un puerto para cada cosa. Es la crítica
mejor fundada a *Clean Code* y aplica igual acá: la indirección sin claridad es
costo puro. **Cinco puertos**, que son los cinco bordes reales: base,
mensajería, modelo, reloj, presupuesto. El resto son funciones.

### 3. Anti-Corruption Layer → `src/adapters/ai/`

**Qué es.** Una capa de traducción en la frontera con un sistema ajeno, para
que su vocabulario no se filtre al tuyo.

**Por qué acá.** Lo que devuelve Gemini es un JSON con la forma que a Google se
le ocurra hoy. Si esa forma circula cruda por el sistema, el día que cambie el
modelo cambia medio código. Adentro debe entrar una ficha nuestra, validada, o
un error.

**Con qué se lo arruina.** Haciendo que el «traductor» sea sólo un cast de
tipos. Traducir es validar: si el modelo devuelve algo que no entendemos, esto
tiene que romper fuerte y visible — no devolver `is_claim: false`, que fue el
peor bug de este proyecto.

### 4. Data Access Layer con DTOs → `src/data/`

**Qué es.** Una única biblioteca interna por la que pasa todo acceso a datos.
Corre sólo en el servidor, hace los controles de autorización, y devuelve
**DTOs** —objetos mínimos y seguros— en vez de filas crudas.

**Por qué acá.** No es una preferencia mía: es lo que la guía de seguridad que
instala Next.js recomienda para proyectos nuevos, y ahí mismo advierte que hay
que **elegir un enfoque y no mezclarlos**. Hoy conviven los tres (componente con
SQL, ruta con SQL, y capa de servicio), que es la peor de las opciones porque
nadie —ni un auditor— puede decir dónde se controla el acceso.

**Con qué se lo arruina.** Convirtiéndolo en un *repositorio anémico*: una
función por tabla que devuelve la fila entera y delega la autorización al que
llama. Si la capa de datos no decide quién ve qué, no es una capa de datos: es
un `SELECT` con más pasos.

### 5. Row-Level Security · defensa en profundidad → la base

**Qué es.** Que Postgres filtre por inquilino, con `FORCE ROW LEVEL SECURITY` y
un rol de aplicación que **no** sea dueño de las tablas.

**Por qué acá.** Porque hoy hay 28 políticas escritas que no corren nunca —el
rol saltea RLS por ser dueño— y la única defensa real son 198 filtros a mano.
Con esto pasan a ser **dos mecanismos independientes**: uno falla al compilar,
el otro en la base. Defensa en profundidad quiere decir exactamente eso: que
para que haya fuga tengan que fallar los dos, no uno.

**Con qué se lo arruina.** Activando RLS y quedándose tranquilo sin verificar
que se aplica — que es literalmente el estado actual. Por eso la Fase 0-A mide
contra la base y no contra las migraciones.

### 6. Ejecución durable → `src/workflows/`

**Qué es.** El flujo se escribe como código normal, pero cada paso se persiste.
Si el proceso muere, se reanuda en el paso donde iba, no desde el principio.
Trae reintentos, esperas largas e idempotencia como parte del modelo.

**Por qué acá.** Porque ya existe una versión casera de esto —`MAX_CHAIN`,
auto-invocación por HTTP, leases a mano, 77 reintentos con criterio propio— que
existe sólo para esquivar el límite de 60 segundos, y que pierde casos. Hay un
cron llamado `reap-stuck` cuyo trabajo es juntar lo perdido.

**Con qué se lo arruina.** Metiendo lógica de negocio adentro de los pasos. El
flujo debe leerse como un índice: *extraer, analizar, preguntar, esperar,
cerrar*. Lo que cada paso hace vive en `core/` y en `adapters/`.

### 7. Vertical Slice Architecture → `src/features/`

**Qué es.** Organizar por funcionalidad y no por capa: cada rebanada tiene su
ruta, su pantalla, su lógica de coordinación y sus tests, juntos.

**Por qué acá.** Porque el trabajo real es «tocar la carga por WhatsApp» o
«tocar facturación», y hoy eso obliga a abrir cuatro carpetas por capa. También
porque es lo que mejor calza con el App Router, que ya empuja a poner cada cosa
al lado de su ruta.

**Con qué se lo arruina.** Duplicando la lógica de negocio en cada rebanada.
Por eso las rebanadas **no** tienen dominio propio: coordinan `core` y `data`.
Si dos rebanadas empiezan a copiar la misma regla, esa regla es del núcleo.

---

## Los cuatro principios que lo sostienen

**Inversión de dependencias.** Las flechas apuntan hacia adentro: `features` →
`core`, `adapters` → `core`, y nunca al revés. El núcleo no importa a nadie.
Es la regla de la que salen casi todas las demás.

**Pureza en el núcleo.** Misma entrada, misma salida, sin efectos. Es lo que
permite probar sin mocks, y lo que hace que un test que pasa signifique algo.

**Defensa en profundidad para la tenencia.** Dos cierres independientes: tipos
y base. Uno solo es un pedido de disculpas esperando a ocurrir.

**Idempotencia en los pasos.** Un paso que se reintenta no puede mandar el
mensaje dos veces. Es la condición para que los reintentos automáticos sean un
alivio y no un problema nuevo.

---

## Lo que esto NO es

- **No es Clean Architecture con cuatro anillos concéntricos.** Tomo la
  inversión de dependencias, no la ceremonia de capas.
- **No es DDD con agregados, repositorios y eventos de dominio.** Tomo la capa
  anticorrupción y el lenguaje compartido. El resto es peso muerto para un
  sistema de este tamaño con un solo desarrollador.
- **No es CQRS ni event sourcing.** Nada de lo medido los justifica, y ambos
  multiplican los modos de falla silenciosa, que ya son *el* problema.
- **No son microservicios.** Un despliegue, un repositorio.

---

## Cómo se comprueba que la arquitectura sigue viva

Una arquitectura escrita en un documento se degrada en seis meses. Una
comprobada en cada `pnpm check` no. Se agregan **funciones de aptitud
arquitectónica**: pruebas que fallan si la estructura se viola.

```js
// eslint.config.js — el núcleo no puede tocar infraestructura
{
  files: ["src/core/**/*.ts"],
  rules: {
    "no-restricted-imports": ["error", {
      patterns: [{
        group: ["@/lib/db", "@/data/*", "@/adapters/*", "googleapis", "next/*"],
        message: "core recibe datos y devuelve decisiones: no habla con nadie",
      }],
    }],
  },
}
```

```bash
# scripts/check-architecture.sh — el SQL vive en un solo lugar
fuera=$(grep -rl "drizzle-orm" src --include="*.ts" | grep -v "^src/data/")
if [ -n "$fuera" ]; then
  echo "✗ SQL fuera de src/data/:"; echo "$fuera"; exit 1
fi
```

Va al lado de `check-personal-data.sh`, que ya hace lo mismo con otra invariante
y por el mismo motivo: **una regla que no se verifica sola no es una regla, es
una intención.**
