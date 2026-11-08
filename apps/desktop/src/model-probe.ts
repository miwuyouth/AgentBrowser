import { deflateSync } from "node:zlib";
import type { ModelListResult, ModelTestResult, ProviderKind } from "./shared.ts";

/** 获取模型列表的超时时间（毫秒） */
const TIMEOUT_MS = 15_000;
/** 视觉检测请求的超时时间（毫秒），带图片的请求更慢 */
const TEST_TIMEOUT_MS = 30_000;

/** 视觉检测用的 32×32 纯红色 PNG（base64） */
const RED_PNG = (() => {
  const w = 32;
  const crc = (buf: Buffer) => {
    let c = ~0;
    for (const b of buf) {
      c ^= b;
      for (let k = 0; k < 8; k++) c = (c >>> 1) ^ (0xedb88320 & -(c & 1));
    }
    return ~c >>> 0;
  };
  const chunk = (type: string, data: Buffer) => {
    const body = Buffer.concat([Buffer.from(type), data]);
    const len = Buffer.alloc(4);
    len.writeUInt32BE(data.length);
    const sum = Buffer.alloc(4);
    sum.writeUInt32BE(crc(body));
    return Buffer.concat([len, body, sum]);
  };
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(w, 0);
  ihdr.writeUInt32BE(w, 4);
  ihdr[8] = 8;
  ihdr[9] = 2;
  const row = Buffer.concat([Buffer.from([0]), Buffer.from(Array.from({ length: w }, () => [255, 0, 0]).flat())]);
  const raw = Buffer.concat(Array.from({ length: w }, () => row));
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk("IHDR", ihdr),
    chunk("IDAT", deflateSync(raw)),
    chunk("IEND", Buffer.alloc(0)),
  ]).toString("base64");
})();

/** 视觉检测的提问：答案应含"红"/red */
const VISION_PROMPT = "What is the single dominant color of this image? Answer with one English word.";

/** 探测所需的连接参数（密钥已在主进程解析为明文） */
export interface ProbeTarget {
  kind: ProviderKind;
  /** 接口地址；为空时 Anthropic 走官方地址 */
  baseURL: string;
  apiKey?: string;
}

type FetchLike = typeof fetch;

/** 拼接接口地址，去掉 baseURL 末尾多余的斜杠 */
const join = (base: string, tail: string) => `${base.replace(/\/+$/, "")}${tail}`;

/**
 * 构造请求头。
 * Anthropic 同时带 x-api-key 与 Bearer，兼容官方接口和只认 Bearer 的网关。
 */
function headers(t: ProbeTarget): Record<string, string> {
  const h: Record<string, string> = { "content-type": "application/json" };
  if (t.kind === "anthropic") {
    h["anthropic-version"] = "2023-06-01";
    if (t.apiKey) {
      h["x-api-key"] = t.apiKey;
      h.authorization = `Bearer ${t.apiKey}`;
    }
  } else if (t.apiKey) {
    h.authorization = `Bearer ${t.apiKey}`;
  }
  return h;
}

/** 解析出服务端返回的错误文案（兼容 OpenAI / Anthropic 两种 error 结构） */
async function failure(res: Response): Promise<string> {
  const text = await res.text().catch(() => "");
  let detail = "";
  try {
    const j = JSON.parse(text);
    detail = j?.error?.message ?? j?.message ?? (typeof j?.error === "string" ? j.error : "");
  } catch {
    detail = text.trim().slice(0, 160);
  }
  const base = res.status === 401 || res.status === 403 ? "密钥无效或无权限" : `请求失败（HTTP ${res.status}）`;
  return detail ? `${base}：${detail}` : base;
}

/** 把 fetch 抛出的网络错误转成人话 */
function networkMessage(err: unknown): string {
  if (err instanceof Error && (err.name === "TimeoutError" || err.name === "AbortError")) return "连接超时，请检查接口地址";
  const cause = err instanceof Error ? (err.cause as { code?: string } | undefined) : undefined;
  if (cause?.code === "ECONNREFUSED") return "连接被拒绝，服务可能没有启动";
  if (cause?.code === "ENOTFOUND") return "找不到该地址，请检查接口地址";
  return `无法连接：${err instanceof Error ? err.message : String(err)}`;
}

/**
 * 拉取接口支持的模型列表。
 *
 * 【调用时机】用户在设置弹窗点击"获取列表"时，由主进程 IPC 调用。
 * 【作用】GET `<baseURL>/models`（Anthropic 为 `<baseURL>/v1/models`），按 id 排序后返回。
 */
