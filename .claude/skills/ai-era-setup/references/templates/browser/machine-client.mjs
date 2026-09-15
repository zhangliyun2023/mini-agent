/**
 * Browser runtime for a contracts/*.machine.mjs table (SPEC-state-machines §4).
 * `dispatch(event, facts)` runs the shared interpreter, advances the state on `allowed`, and emits one
 * transition record: a console line (`登录 · CLICK_LOGIN · ready→submitting · allowed · 鼠标`) plus, when it
 * matters, a `machine_transition` event to the server. What "matters": in test mode (health.trace_all)
 * everything; otherwise only transitions with side effects, blocked and unknown (D4).
 *
 * trace_id (D5): minted when an allowed transition starts a side effect (`effects.api`), kept until the machine
 * settles, and sent as X-Trace-Id by api() so runs/audit/events rows carry the same id. Blocked/unknown
 * transitions get their own one-off id — each is its own intent.
 */
import {lastInputLabel,bindInputCause} from './input-cause.mjs';
const mint=()=>'t_'+crypto.randomUUID().replaceAll('-','');
let active=null;
export const currentTraceId=()=>active;
export function createMachineRuntime(machine,{post,traceAll=false,anonymousId=()=>'anon',initial=null,onTransition=null,persist=null}={}){
  bindInputCause();
  // persist: a sessionStorage key for a cross-page journey (D10). State, step and the journey trace_id survive navigation;
  // every allowed transition of a persisted machine reuses that one trace_id until a terminal state clears it.
  let state=initial??machine.initial,step=0,journey=null,current=null;// current = this runtime's intent trace
  const load=()=>{if(!persist)return;try{const v=JSON.parse(sessionStorage.getItem(persist)||'null');if(v&&machine.states[v.state]){state=v.state;step=v.step||0;journey=v.trace_id||null;}}catch{/* no storage */}};
  const save=()=>{if(!persist)return;try{if(machine.states[state]?.terminal)sessionStorage.removeItem(persist);else sessionStorage.setItem(persist,JSON.stringify({state,step,trace_id:journey}));}catch{/* no storage */}};
  load();current=journey;
  // Announce the starting state so the mirror shows what the machine believes before any gesture (e.g. editor re-rendered at `applied`).
  if(typeof window!=='undefined')window.dispatchEvent(new CustomEvent('jzz:machine',{detail:{feature:machine.feature,from:state,to:state,event:'INIT',status:'init',reason:null,input:null,step,trace_id:current,id:null}}));
  const label=machine.label||machine.feature;// give the table a `label` for console lines
  function dispatch(event,facts={}){
    const out=machine.interpret(state,event,facts);const input=lastInputLabel();step++;
    if(out.status==='allowed'){
      // One intent = one trace_id. A new intent starts when the machine leaves its initial state, when the row says
      // `effects.intent` (a fresh submit/retry/send), or when nothing is in flight; a persisted journey keeps its id.
      if(current===null||(!persist&&(out.from===machine.initial||out.effects?.intent)))current=mint();
      if(persist)journey=current;
      active=current;
      if(out.to!==out.from)state=out.to;
    }
    const trace_id=out.status==='allowed'?current:mint();
    if(out.status==='allowed'&&machine.states[out.to]?.terminal){active=null;current=null;if(persist)journey=null;}
    save();
    const record={feature:machine.feature,from:out.from,to:out.to,event,status:out.status,reason:out.reason??null,input,step,trace_id,id:out.id};
    console.log(`${label} · ${event} · ${out.from}→${out.to} · ${out.status}${out.reason?' · '+out.reason:''} · ${input}`,record);
    // Worth a server round-trip: side effects, blocked, unknown, user-caused noops (DUPLICATE_SUBMIT/BUSY) — never a polling `UNCHANGED`.
    const userNoop=out.status==='noop'&&out.reason!=='UNCHANGED';
    const worth=(traceAll&&out.reason!=='UNCHANGED')||out.status==='blocked'||out.status==='unknown'||userNoop||!!out.effects?.api||!!out.effects?.navigate||!!out.effects?.cookie;
    if(worth&&post)post({name:'machine_transition',event_id:crypto.randomUUID(),anonymous_id:anonymousId(),feature:record.feature,from:record.from,to:record.to,event,status:record.status,reason:record.reason??undefined,input,step,transition:out.id??undefined},trace_id).catch(()=>{});
    onTransition?.(record,out);
    // The state mirror (machine-state.mjs) and anything else on the page hears every transition here.
    if(typeof window!=='undefined')window.dispatchEvent(new CustomEvent('jzz:machine',{detail:record}));
    return {...out,trace_id};// callers that fire a request on a terminal transition (e.g. fork CONFIRM) need the id after `active` was cleared
  }
  return {dispatch,get state(){return state;},set state(v){state=v;save();},get traceId(){return journey;},machine};
}
