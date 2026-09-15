#!/usr/bin/env node
/**
 * Scaffold the AI-era system into a repository. Deterministic, idempotent, never overwrites an existing file.
 *
 *   node <skill-dir>/setup.mjs <repo> [--browser-dir src/machines] [--tests-dir tests/machines] [--dry-run]
 *
 * Writes: contracts/{machine.mjs, example.machine.mjs, journeys.json, README.md} (+ generated JSON via sync),
 *         scripts/{contracts-sync.mjs, machine-scenarios.mjs, machine-check.mjs},
 *         tests/machines/{machine.test.mjs, contracts.test.mjs}, <browser-dir>/{machine-client,machine-state,input-cause}.mjs,
 *         docs/agents/ai-era.md; merges package.json scripts contracts:sync / contracts:check / test:machines;
 *         appends an "AI 时代体系" pointer block to AGENTS.md (or CLAUDE.md if that is the one that exists).
 * Exits 0 with a summary; prints SKIPPED for anything already present.
 */
import {existsSync,mkdirSync,readFileSync,writeFileSync,cpSync,readdirSync,statSync} from 'node:fs';
import path from 'node:path';
import {execSync} from 'node:child_process';
const here=path.dirname(new URL(import.meta.url).pathname);const T=path.join(here,'templates');
const args=process.argv.slice(2);const repo=path.resolve(args.find(a=>!a.startsWith('--'))||'.');
const opt=(k,d)=>{const i=args.indexOf(k);return i>=0?args[i+1]:d;};const dry=args.includes('--dry-run');
const browserDir=opt('--browser-dir','src/machines'),testsDir=opt('--tests-dir','tests/machines');
const log=[];const put=(rel,src)=>{const dst=path.join(repo,rel);if(existsSync(dst)){log.push(`SKIPPED  ${rel}（已存在）`);return false;}if(!dry){mkdirSync(path.dirname(dst),{recursive:true});cpSync(src,dst);}log.push(`written  ${rel}`);return true;};
if(!existsSync(path.join(repo,'package.json'))){console.error(`${repo} 没有 package.json：先 npm init -y（Node 工具链是这套脚手架的前提；别的语言先按 /ai-era-setup 第 5 步 runtime 列移植解释器）`);process.exit(2);}
// files
for(const f of ['machine.mjs','journeys.json','README.md'])put(`contracts/${f}`,path.join(T,'contracts',f));
{ // the example table's covered_by anchors point at the tests dir the user chose
  const dst=path.join(repo,'contracts/example.machine.mjs');
  if(existsSync(dst))log.push('SKIPPED  contracts/example.machine.mjs（已存在）');
  else{const body=readFileSync(path.join(T,'contracts/example.machine.mjs'),'utf8').replaceAll('tests/machines/',testsDir.replace(/\/$/,'')+'/');if(!dry){mkdirSync(path.dirname(dst),{recursive:true});writeFileSync(dst,body);}log.push('written  contracts/example.machine.mjs');}
}
for(const f of ['contracts-sync.mjs','machine-scenarios.mjs','machine-check.mjs'])put(`scripts/${f}`,path.join(T,'scripts',f));
for(const f of ['machine.test.mjs','contracts.test.mjs']){
  const dst=path.join(repo,testsDir,f);if(existsSync(dst)){log.push(`SKIPPED  ${testsDir}/${f}`);continue;}
  // tests import ../../contracts and ../../scripts: rewrite when testsDir is not two levels deep
  const depth=testsDir.split('/').filter(Boolean).length;const up='../'.repeat(depth);
  const body=readFileSync(path.join(T,'tests/machines',f),'utf8').replaceAll("'../../contracts/","'"+up+"contracts/").replaceAll("'../../scripts/","'"+up+"scripts/").replaceAll("path.resolve(import.meta.dirname,'../..')","path.resolve(import.meta.dirname,'"+up.replace(/\/$/,'')+"')").replaceAll('tests/machines/',testsDir.replace(/\/$/,'')+'/');
  if(!dry){mkdirSync(path.dirname(dst),{recursive:true});writeFileSync(dst,body);}log.push(`written  ${testsDir}/${f}`);
}
for(const f of ['machine-client.mjs','machine-state.mjs','input-cause.mjs'])put(`${browserDir}/${f}`,path.join(T,'browser',f));
put('docs/agents/ai-era.md',path.join(T,'docs/agents/ai-era.md'));
// package.json scripts
const pkgPath=path.join(repo,'package.json');const pkg=JSON.parse(readFileSync(pkgPath,'utf8'));pkg.scripts??={};
const want={'contracts:sync':'node scripts/contracts-sync.mjs && node scripts/machine-scenarios.mjs','contracts:check':'node scripts/contracts-sync.mjs --check && node scripts/machine-scenarios.mjs --check','test:machines':`node --test "${testsDir.replace(/\/$/,'')}/*.test.mjs"`};
for(const [k,v] of Object.entries(want)){if(pkg.scripts[k]){log.push(`SKIPPED  package.json scripts.${k}（已存在：${pkg.scripts[k]}）`);continue;}pkg.scripts[k]=v;log.push(`script   ${k} = ${v}`);}
if(!dry)writeFileSync(pkgPath,JSON.stringify(pkg,null,2)+'\n');
// agent pointer block
const target=existsSync(path.join(repo,'CLAUDE.md'))&&!readFileSync(path.join(repo,'CLAUDE.md'),'utf8').trim().startsWith('@AGENTS.md')?'CLAUDE.md':'AGENTS.md';
const block=`\n## AI 时代体系（由 /ai-era-setup 生成）\n\n改任何用户可见行为先改 \`contracts/<feature>.machine.mjs\`，再 \`npm run contracts:sync\`，再动代码；\`npm run test:machines\` 与 \`npm run contracts:check\` 进门禁；对答案用 \`node scripts/machine-check.mjs\`。铁律、门禁、地图见 \`docs/agents/ai-era.md\`；入口 \`/ai-era-setup\`；什么时候用哪个 skill 见 AGENTS.md 第 9 节。\n`;
const tp=path.join(repo,target);const cur=existsSync(tp)?readFileSync(tp,'utf8'):'';
if(cur.includes('由 /setup-ai-era 生成')||cur.includes('由 /ai-era-setup 生成'))log.push(`SKIPPED  ${target} 已有指向块`);else{if(!dry)writeFileSync(tp,cur+(cur&&!cur.endsWith('\n')?'\n':'')+block);log.push(`block    ${target} 追加「AI 时代体系」指向块`);}
// generate + verify
if(!dry){
  try{execSync('node scripts/contracts-sync.mjs && node scripts/machine-scenarios.mjs',{cwd:repo,stdio:'pipe'});log.push('sync     contracts/*.contract.json / *.scenarios.json 已生成');}catch(e){log.push('FAILED   contracts:sync：'+String(e.stdout||e.message).slice(0,300));}
  try{const out=execSync(`node --test "${testsDir.replace(/\/$/,'')}/*.test.mjs" 2>&1`,{cwd:repo,encoding:'utf8'});const m=/pass (\d+)[\s\S]*fail (\d+)/.exec(out);log.push(`verify   test:machines → pass ${m?.[1]} fail ${m?.[2]}`);if(m&&m[2]!=='0')process.exitCode=1;}catch(e){log.push('FAILED   test:machines：'+String(e.stdout||e.message).slice(0,400));process.exitCode=1;}
}
console.log(log.join('\n'));
console.log(`\n下一步：把示例表换成第一张真实表（/machine-contract）；把 ${browserDir}/machine-client.mjs 接进页面（/trace-transitions）；把 test:machines 与 contracts:check 接进现有门禁；观察到的转移导出成 jsonl 后用 machine-check 对答案（/answer-key）。`);
