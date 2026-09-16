"""mock 搜索：一小份本地语料，按关键词命中数排序。真接搜索引擎时只换 handler，schema 与 compact 不动。"""
import re
from typing import List

from .registry import ToolDefinition

CORPUS = [
    {"title": "上海今日天气", "snippet": "上海 9 月 15 日多云转晴，24-30℃，东南风 3 级。"},
    {"title": "北京今日天气", "snippet": "北京 9 月 15 日晴，18-27℃，空气质量优。"},
    {"title": "TypeScript 5.9 发布说明", "snippet": "TypeScript 5.9 引入 --module node20、import defer 等特性。"},
    {"title": "Node.js 24 LTS", "snippet": "Node.js 24 于 2025 年 10 月进入 LTS，内置 fetch 与 WebSocket 稳定。"},
    {"title": "Agent Loop 是什么", "snippet": "Agent Loop：模型决定是否调用工具 → 执行 → 结果回填 context → 再判断，直到给出最终答案。"},
    {"title": "上海地铁运营时间", "snippet": "上海地铁大部分线路 5:30 首班、23:00 前后末班，节假日有延长。"},
    {"title": "咖啡因半衰期", "snippet": "成人体内咖啡因半衰期约 5 小时，下午 3 点后饮用可能影响睡眠。"},
]

# 2026-09-15 live 暴露（#3）：模型搜「上海今天天气」（无空格），语料是「上海今日天气」，
# 按空格分词后整串子串匹配命中不了。改为：去停用词 → 中文按二元组切、非中文按整词，
# 任一片段命中即计分，命中片段多者靠前。
STOP_WORDS = ["今天", "今日", "现在", "怎么样", "怎样", "如何", "是什么", "什么", "多少", "请问", "帮我", "一下", "的", "吗", "呢", "了", "是"]
CJK_RUN = re.compile(r"[一-鿿]+")
_SPLIT = re.compile(r"[\s，。、？！：]+")


def search_terms(query: str) -> List[str]:
    """查询 → 匹配片段：中文二元组（单字保留）+ 小写的非中文整词"""
    q = str(query)
    for w in STOP_WORDS:
        q = q.replace(w, " ")
    terms: List[str] = []

    def add(t: str) -> None:
        if t not in terms:
            terms.append(t)

    for run in CJK_RUN.findall(q):
        if len(run) == 1:
            add(run)
        for i in range(len(run) - 1):
            add(run[i : i + 2])
    for w in _SPLIT.split(CJK_RUN.sub(" ", q).lower()):
        if w:
            add(w)
    return terms


def _handler(args: dict, ctx: dict) -> str:
    query = args["query"]
    terms = search_terms(query)
    scored = []
    for doc in CORPUS:
        text = (doc["title"] + doc["snippet"]).lower()
        score = sum(1 for t in terms if t in text)
        if score > 0:
            scored.append((score, doc))
    scored.sort(key=lambda x: -x[0])
    top = scored[:3]
    if not top:
        return f"没有找到与「{query}」相关的结果。"
    return "\n".join(f"- {doc['title']}：{doc['snippet']}" for _, doc in top)


search_tool = ToolDefinition(
    name="search",
    description="搜索公开信息（天气、新闻、常识）。返回最多 3 条标题+摘要。",
    parameters={"type": "object", "properties": {"query": {"type": "string", "description": "搜索关键词"}}, "required": ["query"]},
    handler=_handler,
    # 搜索结果本来就短，精简 = 原样；真接搜索引擎时这里改成只留 title+snippet
    compact=lambda raw: raw,
)
