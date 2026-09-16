# mini-agent（Python 版）入口。PY 缺省 python3；用 uv 的话：make PY="uv run python"
PY ?= python3

.PHONY: install test test-live typecheck contracts-gen contracts-check check chat review demo judge

install:            ## 装依赖（openai + pytest）
	$(PY) -m pip install -e ".[dev]"

test:               ## 全部单测，不需要 key；条数见 docs/TEST_REPORT.md §0
	$(PY) -m pytest tests/unit -q

test-live:          ## 真实模型 5 个 smoke（需要 .env 里的 key）；trace 写到 evals/live-trace/
	LIVE=1 $(PY) -m pytest tests/live -q -rs

typecheck:          ## 语法 + 字节码编译（无第三方类型检查器依赖）
	$(PY) -m compileall -q mini_agent contracts scripts tests evals

contracts-gen:      ## 改了表之后重新生成契约 JSON（然后看 diff）
	$(PY) -m scripts.contracts write

contracts-check:    ## 盘上 contracts/*.contract.json 与表是否漂移，漂了退出码 1
	$(PY) -m scripts.contracts check

check: typecheck contracts-check test   ## 提交前跑这个

chat:               ## CLI：make chat ARGS="--user A --session w1 [--native-tools] [--quiet] [--data dir]"
	$(PY) -m mini_agent.cli $(ARGS)

review:             ## 每日复盘 CLI：make review ARGS="--user A [--date] [--tz] [--deliver w1] [--fake ok|no_chat|partial_read] [--data dir] [--json]"
	$(PY) -m mini_agent.review.cli $(ARGS)

demo:               ## 零操作演示（要 key）：固定几句跑完 loop / 工具 / 双窗口 / 记忆 / 次日复盘
	PY="$(PY)" bash scripts/demo.sh

judge:              ## Python 判分器：对已提交的真实模型 trace 跑不变量
	$(PY) evals/judge.py evals/live-trace
