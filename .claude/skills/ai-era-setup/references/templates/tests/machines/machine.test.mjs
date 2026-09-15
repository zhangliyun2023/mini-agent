/**
 * S0 (SPEC-state-machines §3): the generic table-driven machine.
 * A machine is data; this interpreter is the only code. Unlisted (state, event) pairs are `unknown`,
 * guards are named predicates over facts the machine owns, the first matching row wins, and the
 * on-disk contract JSON is a projection of the table (toContract).
 */
import {test} from 'node:test';
import assert from 'node:assert/strict';
import {defineMachine} from '../../contracts/machine.mjs';

const table=()=>({
  feature:'demo',status:'active',anchor:'docs/x.md#demo',
  states:{ready:{terminal:false,ui:'可提交'},submitting:{terminal:false,ui:'请求中'},failed:{terminal:false,ui:'失败'},done:{terminal:true,ui:'完成'},orphan:{terminal:true,ui:'孤儿'}},
  events:['CLICK','RESULT','RESIZE'],
  guards:{inputValid:f=>!!f.inputValid,ok:f=>f.outcome==='ok'},
  transitions:[
    {id:'click-invalid',from:'ready',event:'CLICK',guard:'!inputValid',to:'ready',kind:'rejected',reject_code:'INPUT_REQUIRED',effects:{api:false},invariants:['no-request-before-valid'],p0:true,covered_by:['tests/machines/machine.test.mjs::click-invalid']},
    {id:'click-valid',from:'ready',event:'CLICK',guard:'inputValid',to:'submitting',kind:'allowed',effects:{api:true},invariants:[],p0:true,covered_by:['tests/machines/machine.test.mjs::click-valid']},
    {id:'double-click',from:'submitting',event:'CLICK',to:'submitting',kind:'noop',reject_code:'DUPLICATE_SUBMIT',effects:{api:false},invariants:['no-double-submit'],p0:false},
    {id:'result-ok',from:'submitting',event:'RESULT',guard:'ok',to:'done',kind:'allowed',effects:{api:false},invariants:[],p0:false},
    {id:'result-bad',from:'submitting',event:'RESULT',to:'failed',kind:'allowed',effects:{api:false},invariants:[],p0:false},
    {id:'retry',from:'failed',event:'CLICK',guard:'inputValid',to:'submitting',kind:'allowed',effects:{api:true},invariants:[],p0:false},
  ],
  invariants:{
    'no-request-before-valid':{text:'输入不合法不发请求',enforcement:'enforced',evidence:['tests/machines/machine.test.mjs::no-request-before-valid']},
    'no-double-submit':{text:'loading 中不重复提交',enforcement:'planned',note:'待接闸'},
  },
});

test('定义期校验：未知状态 / 未知事件 / 未知 guard / 未知不变量 / 重复 id 都在 defineMachine 时抛错，而不是运行时',()=>{
  const bad=(mutate,re)=>{const t=table();mutate(t);assert.throws(()=>defineMachine(t),re);};
  bad(t=>{t.transitions[0].from='nope';},/状态/);
  bad(t=>{t.transitions[0].event='NOPE';},/事件/);
  bad(t=>{t.transitions[0].guard='!missing';},/guard/);
  bad(t=>{t.transitions[0].invariants=['missing'];},/不变量/);
  bad(t=>{t.transitions.push({...t.transitions[0]});},/重复/);
});

test('interpret：guard 按表顺序取第一条命中；取反 guard；rejected → blocked 且状态停留；noop 停留；未列组合 → unknown（reason UNMODELED，状态停留）',()=>{
  const m=defineMachine(table());
  const a=m.interpret('ready','CLICK',{inputValid:false});assert.equal(a.status,'blocked');assert.equal(a.id,'click-invalid');assert.equal(a.to,'ready');assert.equal(a.reason,'INPUT_REQUIRED');assert.equal(a.effects.api,false);assert.deepEqual(a.invariants,['no-request-before-valid']);
  const b=m.interpret('ready','CLICK',{inputValid:true});assert.equal(b.status,'allowed');assert.equal(b.id,'click-valid');assert.equal(b.to,'submitting');assert.equal(b.effects.api,true);
  const c=m.interpret('submitting','CLICK',{inputValid:true});assert.equal(c.status,'noop');assert.equal(c.to,'submitting');assert.equal(c.reason,'DUPLICATE_SUBMIT');
  const d=m.interpret('submitting','RESULT',{outcome:'ok'});assert.equal(d.to,'done');
  const e=m.interpret('submitting','RESULT',{outcome:'meh'});assert.equal(e.to,'failed','无 guard 的行是兜底');
  const u=m.interpret('done','CLICK',{inputValid:true});assert.equal(u.status,'unknown');assert.equal(u.reason,'UNMODELED');assert.equal(u.to,'done');assert.equal(u.id,null);
  assert.throws(()=>m.interpret('nope','CLICK',{}),/状态/);assert.throws(()=>m.interpret('ready','NOPE',{}),/事件/);
});

