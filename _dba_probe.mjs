import { neon } from "@neondatabase/serverless";
const owner=neon(process.env.DATABASE_URL); const app=neon(process.env.DATABASE_URL_APP);
const TID=(await owner.query("select id,(select count(*) from cases c where c.tenant_id=t.id) n from tenants t order by n desc"))[0].id;
async function ex(l,t,p=[],d=[]){try{const s=[app.query("select set_config('claimmix.tenant_id',$1,true)",[TID])];for(const x of d)s.push(app.query(`select set_config('${x}','off',true)`));s.push(app.query("EXPLAIN (ANALYZE,BUFFERS,COSTS) "+t,p));const r=await app.transaction(s);console.log("\n=== "+l+(d.length?` [${d}=off]`:"")+" ===");for(const x of r[r.length-1])console.log(x["QUERY PLAN"]);}catch(e){console.log("\n=== "+l+" ERROR: "+e.message+" ===");}}
// worker: a quien despachar (el SELECT equivalente al UPDATE ... WHERE)
await ex("W1 worker toma trabajo","select id from cases where extraction_pending = true and (extraction_lease_at is null or extraction_lease_at < now()-interval '10 minutes') limit 1",[],["enable_seqscan"]);
// bandeja ordenada por confidence_min: la consulta REAL con subconsultas
await ex("S3 bandeja sort=confidence_min (real)",`
select c.id, coalesce(c.policy_number,(select ef.field_value from extracted_fields ef where ef.case_id=c.id and ef.tenant_id=c.tenant_id and ef.field_key='policy_number')) pn,
 (select max(om.created_at) from outbound_messages om where om.case_id=c.id and om.tenant_id=c.tenant_id and om.status='sent') r
from cases c order by c.confidence_min desc limit 25 offset 0`,[],["enable_seqscan"]);
// bandeja filtrada por un estado raro
await ex("S4 bandeja status raro + created_at","select c.id from cases c where c.status='error_core' order by c.created_at desc limit 25",[],["enable_seqscan"]);
// paginacion profunda sin tope
await ex("D3 offset 100000","select c.id from cases c order by c.created_at desc limit 100 offset 100000",[],["enable_seqscan"]);
// claim_messages: reintentos / dispatch
await ex("CM1 direction+status","select id from claim_messages where direction='outbound' and status='queued' limit 50",[],["enable_seqscan"]);
// audit por tipo de evento a nivel tenant
await ex("AU1 audit por event_type","select id from audit_log where event_type='auth.success' order by created_at desc limit 50",[],["enable_seqscan"]);
