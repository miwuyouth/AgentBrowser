import assert from "node:assert/strict";
import { listModels, testModel } from "./model-probe.ts";

/**
 * 模型列表获取与可用性测试的单元测试套件（使用假 fetch，不发真实网络请求）。
 */

let passed = 0;
/**
 * 简易异步单元测试断言运行包装器。
 * 【调用时机】执行每个独立用例时调用。
 * 【作用】等待测试逻辑完成，递增通过计数并输出成功勾选日志。
 */
const test = async (name: string, fn: () => Promise<void>) => {
  await fn();
  passed++;
  console.log(`  ✓ ${name}`);
};

/** 构造返回固定 JSON 的假 fetch，并记录每次请求 */
const fake = (replies: Array<{ status?: number; body: unknown }>) => {
  const calls: Array<{ url: string; init: RequestInit }> = [];
  const impl = (async (url: string, init: RequestInit) => {
    calls.push({ url, init });
    const r = replies[Math.min(calls.length - 1, replies.length - 1)]!;
    return new Response(typeof r.body === "string" ? r.body : JSON.stringify(r.body), { status: r.status ?? 200 });
  }) as unknown as typeof fetch;
  return { impl, calls };
};

console.log("model-probe");

await test("OpenAI 兼容：请求 /models 并按名称排序", async () => {
  const f = fake([{ body: { data: [{ id: "b-model" }, { id: "a-model" }] } }]);
  const r = await listModels({ kind: "openai-compatible", baseURL: "http://127.0.0.1:8045/v1/", apiKey: "k" }, f.impl);
  assert.equal(f.calls[0]!.url, "http://127.0.0.1:8045/v1/models");
  assert.equal((f.calls[0]!.init.headers as Record<string, string>).authorization, "Bearer k");
  assert.deepEqual(r.models, ["a-model", "b-model"]);
  assert.equal(r.ok, true);
});

await test("Anthropic：留空地址走官方并带 x-api-key", async () => {
  const f = fake([{ body: { data: [{ id: "claude-x" }] } }]);
  const r = await listModels({ kind: "anthropic", baseURL: "", apiKey: "sk" }, f.impl);
  assert.ok(f.calls[0]!.url.startsWith("https://api.anthropic.com/v1/models"));
  assert.equal((f.calls[0]!.init.headers as Record<string, string>)["x-api-key"], "sk");
  assert.deepEqual(r.models, ["claude-x"]);
});

await test("列表为空或接口不支持时给出可手动输入的提示", async () => {
  const r = await listModels({ kind: "openai-compatible", baseURL: "http://x/v1" }, fake([{ body: { data: [] } }]).impl);
  assert.equal(r.ok, false);
  assert.match(r.message, /手动输入/);
});

await test("401 提示密钥问题并带上服务端原因", async () => {
  const r = await listModels(
    { kind: "openai-compatible", baseURL: "http://x/v1" },
    fake([{ status: 401, body: { error: { message: "bad key" } } }]).impl,
  );
  assert.equal(r.ok, false);
  assert.match(r.message, /密钥无效.*bad key/);
});

await test("网络异常转成人话", async () => {
  const impl = (async () => {
    throw Object.assign(new TypeError("fetch failed"), { cause: { code: "ECONNREFUSED" } });
  }) as unknown as typeof fetch;
  const r = await testModel({ kind: "openai-compatible", baseURL: "http://127.0.0.1:1/v1" }, "m", impl);
  assert.equal(r.ok, false);
  assert.match(r.message, /连接被拒绝/);
});

const RED_REPLY = { choices: [{ message: { content: "Red" } }] };

await test("测试成功：OpenAI 发 chat/completions，带模型名和图片", async () => {
  const f = fake([{ body: RED_REPLY }]);
  const r = await testModel({ kind: "openai-compatible", baseURL: "http://x/v1" }, "gemini", f.impl);
  assert.equal(f.calls[0]!.url, "http://x/v1/chat/completions");
  const sent = JSON.parse(f.calls[0]!.init.body as string);
  assert.equal(sent.model, "gemini");
  assert.equal(sent.messages[0].content[0].type, "image_url");
  assert.equal(r.ok, true);
});

await test("视觉检测：模型答不出颜色（忽略了图片）判为不支持", async () => {
  const f = fake([{ body: { choices: [{ message: { content: "I don't see any image." } }] } }]);
  const r = await testModel({ kind: "openai-compatible", baseURL: "http://x/v1" }, "text-only", f.impl);
  assert.equal(r.ok, false);
  assert.match(r.message, /不支持识别图片/);
});

await test("视觉检测：接口因图片报 400 判为不支持", async () => {
  const f = fake([{ status: 400, body: { error: { message: "image input is not supported" } } }]);
  const r = await testModel({ kind: "openai-compatible", baseURL: "http://x/v1" }, "text-only", f.impl);
  assert.equal(r.ok, false);
  assert.match(r.message, /不支持识别图片/);
});

await test("max_tokens 被拒绝时改用 max_completion_tokens 重试", async () => {
  const f = fake([
    { status: 400, body: { error: { message: "Use 'max_completion_tokens' instead" } } },
    { body: RED_REPLY },
  ]);
  const r = await testModel({ kind: "openai-compatible", baseURL: "http://x/v1" }, "gpt-5", f.impl);
  assert.equal(f.calls.length, 2);
  assert.ok("max_completion_tokens" in JSON.parse(f.calls[1]!.init.body as string));
  assert.equal(r.ok, true);
});

await test("Anthropic 测试走 /v1/messages", async () => {
  const f = fake([{ body: { content: [{ type: "text", text: "red" }] } }]);
  const r = await testModel({ kind: "anthropic", baseURL: "https://gw.example.com", apiKey: "k" }, "claude-x", f.impl);
  assert.equal(f.calls[0]!.url, "https://gw.example.com/v1/messages");
  assert.equal(JSON.parse(f.calls[0]!.init.body as string).messages[0].content[0].type, "image");
  assert.equal(r.ok, true);
});

console.log(`\n${passed} passed`);
