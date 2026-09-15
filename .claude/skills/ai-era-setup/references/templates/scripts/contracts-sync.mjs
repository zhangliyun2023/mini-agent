/**
 * Project every contracts/<feature>.machine.mjs onto contracts/<feature>.contract.json.
 * `--check` exits 1 when a JSON on disk differs from its table (what contracts.test.mjs also enforces).
 */
import {readdirSync,readFileSync,writeFileSync} from 'node:fs';
import path from 'node:path';
const dir=path.resolve(import.meta.dirname,'../contracts');const check=process.argv.includes('--check');let drift=0;
for(const f of readdirSync(dir).filter(f=>f.endsWith('.machine.mjs'))){
  const {machine}=await import(path.join(dir,f));const out=path.join(dir,f.replace('.machine.mjs','.contract.json'));
  const text=JSON.stringify(machine.toContract(),null,2)+'\n';
  let current=null;try{current=readFileSync(out,'utf8');}catch{/* first generation */}
  if(current===text){console.log(`unchanged  ${path.basename(out)}`);continue;}
  drift++;if(check){console.error(`DRIFT      ${path.basename(out)} 与 ${f} 不一致`);continue;}
  writeFileSync(out,text);console.log(`written    ${path.basename(out)}  (${machine.transitions.length} transitions, ${Object.keys(machine.states).length} states)`);
}
if(check&&drift)process.exit(1);
