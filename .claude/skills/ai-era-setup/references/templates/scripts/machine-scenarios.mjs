/**
 * Scenario generator (SPEC-state-machines §5, D6): BFS every contracts/<feature>.machine.mjs from its initial state
 * and write contracts/<feature>.scenarios.json — one entry per reachable transition row, in BFS order, carrying the
 * fixture / drive / invariants the generic runner needs. No LLM: the table is the only input.
 * `--check` exits 1 when a file on disk differs (contracts.test.mjs enforces the same).
 */
import {readdirSync,readFileSync,writeFileSync} from 'node:fs';
import path from 'node:path';
export function scenariosFor(machine){
  const r=machine.reachable();const rows=machine.transitions.filter(t=>r.rows.has(t.id));
  return {feature:machine.feature,generated_by:'scripts/machine-scenarios.mjs',initial:machine.initial,
    reachable_states:[...r.states],unreachable_states:[...r.unreachable],
    scenarios:rows.map(t=>({id:t.id,from:t.from,event:t.event,to:t.kind==='allowed'?t.to:t.from,kind:t.kind,p0:!!t.p0,guard:t.guard??null,reject_code:t.reject_code??null,
      fixture:t.fixture??null,drive:t.drive??null,effects:t.effects||{},invariants:t.invariants||[],allow:t.allow??null,forbid:t.forbid??null,
      runnable:!!(t.drive||t.fixture)}))};
}
const dir=path.resolve(import.meta.dirname,'../contracts');const check=process.argv.includes('--check');let drift=0;
if(process.argv[1]?.endsWith('machine-scenarios.mjs'))for(const f of readdirSync(dir).filter(f=>f.endsWith('.machine.mjs'))){
  const {machine}=await import(path.join(dir,f));const out=path.join(dir,f.replace('.machine.mjs','.scenarios.json'));
  const text=JSON.stringify(scenariosFor(machine),null,2)+'\n';let current=null;try{current=readFileSync(out,'utf8');}catch{/* first */}
  if(current===text){console.log(`unchanged  ${path.basename(out)}`);continue;}
  drift++;if(check){console.error(`DRIFT      ${path.basename(out)}`);continue;}
  writeFileSync(out,text);console.log(`written    ${path.basename(out)}  (${JSON.parse(text).scenarios.length} scenarios)`);
}
if(check&&drift)process.exit(1);
