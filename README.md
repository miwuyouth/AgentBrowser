# Agent Browser

桌面 App（Electron）里运行 Agent 循环，通过一个自研的 Chrome 扩展操作浏览器。扩展只提供“手脚”（浏览器原语），推理、编排、`find` 与批量执行都在 App 里。

工具名和参数沿用 Claude in Chrome 扩展的约定（`computer`、`read_page`、`navigate`、`form_input`……），实现与描述文字全部重写。

## 架构

```
apps/desktop          Electron 壳：设置、对话界面、启动浏览器
packages/agent        Agent 循环、模型 Provider（Anthropic / OpenAI 兼容）、App 端工具（find、browser_batch、file_upload 读文件）
packages/bridge       本地 WebSocket 服务、浏览器查找与启动、会话封装
packages/extension    MV3 扩展：工具执行、CDP 输入与截图、页面大纲
packages/protocol     三方共用：消息类型、工具 schema、输入校验
```

```
Agent 循环 ──call()──> BrowserBridge ──ws://127.0.0.1──> 扩展 Service Worker ──CDP / 内容脚本──> 页面
   ▲                                                         │
   └──────────────── tool_result（文本 + 截图）◄──────────────┘
```

- **连接**：扩展主动连接 App（MV3 Service Worker 不能监听端口）。App 每次启动浏览器时把端口和随机 token 写进扩展目录里的 `bridge-config.json`；Bridge 只接受 `Origin` 为固定扩展 ID 且 token 正确的连接。扩展 ID 由 `packages/extension/extension-key.json` 里的公钥固定。
- **不使用 `--remote-debugging-port`**。输入和截图通过扩展的 `chrome.debugger` 完成，按需附加，空闲 5 分钟自动断开。
- **隔离**：Agent 只能操作自己的标签组（标题为 “Agent”）里的标签页。
- **坐标**：截图会缩放到一个“帧”（默认最长边 1920、总像素不超过 1920×1080），模型给出的坐标始终按最近一次全尺寸截图的帧来换算。

## 工具

| 工具 | 执行位置 | 说明 |
|---|---|---|
| `tabs_context_mcp` / `tabs_create_mcp` / `tabs_close_mcp` | 扩展 | 标签组管理 |
| `navigate` | 扩展 | 支持 back/forward；遇到 “Leave site?” 默认拒绝，`force: true` 时丢弃改动 |
| `computer` | 扩展 | 点击、悬停、拖拽、输入、按键、滚动、截图、局部放大、等待；可用 ref 或坐标 |
| `read_page` / `get_page_text` | 扩展 | 带 ref 的页面大纲 / 正文 |
| `form_input` / `javascript_tool` | 扩展 | 表单赋值 / 页面内执行 JS（支持顶层 await） |
| `read_console_messages` / `read_network_requests` | 扩展 | 首次调用时开始采集 |
| `upload_image` / `resize_window` / `gif_creator` | 扩展 | GIF 在 Service Worker 里用 gifenc 编码 |
| `file_upload` | App + 扩展 | 模型给本地路径，App 读文件后交给扩展 |
| `find` | App | 扩展返回候选元素，由 Provider 的小模型挑选匹配项（Anthropic 默认 `claude-haiku-5-5`） |
| `browser_batch` | App | 顺序执行多个工具，遇错即停；可以混用 App 端工具 |

## 模型 Provider

Agent 循环与厂商无关，厂商相关的部分都在 `packages/agent/src/providers/`：

| Provider | 用法 | 说明 |
|---|---|---|
| `AnthropicProvider` | 默认 | 官方 API，开启 context editing、fallback、自适应思考、流式工具参数等特性 |
| `AnthropicProvider` + `baseURL` | 自定义网关 / Anthropic 兼容服务 | 默认关闭上面那些新特性（可用 `features` 逐项打开），旧截图改为在客户端裁剪 |
| `OpenAIProvider` | OpenAI 及任何 Chat Completions 兼容服务 | 截图放在工具消息之后的一条用户消息里；只保留最近 `keepImages`（默认 3）张；`reasoning_content` 显示为思考过程 |

```ts
import { AgentSession, createProvider } from "@agent-browser/agent";

const provider = createProvider({
  kind: "openai-compatible",
  baseURL: "http://127.0.0.1:11434/v1", // 本地服务可以不填 apiKey
  model: "qwen3-vl",
  // findModel、maxTokens、maxTokensParam、vision、jsonMode、temperature、extraBody 可选
});
const agent = new AgentSession({ bridge, provider });
```

