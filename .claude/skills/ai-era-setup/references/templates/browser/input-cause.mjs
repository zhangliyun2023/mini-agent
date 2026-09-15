// Last input modality (标准 §6.1 维度 3 / 参照实现 input-cause.ts): captured in the capture phase so every machine
// transition can say whether the user came by mouse, touch, pen or keyboard (Enter / Space / other).
let last={kind:'mouse',key:null},bound=false;
export function labelInput(c=last){
  if(c.kind==='keyboard')return c.key==='Enter'?'键盘Enter':c.key===' '?'键盘空格':'键盘';
  return c.kind==='pen'?'笔':c.kind==='touch'?'触摸':'鼠标';
}
export const lastInputLabel=()=>labelInput(last);
export function bindInputCause(){
  if(bound||typeof window==='undefined')return;bound=true;
  window.addEventListener('pointerdown',e=>{last={kind:e.pointerType==='pen'?'pen':e.pointerType==='touch'?'touch':'mouse',key:null};document.documentElement.dataset.modality='pointer';},true);
  window.addEventListener('keydown',e=>{last={kind:'keyboard',key:e.key};if(['Tab','Enter',' '].includes(e.key))document.documentElement.dataset.modality='keyboard';},true);
}
