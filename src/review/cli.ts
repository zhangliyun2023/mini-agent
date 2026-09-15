import { appendFileSync, mkdirSync, mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { stderr, stdout } from "node:process";
import { llmConfig } from "../config.js";
import { FakeLLM } from "../llm/fake.js";
import { OpenAICompatibleLLM } from "../llm/openai-compatible.js";
import type { ChatMessage, LLMClient } from "../llm/types.js";
import { FileUserMemoryStore } from "../memory/user-memory.js";
import { FileSessionStore } from "../session/store.js";
import { consolidate } from "./consolidate.js";
import { FileReviewJournalStore } from "./journal.js";
import { runReview } from "./run.js";
import { FileTranscriptStore } from "./transcript.js";
import type { ReviewJournal } from "./types.js";
import { yesterdayWindow } from "./window.js";

// #19 R8：复盘 CLI（⑨ 触发 = CLI 子命令，外部 cron 调它；⑩ 交付 = journal 落盘 + 打印 brief + 可选 --deliver）。
//   npm run review -- --user A [--date 2026-09-15] [--tz Asia/Shanghai] [--deliver <sessionId>] [--fake ok|no_chat|partial_read] [--data <dir>] [--json]
//   - --date 缺省 = 任务时区的今天（Intl 算）；--tz 缺省 Asia/Shanghai
//   - 存储全是文件版：<data>/transcripts、<data>/memory、<data>/sessions、<data>/reviews；--data 缺省 data/（--fake 时缺省一个临时目录）
//   - 真实模型：llmConfig() + OpenAICompatibleLLM；--fake 不调模型，用脚本化 FakeLLM + 播种夹具跑出三态，无 key 也能跑
//   - 退出码：ok / no_chat → 0；partial_read → 3（区分于失败）；配置错误 → 1；运行时异常 → 2
//   - ⑪ 接收人只由 --deliver 决定：没给就谁也不追加；给了只追加到那一个会话（runReview 已守，这里不再多传任何接收人）

export const FAKE_SCENARIOS = ["ok", "no_chat", "partial_read"] as const;
export type FakeScenario = (typeof FAKE_SCENARIOS)[number];

export interface ReviewCliArgs {
  user: string;
  date: string;
  tz: string;
  deliver?: string;
  fake?: FakeScenario;
  data?: string;
  json: boolean;
}

/** 配置错误（参数 / key / 日期 / 时区）：退出码 1 */
export class ConfigError extends Error {}

const VALUE_FLAGS = new Set(["user", "date", "tz", "deliver", "fake", "data"]);
const BOOL_FLAGS = new Set(["json"]);

/** 任务时区的今天 YYYY-MM-DD（只用 Intl，与 window.ts 同口径） */
export function todayIn(tz: string, now = new Date()): string {
  try {
    return new Intl.DateTimeFormat("en-CA", { timeZone: tz, year: "numeric", month: "2-digit", day: "2-digit" }).format(now);
  } catch (e) {
    throw new ConfigError(`--tz 不是合法时区：${tz}（${(e as Error).message}）`);
  }
}

export function parseArgs(argv: string[], now = new Date()): ReviewCliArgs {
  const raw: Record<string, string> = {};
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (!a.startsWith("--")) throw new ConfigError(`不认识的参数：${a}`);
    const name = a.slice(2);
    if (BOOL_FLAGS.has(name)) {
      raw[name] = "true";
      continue;
    }
    if (!VALUE_FLAGS.has(name)) throw new ConfigError(`不认识的参数：${a}`);
    const v = argv[i + 1];
    if (v === undefined || v.startsWith("--")) throw new ConfigError(`${a} 需要一个值`);
    raw[name] = v;
    i++;
  }
  const tz = raw.tz ?? "Asia/Shanghai";
  const date = raw.date ?? todayIn(tz, now);
  if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) throw new ConfigError(`--date 必须是 YYYY-MM-DD：${date}`);
  if (raw.fake !== undefined && !(FAKE_SCENARIOS as readonly string[]).includes(raw.fake)) throw new ConfigError(`--fake 只能是 ${FAKE_SCENARIOS.join(" | ")}，收到：${raw.fake}`);
  return { user: raw.user ?? "A", date, tz, deliver: raw.deliver, fake: raw.fake as FakeScenario | undefined, data: raw.data, json: raw.json === "true" };
}

/**
 * --fake 的脚本化模型：不看内容，只从整合器发来的转写里取第一个会话与第一个 user 轮号，回一段固定形状的 JSON。
 * 这样 source 一定指向真实存在的轮（否则 R4 会丢弃），也能对任意 --data 目录里的真实转写跑通。
 */
