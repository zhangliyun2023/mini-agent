import { describe, it, expect } from "vitest";
import { APIConnectionError, APIConnectionTimeoutError, AuthenticationError, RateLimitError } from "openai";
import { classifyLlmError, isRetryable, type LlmErrorClass } from "../../src/llm/errors.js";

// #11：错误分类是纯函数——输入看 status / code / name / message，输出八类之一；
// 可重试 = rate_limited / server / timeout / network / unknown，不可重试 = auth / bad_request / not_found。
const err = (message: string, extra: Record<string, unknown> = {}) => Object.assign(new Error(message), extra);

describe("classifyLlmError：按错误类型分类（#11）", () => {
  it.each([ // ×19
    [err("Incorrect API key", { status: 401 }), "auth"],
    [err("forbidden", { status: 403 }), "auth"],
    [err("bad request", { status: 400 }), "bad_request"],
    [err("unprocessable", { status: 422 }), "bad_request"],
    [err("model not found", { status: 404 }), "not_found"],
    [err("rate limited", { status: 429 }), "rate_limited"],
    [err("upstream down", { status: 502 }), "server"],
    [err("internal", { status: 500 }), "server"],
    [err("socket timed out", { code: "ETIMEDOUT" }), "timeout"],
    [err("Request timed out.", { name: "APIConnectionTimeoutError" }), "timeout"],
    [err("Connection error.", { code: "ECONNRESET" }), "network"],
    [err("fetch failed", { name: "APIConnectionError" }), "network"],
    [err("fetch failed", { cause: { code: "ECONNREFUSED" } }), "network"],
    [err("something odd"), "unknown"],
    ["not even an Error", "unknown"],
    // 真实 SDK 抛出的形状（openai 不设 name，只有 status / code / message）
    [new AuthenticationError(401, { message: "Incorrect API key" }, "Incorrect API key", new Headers()), "auth"],
    [new RateLimitError(429, undefined, "Rate limit reached", new Headers()), "rate_limited"],
    [new APIConnectionTimeoutError(), "timeout"],
    [new APIConnectionError({}), "network"],
  ])("%s → %s", (e, cls) => {
    expect(classifyLlmError(e)).toBe(cls);
  });

  it("status 优先于 code：带 status 的错误不被 code 覆盖", () => {
    expect(classifyLlmError(err("x", { status: 401, code: "ETIMEDOUT" }))).toBe("auth");
  });

  it("只有认证 / 请求格式 / 不存在三类不重试", () => {
    expect((["auth", "bad_request", "not_found"] as LlmErrorClass[]).map(isRetryable)).toEqual([false, false, false]);
    expect((["rate_limited", "server", "timeout", "network", "unknown"] as LlmErrorClass[]).map(isRetryable)).toEqual([true, true, true, true, true]);
  });
});
