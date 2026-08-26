/**
 * `pnpm docs-config` — que la tabla de documentos y el código digan lo mismo.
 *
 * Hay dos copias de la misma lista y ninguna sabe de la otra:
 *
 *   · `src/core/case/required-docs.ts` — la que usa `analyzeGaps` para decidir
 *     qué papeles le pide el agente al denunciante.
 *   · `required_docs_config` en la base — la que usa `seedRequiredDocs` para
 *     registrar esos papeles como pendientes en el caso.
 *
 * Durante meses divergieron sin que nada avisara. El código conocía ocho tipos
 * de siniestro y la tabla tenía cuatro, sembrados en la 0001 y nunca ampliados.
 * El síntoma era mudo por cómo está escrito el sembrador: si no encuentra filas
 * para el tipo, se vuelve sin hacer nada. Así que el agente pedía la denuncia
 * policial de un robo de contenido —eso sale del archivo— pero el caso no
 * registraba un solo documento pendiente, y en la pantalla del analista esos
 * siniestros se veían completos. Cuarenta y cinco casos así en producción.
 *
 * Agregar las filas arregla el día de hoy. Esto arregla el mes que viene: el
 * próximo tipo de siniestro que alguien agregue al código sin la migración
 * correspondiente rompe acá, en vez de descubrirse cuando un analista se
 * pregunte por qué un caso no le pide nada.
 *
 * Sólo lee.
 */
import * as dotenv from "dotenv";
dotenv.config({ path: ".env.local" });
import { neon } from "@neondatabase/serverless";

import { REQUIRED_DOCS_CONFIG } from "@/core/case/required-docs";

const sql = neon(process.env.DATABASE_URL!.trim());

type Fila = { claim_type: string; doc_key: string; label_es: string; required: boolean };

const enBase = (await sql`
  select claim_type, doc_key, label_es, required
  from required_docs_config
`) as Fila[];

/** Una clave por documento, para poder comparar los dos lados como conjuntos. */
const clave = (tipo: string, doc: string) => `${tipo}/${doc}`;

const base = new Map(enBase.map((f) => [clave(f.claim_type, f.doc_key), f]));

const codigo = new Map<string, { required: boolean; label: string }>();
for (const [tipo, docs] of Object.entries(REQUIRED_DOCS_CONFIG)) {
  for (const d of docs) {
    codigo.set(clave(tipo, d.doc_key), { required: d.required, label: d.label_es });
  }
}

console.log("═".repeat(72));
console.log("DOCUMENTOS POR TIPO — el código contra la base");
console.log("═".repeat(72));
console.log("");
console.log(`  en el código: ${codigo.size} documentos`);
console.log(`  en la base:   ${base.size} documentos`);
console.log("");

const problemas: string[] = [];

/*
 * Faltan en la base: el caso grave, y el que ya pasó.
 *
 * El agente los pide y el caso no los registra. No hay error en ningún lado:
 * simplemente el seguimiento no existe para ese tipo.
 */
for (const [k, c] of codigo) {
  if (!base.has(k)) {
    problemas.push(`falta en la base: ${k} (${c.label})`);
  }
}

/*
 * Sobran en la base: menos grave, pero tampoco es inocuo.
 *
 * Un documento que la base registra como pendiente y el archivo no conoce
 * queda esperando para siempre: `analyzeGaps` nunca lo va a pedir, así que
 * nadie lo va a mandar, así que el caso no se cierra solo.
 */
for (const [k, f] of base) {
  if (!codigo.has(k)) {
    problemas.push(`sobra en la base: ${k} (${f.label_es}) — el agente nunca lo pide`);
  }
}

/*
 * `required` distinto: el desacuerdo silencioso.
 *
 * Si el archivo lo marca opcional y la base obligatorio, el agente no lo pide
 * pero el caso lo cuenta como faltante. Al revés, el agente lo pide y el caso
 * no lo espera.
 */
for (const [k, c] of codigo) {
  const f = base.get(k);
  if (f && f.required !== c.required) {
    problemas.push(
      `desacuerdo en ${k}: el código dice required=${c.required} y la base required=${f.required}`
    );
  }
}

/*
 * Un tipo entero sin ninguna fila es el caso que originó todo esto, y merece
 * decirse aparte: es la diferencia entre "falta un papel" y "este tipo de
 * siniestro no tiene seguimiento de documentación en absoluto".
 */
const tiposSinFilas = Object.entries(REQUIRED_DOCS_CONFIG)
  .filter(([tipo, docs]) => docs.length > 0 && !enBase.some((f) => f.claim_type === tipo))
  .map(([tipo]) => tipo);

if (tiposSinFilas.length > 0) {
  console.log("  ▸ Tipos sin una sola fila en la base:");
  for (const t of tiposSinFilas) console.log(`      ${t}`);
  console.log("");
}

console.log("─".repeat(72));
if (problemas.length === 0) {
  console.log("✓ Las dos listas coinciden.");
  process.exit(0);
}

console.log(`✗ ${problemas.length} diferencia(s):`);
for (const p of problemas) console.log(`   · ${p}`);
console.log("");
console.log("  Las dos listas tienen que decir lo mismo. Si agregaste un tipo de");
console.log("  siniestro al código, escribí la migración que carga sus filas.");
process.exit(1);
