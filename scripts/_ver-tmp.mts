const { neon } = await import("@neondatabase/serverless");
const url = process.argv[2];
const sql = neon(url);
const r = await sql`select column_name from information_schema.columns
  where table_name='claim_attachments' and column_name='matched_doc_key'`;
console.log(r.length > 0 ? "  TIENE la columna" : "  NO la tiene");
process.exit(0);
