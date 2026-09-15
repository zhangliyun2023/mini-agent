// 模型调用错误的分类（#11）：纯函数，runtime 用它决定「重不重试」，trace 用它给每次尝试打标签。
// 输入是任何抛出物：OpenAI SDK 的 APIError（status / code / name）、Node 网络错（code）、
// undici 的 fetch failed（cause.code），以及只有 message 的普通 Error。

export type LlmErrorClass = "auth" | "bad_request" | "not_found" | "rate_limited" | "server" | "timeout" | "network" | "unknown";

/** 认证 / 请求格式 / 不存在：重试也不会变，直接以可读错误结束本轮 */
const NON_RETRYABLE: ReadonlySet<LlmErrorClass> = new Set(["auth", "bad_request", "not_found"]);

export function isRetryable(cls: LlmErrorClass): boolean {
  return !NON_RETRYABLE.has(cls);
}

const NETWORK_CODES = new Set(["ECONNRESET", "ECONNREFUSED", "ENOTFOUND", "EAI_AGAIN", "EPIPE", "EHOSTUNREACH", "ENETUNREACH", "UND_ERR_SOCKET"]);
const TIMEOUT_CODES = new Set(["ETIMEDOUT", "UND_ERR_CONNECT_TIMEOUT", "UND_ERR_HEADERS_TIMEOUT", "UND_ERR_BODY_TIMEOUT"]);

interface ErrorShape {
  status?: unknown;
  code?: unknown;
  name?: unknown;
  message?: unknown;
  cause?: unknown;
}

export function classifyLlmError(e: unknown): LlmErrorClass {
  if (typeof e !== "object" || e === null) return "unknown";
  const err = e as ErrorShape;
  const status = typeof err.status === "number" ? err.status : undefined;
  if (status !== undefined) {
    if (status === 401 || status === 403) return "auth";
    if (status === 404) return "not_found";
    if (status === 429) return "rate_limited";
    if (status >= 500) return "server";
    if (status >= 400) return "bad_request";
  }
  const code = pickCode(err);
  if (code !== undefined) {
    if (TIMEOUT_CODES.has(code)) return "timeout";
    if (NETWORK_CODES.has(code)) return "network";
  }
  const name = typeof err.name === "string" ? err.name : "";
  if (/timeout/i.test(name) || name === "AbortError") return "timeout";
  if (/connection/i.test(name)) return "network";
  const message = typeof err.message === "string" ? err.message : "";
  if (/timed? ?out/i.test(message)) return "timeout";
  // openai SDK 不设 name：APIConnectionError 只有 message "Connection error."
  if (/connection error|fetch failed|socket hang up|network/i.test(message)) return "network";
  return "unknown";
}

function pickCode(err: ErrorShape): string | undefined {
  if (typeof err.code === "string") return err.code;
  const cause = err.cause as ErrorShape | undefined;
  if (cause && typeof cause === "object" && typeof cause.code === "string") return cause.code;
  return undefined;
}

/** 给用户看的一行：类别 + 状态码/错误码 + 原始 message，例：`auth 401: Incorrect API key` */
export function describeLlmError(e: unknown, cls: LlmErrorClass = classifyLlmError(e)): string {
  const err = (typeof e === "object" && e !== null ? e : {}) as ErrorShape;
  const tag = [cls, typeof err.status === "number" ? String(err.status) : undefined, pickCode(err)].filter(Boolean).join(" ");
  const message = typeof err.message === "string" && err.message ? err.message : String(e);
  return `${tag}: ${message}`;
}