OpenAI 兼容接口的常用选项：
- `vision: false`：模型不支持图片时，截图会被替换成提示，让模型改用 `read_page` / `find`。
- `maxTokensParam`：默认发 `max_tokens`；OpenAI 新模型要求 `max_completion_tokens`。
- `jsonMode`：`find` 获取 JSON 的方式，默认 `json_object`（支持面最广），也可选 `json_schema` 或 `none`。
- `extraBody`：合并进每个请求的厂商特有字段（例如推理强度、思考开关）。

要接其他厂商，实现 `ModelProvider` 接口（`createConversation`、`completeJson`、`describeError`）即可，工具执行和浏览器部分不用改。

## 运行

需要 Node 22+、pnpm 10，以及一个 Chrome 系浏览器。桌面端 App 支持自动检测本机已安装的 Chromium 内核浏览器（如 Chrome for Testing、Chromium、Microsoft Edge、Brave、Google Chrome 等）。

```bash
pnpm install
pnpm build              # 构建扩展和桌面端
pnpm dev                # 启动桌面 App
pnpm cli "打开 example.com 并告诉我标题"   # 不用 Electron，直接在终端里跑
pnpm cli --provider openai --base-url http://127.0.0.1:11434/v1 --model qwen3-vl "任务"
```

### 桌面端 App 的任务、浏览器内核与 Profile 逻辑

- **每个任务绑定浏览器内核与对应 Profile**：每个检测到的 Chromium 内核拥有独立的对应 Profile 列表（默认自带 `默认 Profile`，也可在该内核下新建多个专属隔离 Profile）。新建或编辑任务时，选择指定的浏览器内核会自动联动切换为该内核对应的 Profile。
- **支持测试与手动打开**：在「新建/编辑任务」、「浏览器内核」和「Profile」页面均支持直接点击 **测试**（拉起指定内核与对应 Profile 并验证扩展通信）或 **手动打开**（打开指定内核与对应 Profile 的浏览器窗口手动登录网站保存 Cookie）。
- **模型服务设置**：点击左下角“设置”可配置外观模式以及 Anthropic（Claude）或 OpenAI 兼容接口（Base URL、API Key、主模型与 find 模型）。密钥用系统钥匙串加密保存，也可以用环境变量 `ANTHROPIC_API_KEY` / `OPENAI_API_KEY`。

如果 `apps/desktop/node_modules/electron/dist` 不存在（pnpm 跳过了 Electron 的下载），执行 `node apps/desktop/node_modules/electron/install.js`。

## 类型检查

```bash
pnpm typecheck
```

## Agent 循环的要点（Anthropic Provider）

- 默认模型 `claude-opus-5-5`、effort `high`、自适应思考（摘要可见），流式输出。
- 历史只追加不修改：旧截图不在客户端删除，而是交给服务端的 context editing（`clear_tool_uses_20250919`，超过 15 万输入 token 时清理旧工具结果，保留最近 8 次）。这样 thinking 块保持有效，prompt cache 也能持续命中。
- 已开启服务端 fallback（`fallbacks: "default"`），模型拒答时由 API 自动换到推荐的备用模型重试；不需要可以在 `packages/agent/src/session.ts` 里去掉。
- 工具输入流式生成（`eager_input_streaming`），所以 App 和扩展都会按 schema 校验每次输入。
- 取消时会给未完成的工具调用补上“已取消”的结果，保证下一轮对话仍然合法。

## 已知限制

- **没有权限控制**（按需求去掉）。尤其是 `file_upload` 可以读取本机任意可读文件；如需限制，给 `AgentSession` 传 `allowFile` 回调。
- **对话框自动处理**：`alert` 和 `confirm` 自动接受、`prompt` 自动取消，并在工具结果里告诉模型。
- **只处理顶层文档**：`read_page`、`find`、`form_input` 不进入 iframe（按坐标点击 iframe 内的元素仍然可以）；开放的 Shadow DOM 会被遍历。
- **控制台和网络是懒采集**：首次调用对应工具时才启用 CDP 的 Runtime/Network 域，之前的记录拿不到。这是为了减少调试器带来的页面副作用。
- **正式版 Google Chrome**：启动参数里带了 `--disable-features=DisableLoadExtensionCommandLineSwitch`，但只在 Chrome for Testing 146 上实测过；正式版能否加载扩展要按你的版本验证。
- **OpenAI 兼容服务的差异**：各家对 `tool_calls` 流式格式、`reasoning_content`、`response_format`、图片输入的支持程度不同。遇到兼容问题时先看 `jsonMode`、`vision`、`maxTokensParam`、`extraBody` 这几个选项。不同模型按截图坐标点击的准确度差别很大，非 Claude 模型更依赖 `read_page` / `find` 给出的 ref。
- 只实现了 Chat Completions；OpenAI 的 Responses API 没有接入。
- 只做了 macOS（浏览器查找路径和 `cmd` 快捷键处理）。
