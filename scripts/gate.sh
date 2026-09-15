#!/usr/bin/env bash
# 一键门禁：固定顺序 类型检查 → 单测 → 契约漂移 → 真实模型 → Python 判分器，每条命令的输出落 docs/evidence/<label>/<n>-<name>.txt。
# 每个文件：首行环境（时间、node、commit），末行 `exit N (expected M)`。
# live 没有 key（或 GATE_LIVE=0）时写 SKIP 文件——skipped ≠ 通过，报告里必须分开写。
# 用法：bash scripts/gate.sh v0.2        （label 缺省 = 日期时间）
set -u
cd "$(dirname "$0")/.."
LABEL=${1:-$(date +%Y%m%d-%H%M)}
OUT=docs/evidence/$LABEL
mkdir -p "$OUT"
FAILED=0
header() { echo "# $(date -Iseconds) node=$(node -v) commit=$(git rev-parse --short HEAD) label=$LABEL cmd: $*"; }
run() { # run <name> <expected-exit> <cmd...>
  local name=$1 exp=$2; shift 2
  local f="$OUT/$name.txt"
  { header "$@"; "$@"; echo "exit $? (expected $exp)"; } >"$f" 2>&1
  if tail -1 "$f" | grep -q "^exit $exp (expected"; then echo "PASS $name"; else echo "FAIL $name  ($f)"; FAILED=1; fi
}
run 1-typecheck 0 npm run -s typecheck
run 2-unit 0 npm test -s --
run 3-contracts 0 npm run -s contracts:check
has_key() {
  [ "${GATE_LIVE:-1}" = "0" ] && return 1
  [ -n "${OPENAI_API_KEY:-}" ] && return 0
  [ -f .env ] && grep -E '^OPENAI_API_KEY=.+' .env 2>/dev/null | grep -vq 'sk-xxx'
}
if has_key; then
  run 4-live 0 npm run -s test:live
else
  { header "npm run -s test:live"; echo "SKIP 4-live：没有 key（或 GATE_LIVE=0）—— skipped ≠ 通过，真实模型这一层本次 not_run"; echo "exit 0 (expected 0) [skipped]"; } >"$OUT/4-live.txt"
  echo "SKIP 4-live (no key) —— skipped ≠ 通过"
fi
# 6：Python 判分器（#13）只凭已提交 + 本次 live 新产出的 JSONL 跑 ① ② ③ ⑤ + unknown 点名；与 TS 侧 evidence.ts 独立实现互为对照。
# 退出码 0 = 全部 passed 且 unknown=0；1 = 有 failed / unknown；2 = 没观察到任何轮（not_observed ≠ 通过）。（5 留给变异证据）
run 6-judge 0 python3 evals/judge.py evals/live-trace
echo "evidence: $OUT"
exit $FAILED
