import { existsSync, readFileSync } from "node:fs";
import { resolve } from "node:path";

// 极简 .env 读取：不引 dotenv，评审 clone 下来 cp .env.example .env 就能跑
export function loadEnv(path = resolve(process.cwd(), ".env")): void {
  if (!existsSync(path)) return;
  for (const line of readFileSync(path, "utf8").split("\n")) {
    const m = /^\s*([A-Z0-9_]+)\s*=\s*(.*)\s*$/.exec(line);
    if (m && process.env[m[1]] === undefined) process.env[m[1]] = m[2].replace(/^["']|["']$/g, "");
  }
}

export function llmConfig() {
  loadEnv();
  const apiKey = process.env.OPENAI_API_KEY;
  if (!apiKey) throw new Error("缺少 OPENAI_API_KEY：复制 .env.example 为 .env 并填入 key");
  return {
    apiKey,
    baseURL: process.env.OPENAI_BASE_URL ?? "https://dashscope.aliyuncs.com/compatible-mode/v1",
    model: process.env.MODEL ?? "qwen3-max",
  };
}
