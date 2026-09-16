"""S6：AGENTS.md 是唯一入口，它引用的文件与命令必须真的存在——文档漂了就红。"""
import os
import re

agents = open("AGENTS.md", encoding="utf8").read()
ticks = re.findall(r"`([^`\n]+)`", agents)
makefile = open("Makefile", encoding="utf8").read()
make_targets = set(re.findall(r"^([a-z][\w-]*):", makefile, re.M))


def test_backticked_paths_exist():
    paths = [t for t in ticks if re.match(r"^[\w./一-龥-]+\.(md|py|json|sh)$", t) and "*" not in t and "<" not in t]
    assert len(paths) > 10
    assert [p for p in paths if not os.path.exists(p)] == []


def test_backticked_make_commands_exist():
    cmds = [t for t in ticks if re.match(r"^make ", t)]
    assert len(cmds) > 5
    missing = [c for c in cmds if re.match(r"^make ([\w-]+)", c).group(1) not in make_targets]
    assert missing == []
    # 审计点名的幽灵脚本不能回来
    assert "serve" not in make_targets


def test_doc_set_present_and_report_layers():
    for f in ("AGENTS.md", "README.md", "AI-LOG.md", "docs/product/SPEC-state-machines.md", "docs/TEST_REPORT.md", "docs/NEXT_STEPS.md"):
        assert os.path.exists(f), f
    report = open("docs/TEST_REPORT.md", encoding="utf8").read()
    assert re.search("纯函数通过", report) and re.search("假模型通过", report) and re.search("少量 smoke", report)
    assert not re.search(r"可靠率\s*[\d%]", report)
    assert len(re.findall(r"^\| [1-8] \| ", report, re.M)) == 8


def test_all_unit_test_files_listed_in_agents():
    on_disk = [f for f in os.listdir("tests/unit") if f.startswith("test_") and f.endswith(".py")]
    assert len(on_disk) > 10
    for f in on_disk:
        assert f"tests/unit/{f}" in agents, f"AGENTS.md 没列 tests/unit/{f}"
    assert "tests/live/test_live.py" in agents


def test_c1_agents_sections_and_rules():
    heads = [h.strip() for h in re.findall(r"^## (.+)$", agents, re.M)]
    assert heads == ["产品是什么", "铁律", "门禁", "地图", "禁止事项", "提交纪律", "证据口径", "Agent skills / tracker / 标签", "什么时候用哪个 skill"]
    assert re.search(r"ai-era-skills \d+\.\d+\.\d+", agents)
    rules = re.findall(r"^\d+\. ", agents.split("## 铁律")[1].split("## 门禁")[0], re.M)
    assert 0 < len(rules) <= 10


def test_c1_architecture_machine_list_matches_contracts():
    arch = open("docs/ARCHITECTURE.md", encoding="utf8").read()
    files = [f[: -len("_machine.py")].replace("_", "-") for f in os.listdir("contracts") if f.endswith("_machine.py")]
    assert len(files) == 4
    for f in files:
        assert re.search(rf"\| `{f}` \| (闸|影子|旅程) \|", arch), f"机器清单少了 {f}"
    listed = re.findall(r"^\| `([a-z-]+)` \| (闸|影子|旅程) \|([^\n]*)$", arch, re.M)
    assert sorted(m[0] for m in listed) == sorted(files)
    for name, _, rest in listed:
        proofs = re.findall(r"`((?:tests|mini_agent|scripts)/[^`]+)`", rest)
        assert proofs, f"{name} 没写谁证明"
        for p in proofs:
            assert os.path.exists(p), p


def test_c1_gate_sh_order_and_evidence():
    assert os.path.exists("scripts/gate.sh")
    gate = open("scripts/gate.sh", encoding="utf8").read()
    order = [gate.index(k) for k in ("typecheck", "make -s test\n", "contracts-check", "test-live")]
    assert order == sorted(order)
    assert re.search(r"docs/evidence/", gate) and re.search("skipped ≠ 通过", gate)
    assert "scripts/gate.sh" in agents


def test_counts_single_source_of_truth():
    """TEST_REPORT §0 一张表逐文件条数 == 源码静态计数（def test_ 记 1，parametrize 行按 `# ×N` 标记记 N−1 的展开），总数与文件数也对；AGENTS.md / README 不写总数"""
    files = sorted(f for f in os.listdir("tests/unit") if f.startswith("test_") and f.endswith(".py"))
    from_source = {}
    for f in files:
        src = open(f"tests/unit/{f}", encoding="utf8").read()
        n = len(re.findall(r"^def test_", src, re.M))
        for ln in [l for l in src.split("\n") if re.search(r"parametrize\(", l) or re.search(r"^\]\)\s*#", l)]:
            m = re.search(r"#\s*×(\d+)\s*$", ln)
            if m:
                n += int(m.group(1)) - 1  # 该 def 已记 1，展开 N 条再补 N−1
        from_source[f] = n
    report = open("docs/TEST_REPORT.md", encoding="utf8").read()
    from_report = {}
    for m in re.finditer(r"^\| `tests/unit/(test_[\w]+\.py)` \| [^|]* \| (\d+) \|", report, re.M):
        assert m.group(1) not in from_report, f"{m.group(1)} 在 TEST_REPORT 里出现了两次条数"
        from_report[m.group(1)] = int(m.group(2))
    assert from_report == from_source
    total = sum(from_source.values())
    head = re.search(r"\| `make test` \| \*\*(\d+) 文件 (\d+) 条全绿", report)
    assert head, "TEST_REPORT §0 缺 `make test` 行"
    assert [int(head.group(1)), int(head.group(2))] == [len(files), total]
    total_row = re.search(r"^\| 合计 \| (\d+) 文件 \| (\d+) \|", report, re.M)
    assert total_row, "TEST_REPORT §0 条数表缺合计行"
    assert [int(total_row.group(1)), int(total_row.group(2))] == [len(files), total]
    for f in ("AGENTS.md", "README.md"):
        assert not re.search(r"\d+ 条(单测|全绿)|\d+ 文件 \d+ 条", open(f, encoding="utf8").read()), f
