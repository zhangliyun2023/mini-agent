/**
 * Contract oracle — ties every contracts/<feature>.machine.mjs to its generated files, its coverage anchors and
 * the answer key. Project-specific checks (persisted status literals ⊆ table, UI text keys ⊆ table, telemetry
 * event names, rejected-transition probes against the real service) belong in this file too: add them as your
 * tables grow — see the `machine-contract` skill for the six checks a mature repo runs.
 */
import {test} from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync,readdirSync,existsSync} from 'node:fs';
import path from 'node:path';
const ROOT=path.resolve(import.meta.dirname,'../..');
const read=f=>readFileSync(path.join(ROOT,f),'utf8');
const load=f=>JSON.parse(read(f));
const MACHINES=readdirSync(path.join(ROOT,'contracts')).filter(f=>f.endsWith('.machine.mjs'));
const anchored=(owner,ev)=>{const [f,txt]=ev.split('::');assert.ok(existsSync(path.join(ROOT,f)),`${owner} 引用的文件不存在 ${f}`);if(txt)assert.ok(read(f).includes(txt),`${owner} 引用 ${f} 不含 "${txt}"`);};

test('至少有一张状态表',()=>{assert.ok(MACHINES.length>0,'contracts/ 里没有 *.machine.mjs');});

for(const file of MACHINES){
  const feature=file.replace('.machine.mjs','');
  test(`contracts/${file}：盘上 contract/scenarios JSON 与表一致（否则 npm run contracts:sync）；无不可达状态`,async()=>{
    const {machine}=await import('../../contracts/'+file);
    assert.equal(read(`contracts/${feature}.contract.json`),JSON.stringify(machine.toContract(),null,2)+'\n','契约 JSON 与表不一致');
    const {scenariosFor}=await import('../../scripts/machine-scenarios.mjs');
    assert.equal(read(`contracts/${feature}.scenarios.json`),JSON.stringify(scenariosFor(machine),null,2)+'\n','场景清单与表不一致');
    assert.equal(machine.reachable().unreachable.size,0,`有声明了但不可达的状态：${[...machine.reachable().unreachable]}`);
  });
  test(`contracts/${file}：P0 转移都有 covered_by 且文本在盘上；enforced 不变量有 evidence 在盘上；planned 有 note`,async()=>{
    const {machine}=await import('../../contracts/'+file);
    for(const t of machine.transitions)if(t.p0){assert.ok(t.covered_by?.length,`P0 转移 ${t.id} 没有 covered_by`);for(const ev of t.covered_by)anchored(t.id,ev);}
    for(const [id,inv] of Object.entries(machine.invariants)){if(inv.enforcement==='enforced'){assert.ok(inv.evidence?.length,id+' enforced 必须有 evidence');for(const ev of inv.evidence)anchored(id,ev);}else assert.ok(inv.note,id+' planned 必须写 note');}
  });
}

test('答案卷 contracts/journeys.json：每条旅程的转移 id 存在于对应机器，且首尾相接（前一条 to == 后一条 from）',async()=>{
  const {journeys}=load('contracts/journeys.json');
  for(const [name,j] of Object.entries(journeys)){
    const {machine}=await import(`../../contracts/${j.feature}.machine.mjs`);const byId=new Map(machine.transitions.map(t=>[t.id,t]));
    for(const seq of [j.expect,...(j.alternatives||[])]){let prev=null;for(const id of seq){const t=byId.get(id);assert.ok(t,`${name}: ${j.feature} 没有转移 ${id}`);if(prev)assert.equal(t.from,prev.kind==='allowed'?prev.to:prev.from,`${name}: ${prev.id} → ${id} 不相接`);prev=t;}}
  }
});

// anchor for the example table's covered_by: "example"