test('enumerate：状态 × 事件全表，每格列出所有候选行；无行的格标 unknown',()=>{
  const m=defineMachine(table());const grid=m.enumerate();
  assert.equal(grid.length,5*3);
  const cell=(s,e)=>grid.find(x=>x.from===s&&x.event===e);
  assert.deepEqual(cell('ready','CLICK').rows.map(r=>r.id),['click-invalid','click-valid']);
  assert.equal(cell('done','CLICK').status,'unknown');assert.deepEqual(cell('done','CLICK').rows,[]);
  assert.equal(grid.filter(x=>x.status==='unknown').length,15-4,'6 行覆盖 4 个格（ready/CLICK 与 submitting/RESULT 各两行），其余 11 格全 unknown');
});

test('reachable：从初始状态沿 allowed 边 BFS；返回可达状态、经过的行 id、以及声明了但不可达的状态',()=>{
  const m=defineMachine(table());const r=m.reachable('ready');
  assert.deepEqual([...r.states].sort(),['done','failed','ready','submitting']);
  assert.deepEqual([...r.unreachable],['orphan']);
  assert.deepEqual([...r.rows].sort(),['click-invalid','click-valid','double-click','result-bad','result-ok','retry']);
});

test('toContract：投影成 contracts/*.contract.json 的形状，states 带 kind/terminal/ui，transitions 带 id/kind/event/from/to/p0/covered_by，invariants 数组带 enforcement',()=>{
  const c=defineMachine(table()).toContract();
  assert.equal(c.feature,'demo');assert.equal(c.status,'active');assert.equal(c.anchor,'docs/x.md#demo');assert.equal(c.generated_by,'contracts/machine.mjs');
  assert.deepEqual(c.states.ready,{kind:'modeled',terminal:false,ui:true,meaning:'可提交'});
  const t=c.transitions.find(t=>t.id==='click-invalid');assert.equal(t.kind,'rejected');assert.equal(t.from,'ready');assert.equal(t.to,null);assert.equal(t.reject_code,'INPUT_REQUIRED');assert.equal(t.p0,true);assert.deepEqual(t.covered_by,['tests/machines/machine.test.mjs::click-invalid']);
  const al=c.transitions.find(t=>t.id==='click-valid');assert.equal(al.to,'submitting');assert.equal(al.guard,'inputValid');
  assert.deepEqual(c.invariants.map(i=>i.id),['no-request-before-valid','no-double-submit']);assert.equal(c.invariants[1].enforcement,'planned');
  assert.equal(JSON.stringify(c),JSON.stringify(defineMachine(table()).toContract()),'投影必须是确定性的（同表同输出）');
});


test('对答案 checkJourney（scripts/machine-check.mjs）：精确序列 passed；alternatives；错序 failed 带最接近序列；无行 not_observed',async()=>{
  const {checkJourney}=await import('../../scripts/machine-check.mjs');
  const j={feature:'demo',expect:['click-valid','result-ok'],alternatives:[['click-valid','result-bad']]};
  assert.equal(checkJourney([{feature:'demo',transition:'click-valid',trace_id:'A'},{feature:'demo',transition:'result-ok',trace_id:'A'}],j).status,'passed');
  assert.equal(checkJourney([{feature:'demo',transition:'click-valid',trace_id:'B'},{feature:'demo',transition:'result-bad',trace_id:'B'}],j).status,'passed');
  const miss=checkJourney([{feature:'demo',transition:'click-invalid',trace_id:'C'}],j);assert.equal(miss.status,'failed');assert.deepEqual(miss.observed,['click-invalid']);
  assert.equal(checkJourney([{feature:'other',transition:'x',trace_id:'D'}],j).status,'not_observed');
});
