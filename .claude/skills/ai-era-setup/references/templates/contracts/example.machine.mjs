/**
 * Example table — a minimal "submit a form" machine that proves the loop end to end:
 * table → `npm run contracts:sync` → contracts/example.contract.json + example.scenarios.json → `npm run test:machines`.
 * Replace it with your first real feature (keep the shape); delete it once a real table exists.
 */
import {defineMachine} from './machine.mjs';
export const machine=defineMachine({
  feature:'example',
  label:'示例表单',
  anchor:'docs/agents/ai-era.md#example',
  note:'示例：一个表单的提交生命周期。改行为先改这张表，再动代码。',
  initial:'ready',
  states:{
    ready:{terminal:false,ui:'可提交'},
    submitting:{terminal:false,ui:'请求中（按钮 disabled）'},
    failed:{terminal:false,ui:'失败，可重试'},
    done:{terminal:true,ui:'完成'},
  },
  events:['SUBMIT','API_RESULT'],
  guards:{inputValid:f=>!!f.inputValid,success:f=>f.outcome==='success'},
  transitions:[
    {id:'submit-invalid',from:'ready',event:'SUBMIT',guard:'!inputValid',to:'ready',kind:'rejected',reject_code:'INPUT_REQUIRED',effects:{api:false},invariants:['no-request-before-valid-input'],p0:true,allow:'显示字段错误；焦点回到错误字段；输入保留',forbid:'发请求；进入 loading',covered_by:['tests/machines/contracts.test.mjs::example']},
    {id:'submit',from:'ready',event:'SUBMIT',guard:'inputValid',to:'submitting',kind:'allowed',effects:{api:true,intent:true},invariants:['no-double-submit'],p0:true,allow:'恰好 1 次请求；按钮 disabled',forbid:'两次请求',covered_by:['tests/machines/contracts.test.mjs::example']},
    {id:'double-submit',from:'submitting',event:'SUBMIT',to:'submitting',kind:'noop',reject_code:'DUPLICATE_SUBMIT',effects:{api:false},invariants:['no-double-submit'],p0:false},
    {id:'api-success',from:'submitting',event:'API_RESULT',guard:'success',to:'done',kind:'allowed',effects:{},invariants:[],p0:true,allow:'成功提示；离开表单',forbid:'再次提交',covered_by:['tests/machines/contracts.test.mjs::example']},
    {id:'api-failed',from:'submitting',event:'API_RESULT',to:'failed',kind:'allowed',effects:{},invariants:['failure-preserves-input'],p0:false,allow:'错误文案 + 请求号；输入保留；可重试',forbid:'清空输入；无限 loading'},
    {id:'retry',from:'failed',event:'SUBMIT',guard:'inputValid',to:'submitting',kind:'allowed',effects:{api:true,intent:true},invariants:['no-double-submit'],p0:false},
  ],
  invariants:{
    'no-request-before-valid-input':{text:'输入不合法时不发请求',enforcement:'planned',note:'接入真实表单后把证据写成 file::text'},
    'no-double-submit':{text:'loading 中重复提交不产生第二次请求',enforcement:'planned',note:'同上'},
    'failure-preserves-input':{text:'失败不清空输入、不跳转',enforcement:'planned',note:'同上'},
  },
});