export function fakeConsolidatorLLM(): LLMClient {
  return new FakeLLM([
    (messages: ChatMessage[]) => {
      const user = messages.find((m) => m.role === "user")?.content ?? "";
      const sessionId = /^## 会话 (.+)$/m.exec(user)?.[1] ?? "unknown";
      const turn = Number(/^\[第 (\d+) 轮 user\]/m.exec(user)?.[1] ?? "1");
      const source = { sessionId, turn };
      return JSON.stringify({
        entries: [{ key: "fake_note", value: "（假模型）昨天聊过一件要办的事", kind: "inferred", confidence: 0.6, source }],
        highlights: [{ text: "（假模型）把昨天说的那件事办完", why_today: "due_today", source }],
      });
    },
  ]);
}

/** --fake 播种：ok → 昨天一段可读转写；no_chat → 什么都不种；partial_read → 可读转写 + 一个只有坏 JSON 行的转写 */
export function seedFakeScenario(scenario: FakeScenario, dataDir: string, user: string, date: string, tz: string): void {
  if (scenario === "no_chat") return;
  const dir = join(dataDir, "transcripts", encodeURIComponent(user));
  mkdirSync(dir, { recursive: true });
  const ts = new Date(yesterdayWindow(date, tz).start.getTime() + 10 * 3600_000).toISOString();
  const lines = [
    { ts, userId: user, sessionId: "fake-ok", turn: 1, traceId: `${user}/fake-ok/1`, role: "user", content: "明天下午 3 点要交周报，记得提醒我" },
    { ts, userId: user, sessionId: "fake-ok", turn: 1, traceId: `${user}/fake-ok/1`, role: "assistant", content: "<final>记下了</final>" },
  ];
  appendFileSync(join(dir, "fake-ok.jsonl"), lines.map((l) => JSON.stringify(l)).join("\n") + "\n");
  if (scenario === "partial_read") appendFileSync(join(dir, "fake-bad.jsonl"), `{"ts": "${ts}", 坏掉的 JSON 行\n`);
}

export const EXIT_BY_STATUS: Record<ReviewJournal["status"], number> = { ok: 0, no_chat: 0, partial_read: 3 };

/** 人读格式：首行固定形状，然后 brief 全文（null 打「（今天没有需要提醒的事）」），然后 delivered_to */
export function formatHuman(j: ReviewJournal): string {
  const out = [
    `review ${j.userId} ${j.date} ${j.tz} → ${j.status}（attempts=${j.attempts}, coverage=${j.coverage}, entries_written=${j.entries_written}）`,
    j.brief ? j.brief.text : "（今天没有需要提醒的事）",
    `delivered_to: ${j.delivered_to.length ? j.delivered_to.join(", ") : "（无）"}`,
  ];
  if (j.unreadable?.length) out.push(`unreadable: ${j.unreadable.join(", ")}`);
  return out.join("\n") + "\n";
}

export async function main(argv: string[]): Promise<number> {
  const args = parseArgs(argv);
  try {
    yesterdayWindow(args.date, args.tz); // 日期 / 时区在这里就验，坏的 → ConfigError（不落 journal）
  } catch (e) {
    throw new ConfigError((e as Error).message);
  }
  const dataDir = args.data ?? (args.fake ? mkdtempSync(join(tmpdir(), "mini-agent-review-fake-")) : "data");

  let llm: LLMClient;
  if (args.fake) {
    seedFakeScenario(args.fake, dataDir, args.user, args.date, args.tz);
    llm = fakeConsolidatorLLM();
    stderr.write(`review · --fake ${args.fake} · 不调模型 · data=${dataDir}\n`);
  } else {
    let cfg: ReturnType<typeof llmConfig>;
    try {
      cfg = llmConfig();
    } catch (e) {
      throw new ConfigError((e as Error).message);
    }
    llm = new OpenAICompatibleLLM(cfg);
    stderr.write(`review · model=${cfg.model} · data=${dataDir}\n`);
  }

  const { journal } = await runReview(
    {
      transcripts: new FileTranscriptStore(join(dataDir, "transcripts")),
      memory: new FileUserMemoryStore(join(dataDir, "memory")),
      sessions: new FileSessionStore(join(dataDir, "sessions")),
      journal: new FileReviewJournalStore(join(dataDir, "reviews")),
      consolidate: (input) => consolidate(input, llm),
    },
    { userId: args.user, date: args.date, tz: args.tz, deliverTo: args.deliver },
  );

  stdout.write(args.json ? JSON.stringify(journal, null, 2) + "\n" : formatHuman(journal));
  for (const w of journal.warnings ?? []) stderr.write(`warning: ${w}\n`);
  return EXIT_BY_STATUS[journal.status];
}

// 作为脚本运行时（npm run review / node --import tsx src/review/cli.ts）才执行；被测试 import 时不跑
const entry = process.argv[1] ?? "";
if (/[\\/]src[\\/]review[\\/]cli\.ts$/.test(entry)) {
  main(process.argv.slice(2)).then(
    (code) => process.exit(code),
    (e: unknown) => {
      const err = e as Error;
      if (err instanceof ConfigError) {
        stderr.write(`配置错误：${err.message}\n`);
        process.exit(1);
      }
      stderr.write(`复盘失败：${err.stack ?? err.message ?? String(e)}\n`);
      process.exit(2);
    },
  );
}
