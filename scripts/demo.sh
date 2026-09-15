#!/usr/bin/env bash
# 零操作看效果：固定几句话跑完 loop / 工具 / session 隔离 / 记忆 / 每日复盘，右侧回显状态转移。
# 需要 .env 里有 key；数据落在临时目录，不碰 data/。
set -e
DATA=$(mktemp -d /tmp/mini-agent-demo.XXXX)
echo "▶ 数据目录：$DATA"
echo
echo "━━ 窗口 1（user A / session w1）━━"
printf '帮我算 (137*29+1234)/7 保留两位\n上海今天天气\n记两条待办：买牛奶、写周报\n第一条做完了，把清单给我\n记住我叫小张，常住上海\n那我住哪\n' \
  | npx tsx src/cli.ts --user A --session w1 --data "$DATA" 2>&1 | grep -v secretStore
echo
echo "━━ 窗口 2（同一用户，另一个 session）━━"
printf '我的待办清单里有什么\n我叫什么、住哪\n' \
  | npx tsx src/cli.ts --user A --session w2 --data "$DATA" --quiet 2>&1
echo
echo "━━ 次日早上的复盘（把「昨天」= 刚才这两个窗口）━━"
TOMORROW=$(python3 -c "import datetime;print((datetime.date.today()+datetime.timedelta(days=1)).isoformat())")
npx tsx src/review/cli.ts --user A --date "$TOMORROW" --tz Asia/Shanghai --deliver w1 --data "$DATA" || true
echo
echo "━━ 盘上产物 ━━"
echo "会话：      $DATA/sessions/A/w1.json  w2.json"
echo "长期记忆：  $DATA/memory/A.memory.json"
echo "转写(Raw)： $DATA/transcripts/A/*.jsonl"
echo "复盘日志：  $DATA/reviews/A/$TOMORROW.json"
echo "trace：     trace/w1.jsonl（一次状态转移一行）"
echo
echo "验证不变量：python3 evals/judge.py trace/   # 或 npm test"
