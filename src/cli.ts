import { createInterface } from "node:readline/promises";
import { stdin, stdout, stderr } from "node:process";
import { llmConfig } from "./config.js";
import { OpenAICompatibleLLM } from "./llm/openai-compatible.js";
import { createAgent, defaultTools } from "./runtime/agent.js";
import { FileSessionStore } from "./session/store.js";
import { FileUserMemoryStore } from "./memory/user-memory.js";
import { FileTraceSink } from "./runtime/trace.js";

// 用法：npm run chat -- --user A --session w1 [--native-tools] [--quiet]
// 多开终端、不同 --session 就是「同一用户的两个窗口」；同一 --session 再次进入即接着聊。
const args = Object.fromEntries(
  process.argv.slice(2).map((a, i, arr) => (a.startsWith("--") ? [a.slice(2), arr[i + 1]?.startsWith("--") || arr[i + 1] === undefined ? "true" : arr[i + 1]] : [])).filter((x) => x.length),
) as Record<string, string>;
const userId = args.user ?? "A";
const sessionId = args.session ?? "w1";

const cfg = llmConfig();
const memory = new FileUserMemoryStore("data/memory");
const tools = defaultTools(memory);
const llm = new OpenAICompatibleLLM({ ...cfg, nativeTools: args["native-tools"] ? tools.specs() : undefined });
const agent = createAgent({
  llm,
  tools,
  memory,
  sessions: new FileSessionStore("data/sessions"),
  trace: new FileTraceSink("trace", !args.quiet),
});

stderr.write(`mini-agent · model=${cfg.model} · user=${userId} · session=${sessionId} · ${args["native-tools"] ? "native function calling" : "文本协议"}\n输入 /exit 退出，/sessions 列出本用户的会话\n`);
const rl = createInterface({ input: stdin, output: stdout, terminal: stdin.isTTY });
const prompt = () => stdin.isTTY && stdout.write("你> ");
prompt();
// 用 for-await 逐行读，交互和管道输入都能跑完（rl.question 在管道下会丢行）
for await (const raw of rl) {
  const line = raw.trim();
  if (!line) {
    prompt();
    continue;
  }
  if (line === "/exit") break;
  if (line === "/sessions") {
    stdout.write(agent.sessions.list(userId).join("\n") + "\n");
    prompt();
    continue;
  }
  if (!stdin.isTTY) stdout.write(`你> ${line}\n`);
  const r = await agent.run({ userId, sessionId, input: line });
  stdout.write(`助手> ${r.answer}\n`);
  if (r.stoppedBy !== "final") stderr.write(`  (结束原因：${r.stoppedBy})\n`);
  prompt();
}
rl.close();
