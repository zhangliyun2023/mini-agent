/**
 * 对答案：compare observed machine transitions with contracts/journeys.json.
 *   node scripts/machine-check.mjs --rows <observed.jsonl> [--journey <name>] [--trace <id>] [--json]
 *   node scripts/machine-check.mjs --db <sqlite>  (an `events` table with name='machine_transition', props JSON, trace_id)
 * Observed row shape (one JSON object per line): {feature, transition, status, trace_id, from, to, event, input?}.
 * A journey passes when SOME trace_id has, in order, exactly the expected transition ids (or an `alternatives` entry).
 * Unknown transitions are always reported: they are never "fine".
 */
import {readFileSync} from 'node:fs';
import path from 'node:path';
const ROOT=path.resolve(import.meta.dirname,'..');
export const journeys=()=>JSON.parse(readFileSync(path.join(ROOT,'contracts/journeys.json'),'utf8')).journeys;
export function rowsFromJsonl(file){return readFileSync(file,'utf8').split('\n').filter(Boolean).map(l=>JSON.parse(l));}
export async function rowsFromSqlite(dbPath){
  const {DatabaseSync}=await import('node:sqlite');const db=new DatabaseSync(dbPath,{readOnly:true});
  const rows=db.prepare("SELECT props,trace_id,created_at,rowid FROM events WHERE name='machine_transition' ORDER BY created_at,rowid").all().map(r=>({...JSON.parse(r.props),trace_id:r.trace_id,created_at:r.created_at}));
  db.close();return rows;
}
export function checkJourney(rows,journey,trace=null){
  const candidates=[journey.expect,...(journey.alternatives||[])];const byTrace=new Map();
  for(const r of rows){if(r.feature!==journey.feature||!r.trace_id)continue;if(trace&&r.trace_id!==trace)continue;if(!byTrace.has(r.trace_id))byTrace.set(r.trace_id,[]);byTrace.get(r.trace_id).push(r.transition||('?'+r.status));}
  let best=null;
  for(const [tid,seq] of byTrace){
    for(const exp of candidates){if(seq.length===exp.length&&seq.every((x,i)=>x===exp[i]))return {status:'passed',trace_id:tid,expected:exp,observed:seq};}
    const score=candidates.reduce((m,exp)=>Math.max(m,exp.filter((x,i)=>seq[i]===x).length),0);if(!best||score>best.score)best={score,trace_id:tid,observed:seq};
  }
  return {status:byTrace.size?'failed':'not_observed',trace_id:best?.trace_id??null,expected:journey.expect,observed:best?.observed??[]};
}
export function checkAll(rows,only=null,trace=null){
  const out={};for(const [name,j] of Object.entries(journeys())){if(only&&name!==only)continue;out[name]=checkJourney(rows,j,trace);}
  return {journeys:out,unknown:rows.filter(r=>r.status==='unknown').map(r=>({feature:r.feature,from:r.from,event:r.event,input:r.input,trace_id:r.trace_id}))};
}
if(process.argv[1]?.endsWith('machine-check.mjs')){
  const arg=k=>{const i=process.argv.indexOf(k);return i>0?process.argv[i+1]:null;};
  const rows=arg('--rows')?rowsFromJsonl(arg('--rows')):arg('--db')?await rowsFromSqlite(arg('--db')):null;
  if(!rows){console.error('用法：node scripts/machine-check.mjs (--rows <jsonl> | --db <sqlite>) [--journey <name>] [--trace <id>] [--json]');process.exit(2);}
  const result=checkAll(rows,arg('--journey'),arg('--trace'));
  if(process.argv.includes('--json'))console.log(JSON.stringify(result,null,2));
  else{for(const [name,r] of Object.entries(result.journeys))console.log(`${r.status==='passed'?'PASS':r.status==='failed'?'FAIL':'----'}  ${name.padEnd(28)} 期望 ${r.expected.join(' → ')}${r.status!=='passed'?`\n      实际 ${r.observed.join(' → ')||'（未观察到该机器的转移）'}${r.trace_id?'  trace '+String(r.trace_id).slice(0,10):''}`:''}`);
    console.log(result.unknown.length?`\nUNKNOWN ${result.unknown.length} 条未建模转移：`+result.unknown.map(u=>`${u.feature}:${u.from}×${u.event}`).join(', '):'\n无未建模转移');}
  process.exitCode=Object.values(result.journeys).some(r=>r.status==='failed')||result.unknown.length?1:0;
}
