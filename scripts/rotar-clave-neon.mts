/**
 * Rota la clave de API de Neon.
 *
 * Quedó en el transcripto de una sesión de trabajo. Con ella se crean y se
 * borran ramas del proyecto, se leen las cadenas de conexión de cada una, y se
 * llega a todo lo que hay adentro. Es la credencial de mayor alcance del
 * proyecto: una contraseña de base entra a UNA base; ésta entra a todas y puede
 * fabricar más.
 *
 * **La vieja se revoca al final, no al principio.** Si se revocara primero y la
 * creación de la nueva fallara, no quedaría con qué hacer ninguna de las dos
 * cosas: ni crear ni revocar. Se crea, se prueba, se guarda, y recién entonces
 * se revoca.
 *
 * La clave no se imprime nunca. Va de la respuesta de Neon al archivo.
 */
import * as dotenv from "dotenv";
dotenv.config({ path: ".env.local" });

import { readFileSync, writeFileSync } from "node:fs";

const API = "https://console.neon.tech/api/v2";
const vieja = process.env.NEON_API_KEY?.trim().replace(/^"|"$/g, "");

if (!vieja) {
  console.error("Falta NEON_API_KEY en .env.local");
  process.exit(2);
}

async function neon<T>(ruta: string, clave: string, init?: RequestInit): Promise<T> {
  const r = await fetch(`${API}${ruta}`, {
    ...init,
    headers: {
      Authorization: `Bearer ${clave}`,
      "Content-Type": "application/json",
      ...(init?.headers ?? {}),
    },
  });
  if (!r.ok) throw new Error(`${init?.method ?? "GET"} ${ruta} → ${r.status} ${await r.text()}`);
  return (await r.json()) as T;
}

console.log("═".repeat(66));
console.log("ROTAR — la clave de API de Neon");
console.log("═".repeat(66));

// ── 1. Qué hay ────────────────────────────────────────────────────────────────
const antes = await neon<Array<{ id: number; name: string }>>("/api_keys", vieja);
console.log(`\n▸ Claves en la cuenta: ${antes.length}`);
for (const k of antes) console.log(`   · ${k.name} (id ${k.id})`);

// ── 2. La nueva ───────────────────────────────────────────────────────────────
const nombre = `ClaimMix-${new Date().toISOString().slice(0, 10)}`;
console.log(`\n▸ Creando "${nombre}"`);
const creada = await neon<{ id: number; key: string }>("/api_keys", vieja, {
  method: "POST",
  body: JSON.stringify({ key_name: nombre }),
});
console.log(`   ✓ id ${creada.id}`);

// ── 3. Que sirva, antes de tirar la otra ──────────────────────────────────────
console.log(`\n▸ Probando la clave nueva`);
try {
  const orgs = await neon<{ organizations?: Array<{ id: string }> }>(
    "/users/me/organizations",
    creada.key
  );
  console.log(`   ✓ responde (${orgs.organizations?.length ?? 0} organización/es)`);
} catch (e) {
  console.error(`   ✗ la clave nueva no funciona: ${(e as Error).message.slice(0, 120)}`);
  console.error("     La vieja NO se revocó y sigue en .env.local.");
  process.exit(1);
}

// ── 4. Guardarla ──────────────────────────────────────────────────────────────
const archivo = ".env.local";
const contenido = readFileSync(archivo, "utf8");
const patron = /^NEON_API_KEY=.*$/m;
if (!patron.test(contenido)) {
  console.error("No encontré NEON_API_KEY en .env.local — la vieja NO se revocó.");
  process.exit(1);
}
writeFileSync(archivo, contenido.replace(patron, `NEON_API_KEY=${creada.key}`), "utf8");
console.log(`\n▸ Guardada en ${archivo}`);
console.log("   ✓ (no se imprime)");

// ── 5. Y ahora sí, la vieja ───────────────────────────────────────────────────
const porRevocar = antes.filter((k) => k.id !== creada.id);
console.log(`\n▸ Revocando ${porRevocar.length} clave(s) anterior(es)`);
for (const k of porRevocar) {
  await neon(`/api_keys/${k.id}`, creada.key, { method: "DELETE" });
  console.log(`   ✓ ${k.name} (id ${k.id}) revocada`);
}

const quedan = await neon<Array<{ id: number; name: string }>>("/api_keys", creada.key);
console.log(`\n${"─".repeat(66)}`);
console.log(`✓ Queda ${quedan.length} clave: ${quedan.map((k) => k.name).join(", ")}`);
console.log("  La que estaba en el transcripto ya no abre nada.");
