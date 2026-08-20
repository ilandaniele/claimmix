<!-- BEGIN:nextjs-agent-rules -->
# This is NOT the Next.js you know

This version has breaking changes — APIs, conventions, and file structure may all differ from your training data. Read the relevant guide in `node_modules/next/dist/docs/` before writing any code. Heed deprecation notices.
<!-- END:nextjs-agent-rules -->

# Probar cambios

`pnpm check` — tipos, lint, tests, once conversaciones enteras contra el agente
real por WhatsApp y por mail, y el estado del deploy. No manda mensajes a nadie.
`pnpm check --local` mientras trabajás; `pnpm check` completo después de cada
deploy. Ver `docs/TESTING.md`.

Si tocaste el comportamiento del agente, leé el transcripto que imprime el
ensayo. Media respuesta puede pasar todas las verificaciones y sonar mal, y eso
sólo lo ve una persona.
