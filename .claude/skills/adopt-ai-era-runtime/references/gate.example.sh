#!/usr/bin/env bash
# 一键门禁：固定顺序，每条命令的输出落 docs/evidence/<label>/<n>-<name>.txt，首行环境、末行 exit N (expected M)。
# 期望非零的命令（无 key 时 live 被 skip）写清「不是通过」。
set -u
LABEL=${1:-$(date +%Y%m%d-%H%M)}
OUT=docs/evidence/$LABEL; mkdir -p "$OUT"
run() { # run <name> <expected-exit> <cmd...>
  local name=$1 exp=$2; shift 2
  local f="$OUT/$name.txt"
  { echo "# $(date -Iseconds) node=$(node -v) $(git rev-parse --short HEAD)"; "$@"; echo "exit $? (expected $exp)"; } >"$f" 2>&1
  tail -1 "$f" | grep -q "exit $exp " && echo "PASS $name" || { echo "FAIL $name  ($f)"; FAILED=1; }
}
FAILED=0
run 1-typecheck 0 npm run -s typecheck
run 2-unit 0 npm test -s
run 3-contracts 0 npm run -s contracts:check
if [ -n "${OPENAI_API_KEY:-}" ] || [ -f .env ]; then run 4-live 0 npm run -s test:live; else echo "SKIP 4-live (no key) —— skipped ≠ 通过" | tee "$OUT/4-live.txt"; fi
exit $FAILED
