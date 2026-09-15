/**
 * Docs-don't-rot oracle. AGENTS.md is the single entry for any agent; these checks keep it and the pages it points
 * to tied to the code: required sections exist, every machine table is listed in the architecture map, every gate
 * command AGENTS.md names is a real npm script, every doc it links to exists, and the glossary covers the vocabulary
 * the rest of the docs use. Change the rules → change these tests in the same commit.
 */
import {test} from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync,readdirSync,existsSync} from 'node:fs';
import path from 'node:path';
const ROOT=path.resolve(import.meta.dirname,'../..');
const read=f=>readFileSync(path.join(ROOT,f),'utf8');

test('AGENTS.md：保留 Next 的托管块，且有九个必需章节与技能族版本行',()=>{
  const s=read('AGENTS.md');
  assert.ok(s.includes('<!-- BEGIN:nextjs-agent-rules -->')&&s.includes('<!-- END:nextjs-agent-rules -->'),'Next 托管块不能删');
  for(const h of ['## 这个产品是什么（一句话）','## 铁律（改行为前必读）','## 门禁（提交前必须全绿，顺序固定）','## 地图（去哪找什么）','## 禁止事项','## 提交纪律','## 证据口径','## Agent skills / tracker / 标签','## 什么时候用哪个 skill'])assert.ok(s.includes(h),'AGENTS.md 缺章节 '+h);
  assert.match(s,/本仓技能族：ai-era-skills \d+\.\d+\.\d+/,'AGENTS.md 缺技能族版本行');
});

test('AGENTS.md 地图里指向的每个文档都存在',()=>{
  const s=read('AGENTS.md');
  for(const m of s.matchAll(/`((?:docs|contracts)\/[A-Za-z0-9_./-]+\.md)`/g))assert.ok(existsSync(path.join(ROOT,m[1])),'AGENTS.md 指向不存在的文档 '+m[1]);
});

test('AGENTS.md 门禁里的每条 npm 命令都是 package.json 里真实存在的脚本',()=>{
  const s=read('AGENTS.md');const scripts=JSON.parse(read('package.json')).scripts;
  const gate=s.slice(s.indexOf('## 门禁'),s.indexOf('## 地图'));
  for(const m of gate.matchAll(/npm run ([a-z0-9:_-]+)/g))assert.ok(scripts[m[1]],'AGENTS.md 门禁引用了不存在的脚本 npm run '+m[1]);
  assert.ok(scripts.test&&/scripts\/verify\.sh/.test(gate),'门禁必须包含 npm test 与 verify.sh');
});

test('docs/ARCHITECTURE.md 的机器清单与 contracts/*.machine.mjs 一一对应',()=>{
  const arch=read('docs/ARCHITECTURE.md');
  const machines=readdirSync(path.join(ROOT,'contracts')).filter(f=>f.endsWith('.machine.mjs')).map(f=>f.replace('.machine.mjs',''));
  const listed=[...arch.matchAll(/^\| `([a-z]+)` \| (闸|影子|旅程)/gm)].map(m=>m[1]);
  for(const m of machines)assert.ok(listed.includes(m),`ARCHITECTURE.md 机器清单缺 ${m}`);
  for(const l of listed)assert.ok(machines.includes(l),`ARCHITECTURE.md 列了不存在的机器 ${l}`);
  assert.match(arch,/十一台机器|\d+ 台机器/);
});

test('铁律与 PLAYBOOK 提到的关键文件都存在',()=>{
  const s=read('AGENTS.md')+read('docs/PLAYBOOK.md')+read('docs/ARCHITECTURE.md');
  for(const f of ['contracts/machine.mjs','contracts/journeys.json','scripts/machine-check.mjs','public/platform/machine-state.mjs','public/platform/machine-client.mjs','server/trace.mjs','server/verify.mjs','scripts/verify.sh','tests/platform/next_e2e.py','docs/storybook/README.md']){
    assert.ok(s.includes(f),'文档没有提到 '+f);assert.ok(existsSync(path.join(ROOT,f)),'文档提到的文件不存在 '+f);
  }
});

test('GLOSSARY 覆盖本仓文档里用到的核心词',()=>{
  const g=read('docs/GLOSSARY.md');
  for(const term of ['Statechart','Model-based testing','oracle','conformance','coverage','等价类','不变量','event sourcing','trace','闸 / 影子','差分'])assert.ok(g.includes(term),'GLOSSARY 缺 '+term);
});

test('README 把 agent 指向 AGENTS.md',()=>{assert.ok(read('README.md').includes('AGENTS.md'),'README 应指向 AGENTS.md');});
