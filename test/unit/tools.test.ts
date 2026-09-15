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

  it("未知参数被拒绝，并列出允许的参数名", async () => {
    const reg = new ToolRegistry().register(createTodoTool());
    const r = await reg.invoke("todo", { action: "list", foo: 1 }, {});
    expect(r.ok).toBe(false);
    expect(r.content).toMatch(/未知参数 "foo"/);
    expect(r.content).toMatch(/action, item, index/);
  });

  it("枚举外的取值被拒绝，并列出可选值", async () => {
    const reg = new ToolRegistry().register(createTodoTool());
    const r = await reg.invoke("todo", { action: "fly" }, {});
    expect(r.ok).toBe(false);
    expect(r.content).toMatch(/只能是 add \/ list \/ done \/ remove/);
  });

  it("工具没定义 compact 时，超长结果按默认长度截断并注明原长", async () => {
    const reg = new ToolRegistry().register({
      name: "long",
      description: "returns a long string",
      parameters: { type: "object", properties: {} },
      handler: async () => "x".repeat(5000),
    });
    const r = await reg.invoke("long", {}, {});
    expect(r.ok).toBe(true);
    expect(r.content.length).toBeLessThan(1600);
    expect(r.content).toMatch(/已截断，原文 5000 字符/);
  });

  it("工具定义了自己的 compact 时走它而不是默认截断（search 原样返回）", async () => {
    const reg = new ToolRegistry().register(searchTool);
    const r = await reg.invoke("search", { query: "上海" }, {});
    expect(r.ok).toBe(true);
    expect(r.content).not.toMatch(/已截断/);
  });

  it("重名注册直接抛错", () => {
    expect(() => new ToolRegistry().register(calculatorTool).register(calculatorTool)).toThrow(/重名/);
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

// 四个工具的可见行为都走 registry.invoke——和 runtime 同一条路（校验 → 执行 → 精简），不绕过注册表直调 handler
const reg = () => new ToolRegistry().register(calculatorTool).register(searchTool).register(createTodoTool());

describe("calculator", () => {
  it("算四则与括号", async () => {
    const r = await reg().invoke("calculator", { expression: "(2+3)*4/8" }, {});
    expect(r).toMatchObject({ ok: true, content: "2.5" });
  });
  it("拒绝非算式（不会 eval 任意代码），以 error 结果返回", async () => {
    const r = await reg().invoke("calculator", { expression: "process.exit()" }, {});
    expect(r.ok).toBe(false);
    expect(r.content).toMatch(/只支持数字/);
  });
});

describe("search（mock）", () => {
  it("按关键词返回命中的条目，最多 3 条", async () => {
    const r = await reg().invoke("search", { query: "上海 天气" }, {});
    expect(r.ok).toBe(true);
    expect(r.content).toMatch(/上海/);
    expect(r.content.split("\n").filter((l) => l.startsWith("- ")).length).toBeLessThanOrEqual(3);
  });
  it("没命中时明确说没找到", async () => {
    const r = await reg().invoke("search", { query: "zzzz不存在" }, {});
    expect(r.content).toMatch(/没有找到/);
  });
  // 2026-09-15 live 暴露（#3）：模型搜「上海今天天气」（无空格），语料是「上海今日天气」，整串子串匹配命中不了
  it("中文查询不带空格、措辞略有出入（今天 vs 今日）时仍能命中，且天气条目排在前面", async () => {
    const r = await reg().invoke("search", { query: "上海今天天气" }, {});
    expect(r.ok).toBe(true);
    expect(r.content).not.toMatch(/没有找到/);
    expect(r.content.split("\n")[0]).toMatch(/上海今日天气/);
    expect(r.content).toMatch(/多云|晴/);
  });
  it("查询里只有停用词或与语料毫无交集时，仍然说没找到，不乱给结果", async () => {
    const r = await reg().invoke("search", { query: "今天的" }, {});
    expect(r.content).toMatch(/没有找到/);
  });
});

describe("todo（有状态，挂在 session 上）", () => {
  it("add / list / done 在同一 session 内连贯", async () => {
    const ctx = { sessionState: {} as Record<string, unknown>, userId: "u", sessionId: "s" };
    const t = reg();
    await t.invoke("todo", { action: "add", item: "买牛奶" }, ctx);
    await t.invoke("todo", { action: "add", item: "写周报" }, ctx);
    await t.invoke("todo", { action: "done", index: 1 }, ctx);
    const list = await t.invoke("todo", { action: "list" }, ctx);
    expect(list.content).toMatch(/\[x\] 买牛奶/);
    expect(list.content).toMatch(/\[ \] 写周报/);
  });
  it("序号不存在时以 error 结果说明当前条数", async () => {
    const ctx = { sessionState: {} as Record<string, unknown> };
    const r = await reg().invoke("todo", { action: "done", index: 3 }, ctx);
    expect(r.ok).toBe(false);
    expect(r.content).toMatch(/序号 3 不存在，当前共 0 条/);
  });
  it("不同 session 的 todo 互不可见", async () => {
    const t = reg();
    const a = { sessionState: {} as Record<string, unknown> };
    const b = { sessionState: {} as Record<string, unknown> };
    await t.invoke("todo", { action: "add", item: "只在A" }, a);
    expect((await t.invoke("todo", { action: "list" }, b)).content).not.toMatch(/只在A/);
  });
});
