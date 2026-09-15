import type { ToolDefinition } from "./registry.js";

// 有状态工具：数据存在 ctx.sessionState.todos，所以窗口 1 的清单窗口 2 看不到。
// 用来验证「带着工具的追问」（"把第 2 条标完成"）。

interface TodoItem {
  text: string;
  done: boolean;
}

function items(state: Record<string, unknown>): TodoItem[] {
  if (!Array.isArray(state.todos)) state.todos = [];
  return state.todos as TodoItem[];
}

function render(list: TodoItem[]): string {
  if (list.length === 0) return "待办清单为空。";
  return list.map((t, i) => `${i + 1}. [${t.done ? "x" : " "}] ${t.text}`).join("\n");
}

export function createTodoTool(): ToolDefinition {
  return {
    name: "todo",
    description: "管理当前会话的待办清单：add 新增、list 列出、done 标记完成、remove 删除。清单只在本会话内有效。",
    parameters: {
      type: "object",
      properties: {
        action: { type: "string", description: "操作", enum: ["add", "list", "done", "remove"] },
        item: { type: "string", description: "add 时的待办内容" },
        index: { type: "number", description: "done / remove 时的序号，从 1 开始" },
      },
      required: ["action"],
    },
    handler: async ({ action, item, index }, ctx) => {
      const list = items(ctx.sessionState);
      switch (action) {
        case "add":
          if (!item) throw new Error("add 需要 item");
          list.push({ text: item, done: false });
          return `已添加：${item}\n${render(list)}`;
        case "list":
          return render(list);
        case "done":
        case "remove": {
          const i = Number(index) - 1;
          if (!(i >= 0 && i < list.length)) throw new Error(`序号 ${index} 不存在，当前共 ${list.length} 条`);
          if (action === "done") list[i].done = true;
          else list.splice(i, 1);
          return render(list);
        }
        default:
          throw new Error(`未知 action：${action}`);
      }
    },
  };
}
