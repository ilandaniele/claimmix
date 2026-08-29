# Por qué esta guía está versionada en el repo

`SKILL.md` es [VibeSec-Skill](https://github.com/BehiSecc/VibeSec-Skill), una guía
de código seguro para aplicaciones web. Se copió acá tal cual, con su LICENSE.

Va versionada —y por eso `.gitignore` rescata `.claude/skills/` de la exclusión de
`.claude/`— porque vale para cualquiera que trabaje en este repo, no sólo para la
máquina donde se bajó. El resto de `.claude/` sigue ignorado: son preferencias y
estado local.

## Cómo se usó

Se pasó entera sobre el código, sección por sección, con un pase adversarial que
refutó cada hallazgo antes de darlo por bueno. Lo que sobrevivió está en
`docs/PROJECT_STATUS.md`.

## Lo que la guía asume y este repo hace distinto

Vale tenerlo a mano, porque es la fuente número uno de falsos positivos al leerla
contra este código:

- **La guía dice «verificá la propiedad en la capa de datos, no en la ruta».** Acá
  eso lo hace la BASE: Postgres con RLS, y todo pasa por `enTenant`/`enTenantVarias`
  (`src/data/scope.ts`), que manda el `set_config` del inquilino en el mismo
  `batch()` que la consulta. Una consulta sin `WHERE tenant_id` explícito NO es un
  bug: es la forma correcta. Lo que sí lo es, es una que use el cliente sin RLS.
  `node scripts/check-architecture.mjs` lo comprueba.

- **La guía habla de tokens CSRF.** Better Auth trae lo suyo; ver el informe.

- **La guía pide devolver 404 y no 403 para no permitir enumerar.** Ya es la regla
  de la casa y está escrita en los handlers que la aplican.
