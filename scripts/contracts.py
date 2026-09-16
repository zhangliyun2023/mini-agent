"""用法：python -m scripts.contracts write   → 由表重新生成 contracts/*.contract.json
      python -m scripts.contracts check   → 盘上 JSON 与表有漂移则退出码 1
表的清单不硬编码：收集 contracts/ 下全部 *_machine.py，每个模块导出的那张表（feature 必须等于文件名，下划线换连字符）→ contracts/<feature>.contract.json。
"""
import importlib
import os
import sys
from typing import List, Tuple

from mini_agent.machine.interpreter import Machine, render_contract


def collect_contracts(directory: str = "contracts") -> List[Tuple[Machine, str]]:
    out: List[Tuple[Machine, str]] = []
    for f in sorted(x for x in os.listdir(directory) if x.endswith("_machine.py")):
        name = f[: -len("_machine.py")].replace("_", "-")
        mod = importlib.import_module(f"{directory}.{f[:-3]}")
        machines = [v for v in vars(mod).values() if isinstance(v, Machine)]
        if len(machines) != 1:
            raise RuntimeError(f"{directory}/{f} 应恰导出一张表，实际 {len(machines)} 张")
        if machines[0].feature != name:
            raise RuntimeError(f'{directory}/{f} 的 feature "{machines[0].feature}" 与文件名 "{name}" 不一致')
        out.append((machines[0], os.path.join(directory, f"{name}.contract.json")))
    return out


def main(argv: List[str]) -> int:
    mode = argv[0] if argv else None
    if mode not in ("write", "check"):
        print("用法：python -m scripts.contracts <write|check>", file=sys.stderr)
        return 2
    drift = 0
    for machine, path in collect_contracts():
        expected = render_contract(machine)
        if mode == "write":
            with open(path, "w", encoding="utf8") as f:
                f.write(expected)
            print(f"写入 {path}")
            continue
        actual = open(path, encoding="utf8").read() if os.path.exists(path) else ""
        if actual == expected:
            print(f"✓ {path} 无漂移")
        else:
            drift += 1
            print(f"✗ {path} 与表不一致（运行 make contracts-gen 重新生成）", file=sys.stderr)
    return 1 if drift else 0


if __name__ == "__main__":
    sys.exit(main(sys.argv[1:]))
