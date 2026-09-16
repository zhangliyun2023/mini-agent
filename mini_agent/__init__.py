"""mini-agent：从零实现的最小可用 Agent Runtime（Python 版）。

字典键的约定：所有落盘 / 进 trace / 发给模型的对象（消息、转移记录、记忆条目、journal）都是普通 dict，
键名与 JSON 契约一致（沿用 TS 版的 camelCase，如 toolCallId / promptTokens / sessionId），
这样 evals/judge.py、contracts/*.contract.json、evals/live-trace/ 的证据在两个实现之间可以互读。
函数名、参数名按 Python 习惯用 snake_case。
"""