export async function listModels(t: ProbeTarget, fetchImpl: FetchLike = fetch): Promise<ModelListResult> {
  const url = t.kind === "anthropic" ? join(t.baseURL || "https://api.anthropic.com", "/v1/models?limit=1000") : join(t.baseURL, "/models");
  try {
    const res = await fetchImpl(url, { headers: headers(t), signal: AbortSignal.timeout(TIMEOUT_MS) });
    if (!res.ok) return { ok: false, models: [], message: await failure(res) };
    const body: any = await res.json().catch(() => null);
    const items: unknown[] = Array.isArray(body?.data) ? body.data : Array.isArray(body?.models) ? body.models : [];
    const models = items
      .map((m: any) => (typeof m === "string" ? m : m?.id ?? m?.name))
      .filter((id): id is string => typeof id === "string" && id !== "")
      .sort((a, b) => a.localeCompare(b));
    if (models.length === 0) return { ok: false, models: [], message: "接口没有返回模型列表，请手动输入模型名" };
    return { ok: true, models, message: `获取到 ${models.length} 个模型` };
  } catch (err) {
    return { ok: false, models: [], message: networkMessage(err) };
  }
}

/** 从两种接口的响应体里取出模型回复的文本 */
function replyText(body: any): string {
  const c = body?.choices?.[0]?.message?.content;
  if (typeof c === "string") return c;
  if (Array.isArray(c)) return c.map((x: any) => x?.text ?? "").join("");
  if (Array.isArray(body?.content)) return body.content.map((x: any) => x?.text ?? "").join("");
  return "";
}

/**
 * 验证"地址 + 密钥 + 模型"是否可用，并强制要求模型能看懂图片。
 *
 * 【调用时机】用户在设置弹窗点击"测试"，或点击"保存"前自动调用，由主进程 IPC 触发。
 * 【作用】发送一张纯红色图片并询问颜色：
 * - 接口报错：返回错误原因（图片相关的报错会提示模型不支持图片）；
 * - 接口成功但回答里没有红色：说明模型看不到图片，判定为不支持视觉；
 * - 答对：通过。
 * 部分新模型不接受 max_tokens，会自动改用 max_completion_tokens 重试一次。
 */
export async function testModel(t: ProbeTarget, model: string, fetchImpl: FetchLike = fetch): Promise<ModelTestResult> {
  const started = Date.now();
  const send = (body: object, url: string) =>
    fetchImpl(url, { method: "POST", headers: headers(t), body: JSON.stringify(body), signal: AbortSignal.timeout(TEST_TIMEOUT_MS) });
  const noVision = "该模型不支持识别图片，无法使用。请换一个支持视觉的模型。";
  try {
    let res: Response;
    if (t.kind === "anthropic") {
      res = await send(
        {
          model,
          max_tokens: 64,
          messages: [
            {
              role: "user",
              content: [
                { type: "image", source: { type: "base64", media_type: "image/png", data: RED_PNG } },
                { type: "text", text: VISION_PROMPT },
              ],
            },
          ],
        },
        join(t.baseURL || "https://api.anthropic.com", "/v1/messages"),
      );
    } else {
      const url = join(t.baseURL, "/chat/completions");
      const messages = [
        {
          role: "user",
          content: [
            { type: "image_url", image_url: { url: `data:image/png;base64,${RED_PNG}` } },
            { type: "text", text: VISION_PROMPT },
          ],
        },
      ];
      res = await send({ model, messages, max_tokens: 256 }, url);
      if (res.status === 400) {
        const text = await res.clone().text().catch(() => "");
        if (text.includes("max_completion_tokens")) res = await send({ model, messages, max_completion_tokens: 512 }, url);
      }
    }
    if (!res.ok) {
      const text = await res.clone().text().catch(() => "");
      if (res.status === 400 && /image|vision|multimodal|modalit/i.test(text)) return { ok: false, message: noVision };
      return { ok: false, message: await failure(res) };
    }
    const answer = replyText(await res.json().catch(() => null));
    if (!/red|红/i.test(answer)) return { ok: false, message: noVision };
    return { ok: true, message: `可用，支持图片识别（${Date.now() - started} ms）` };
  } catch (err) {
    return { ok: false, message: networkMessage(err) };
  }
}
