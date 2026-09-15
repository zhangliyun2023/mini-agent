import { describe, it, expect } from "vitest";
import { ToolRegistry } from "../../src/tools/registry.js";
import { calculatorTool } from "../../src/tools/calculator.js";
import { searchTool } from "../../src/tools/search.js";
import { createTodoTool } from "../../src/tools/todo.js";

describe("工具注册与调用", () => {
  it("注册后能按名字拿到 名称/描述/参数 Schema，供拼进 system prompt", () => {
    const reg = new ToolRegistry();
    reg.register(calculatorTool);
    const specs = reg.specs();
    expect(specs).toEqual([
      expect.objectContaining({
        name: "calculator",
        description: expect.any(String),
        parameters: expect.objectContaining({ type: "object", required: ["expression"] }),
      }),
    ]);
  });

  it("调用未注册的工具，返回带 error 的结果而不是抛异常", async () => {
    const reg = new ToolRegistry();
    const r = await reg.invoke("nope", {}, {});
    expect(r.ok).toBe(false);
    expect(r.content).toMatch(/未注册/);
  });

  it("参数不满足 Schema（缺必填 / 类型错）时拒绝执行并说明哪一项错", async () => {
    const reg = new ToolRegistry();
    reg.register(calculatorTool);
    const r1 = await reg.invoke("calculator", {}, {});
    expect(r1.ok).toBe(false);
    expect(r1.content).toMatch(/expression/);
    const r2 = await reg.invoke("calculator", { expression: 123 }, {});
    expect(r2.ok).toBe(false);
    expect(r2.content).toMatch(/string/);
  });

  it("工具 handler 抛异常时被捕获成 error 结果", async () => {
    const reg = new ToolRegistry();
    reg.register({
      name: "boom",
      description: "always throws",
      parameters: { type: "object", properties: {} },
      handler: async () => {
        throw new Error("炸了");
      },
    });
    const r = await reg.invoke("boom", {}, {});
    expect(r.ok).toBe(false);
    expect(r.content).toMatch(/炸了/);
  });
});

describe("calculator", () => {
  it("算四则与括号", async () => {
    const r = await calculatorTool.handler({ expression: "(2+3)*4/8" }, {} as any);
    expect(r).toBe("2.5");
  });
  it("拒绝非算式（不会 eval 任意代码）", async () => {
    await expect(calculatorTool.handler({ expression: "process.exit()" }, {} as any)).rejects.toThrow();
  });
});

describe("search（mock）", () => {
  it("按关键词返回命中的条目，最多 3 条", async () => {
    const r = await searchTool.handler({ query: "上海 天气" }, {} as any);
    expect(r).toMatch(/上海/);
    expect(r.split("\n").filter((l) => l.startsWith("- ")).length).toBeLessThanOrEqual(3);
  });
  it("没命中时明确说没找到", async () => {
    const r = await searchTool.handler({ query: "zzzz不存在" }, {} as any);
    expect(r).toMatch(/没有找到/);
  });
});

describe("todo（有状态，挂在 session 上）", () => {
  it("add / list / done 在同一 session 内连贯", async () => {
    const state: Record<string, unknown> = {};
    const ctx = { sessionState: state } as any;
    const todo = createTodoTool();
    await todo.handler({ action: "add", item: "买牛奶" }, ctx);
    await todo.handler({ action: "add", item: "写周报" }, ctx);
    await todo.handler({ action: "done", index: 1 }, ctx);
    const list = await todo.handler({ action: "list" }, ctx);
    expect(list).toMatch(/\[x\] 买牛奶/);
    expect(list).toMatch(/\[ \] 写周报/);
  });
  it("不同 session 的 todo 互不可见", async () => {
    const todo = createTodoTool();
    const a = { sessionState: {} } as any;
    const b = { sessionState: {} } as any;
    await todo.handler({ action: "add", item: "只在A" }, a);
    expect(await todo.handler({ action: "list" }, b)).not.toMatch(/只在A/);
  });
});
