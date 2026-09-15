/**
 * State mirror: the ONE UI component that shows what every machine on the page currently believes.
 * machine-client.mjs fires `jzz:machine` on window after each dispatch; this element writes it to the DOM as
 *   <span data-machine="login" data-state="authenticated" data-status="allowed" data-transition="login-success" data-step="7" data-trace="t_ab12cd34">
 * so "login succeeded" is `[data-machine=login][data-state=authenticated]` — one selector, no guessing which toast
 * or redirect counts. Present on every page (hidden unless health.trace_all / ?debug); tests and Storybook read it.
 * This file is the only place where "UI says X" is bound to "machine says X": keep it trivial and test it directly.
 */
const el=(tag,props={},...children)=>{const e=document.createElement(tag);for(const [k,v] of Object.entries(props)){if(v===undefined||v===null)continue;if(k==='className')e.className=v;else if(k==='hidden')e.hidden=v;else e.setAttribute(k,String(v));}e.append(...children);return e;};
const LABEL={};// optional: feature → 显示名
export function mountStateMirror(container,{visible=false}={}){
  const root=el('div',{className:'machine-state','data-machine-state':'','aria-label':'状态机镜像',hidden:!visible});
  const spans=new Map();
  const onMachine=e=>{
    const d=e.detail;if(!d)return;
    let span=spans.get(d.feature);
    if(!span){span=el('span',{'data-machine':d.feature});spans.set(d.feature,span);root.append(span);}
    span.dataset.state=d.to;span.dataset.status=d.status;span.dataset.transition=d.id??'';span.dataset.step=String(d.step);span.dataset.trace=String(d.trace_id||'').slice(0,10);span.dataset.event=d.event;
    span.textContent=`${LABEL[d.feature]||d.feature} · ${d.to}`;
  };
  window.addEventListener('jzz:machine',onMachine);
  container.append(root);
  return {root,destroy(){window.removeEventListener('jzz:machine',onMachine);root.remove();},state(feature){return spans.get(feature)?.dataset.state??null;}};
}
