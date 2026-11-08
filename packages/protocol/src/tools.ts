/**
 * 浏览器工具（Browser Tools）协议定义文件。
 *
 * 工具名称和参数结构遵循现代浏览器自动化 Agent 的接口规范，以确保各类 LLM（如 Claude、GPT 等）能够天然良好地识别并调用。
 * 
 * - `MODEL_TOOLS`：暴露给大模型的工具列表（Schema 稳定排序，利于 Prompt 缓存）。
 * - `TOOL_EXECUTOR`：标记每个工具在何处执行：
 *   - `extension`: 绝大多数工具直接经由 WebSocket 转发给 Chrome MV3 扩展执行；
 *   - `app`: 如 `find`（结合小模型视觉理解/DOM 筛选）和 `browser_batch`（多动作批处理）由宿主 App 处理；
 *   - `app+extension`: 如 `file_upload` 先由 App 读取本地磁盘文件 Base64，再转发给扩展写入页面。
 */

/** JSON Schema 基础数据类型 */
export type JsonType = "string" | "number" | "integer" | "boolean" | "array" | "object" | "null";

/** JSON Schema 规范定义（工具入参校验所用的轻量子集） */
export interface JsonSchema {
  type?: JsonType | JsonType[];
  description?: string;
  enum?: readonly (string | number | boolean)[];
  properties?: Record<string, JsonSchema>;
  required?: readonly string[];
  items?: JsonSchema;
  minItems?: number;
  maxItems?: number;
  minimum?: number;
  maximum?: number;
  additionalProperties?: boolean;
}

/** 单个工具的定义格式（包含工具名、描述和以对象为根的 input_schema） */
export interface ToolDefinition {
  name: string;
  description: string;
  input_schema: JsonSchema & { type: "object" };
}

/** 辅助生成通用的 tabId 校验定义 */
const tabId = (verb: string): JsonSchema => ({
  type: "integer",
  description: `ID of the tab to ${verb}. Must be a tab in the agent's tab group (see tabs_context_mcp).`,
});

/** 页面元素的 ref 引用，例如 "ref_12"，由 read_page 或 find 返回 */
const ref: JsonSchema = {
  type: "string",
  description: 'Element reference from read_page or find, e.g. "ref_12".',
};

/** 屏幕或视口坐标点 [x, y] */
const point = (description: string): JsonSchema => ({
  type: "array",
  items: { type: "number" },
  minItems: 2,
  maxItems: 2,
  description,
});

/** 限制返回文本最大字符数（防止内容过长爆 Token） */
const maxChars: JsonSchema = {
  type: "integer",
  minimum: 1000,
  description: "Maximum characters to return (default 50000). Longer output is cut with a note.",
};

/** computer 工具支持的底层鼠标、键盘与视口动作 */
export const COMPUTER_ACTIONS = [
  "left_click",
  "right_click",
  "double_click",
  "triple_click",
  "hover",
  "left_click_drag",
  "type",
  "key",
  "scroll",
  "scroll_to",
  "screenshot",
  "zoom",
  "wait",
] as const;
export type ComputerAction = (typeof COMPUTER_ACTIONS)[number];

/** 获取 Agent 专用标签页组上下文信息（ID、标题、URL） */
export const TABS_CONTEXT: ToolDefinition = {
  name: "tabs_context_mcp",
  description:
    "List the tabs in the agent's tab group with their IDs, titles and URLs. Call this before any other browser tool so you know which tab IDs exist. " +
    "Pass createIfEmpty: true to create the group (a new window with one blank tab) when it does not exist yet. " +
    "Prefer opening a fresh tab for a new task instead of reusing a tab the user did not point you to.",
  input_schema: {
    type: "object",
    properties: {
      createIfEmpty: {
        type: "boolean",
        description: "Create the tab group with one blank tab if it does not exist. Has no effect otherwise.",
      },
    },
    required: [],
  },
};

/** 在 Agent 标签页组中创建新的空白标签页 */
export const TABS_CREATE: ToolDefinition = {
  name: "tabs_create_mcp",
  description: "Open a new blank tab inside the agent's tab group and return its tab ID. Use navigate to load a page in it.",
  input_schema: { type: "object", properties: {}, required: [] },
};

/** 关闭 Agent 标签页组中的某个标签页 */
export const TABS_CLOSE: ToolDefinition = {
  name: "tabs_close_mcp",
  description: "Close a tab that belongs to the agent's tab group. Tabs outside the group cannot be closed.",
  input_schema: { type: "object", properties: { tabId: tabId("close") }, required: ["tabId"] },
};

/** 页面导航（加载 URL、前进、后退） */
export const NAVIGATE: ToolDefinition = {
  name: "navigate",
  description:
    'Load a URL in a tab, or move through its history with url "back" / "forward". A URL without a scheme gets https://. ' +
    "Waits for the page to start rendering, then returns the final URL and title.",
  input_schema: {
    type: "object",
    properties: {
      url: { type: "string", description: 'Absolute URL, bare host (e.g. "example.com"), "back" or "forward".' },
      tabId: tabId("navigate"),
      force: {
        type: "boolean",
        description:
          'If the page asks "Leave site?" because of unsaved changes, discard them and navigate anyway. Default false: the navigation is refused and you get an error.',
      },
    },
    required: ["url", "tabId"],
  },
};

/** 模拟真实键鼠操作与屏幕截图控制 */
export const COMPUTER: ToolDefinition = {
  name: "computer",
  description:
    "Drive the page with real mouse and keyboard input and take screenshots.\n" +
    "* Coordinates are [x, y] pixels in the most recent full-scale screenshot of that tab (origin top-left). Take a screenshot first, then aim at the centre of the element.\n" +
    "* Instead of coordinates, clicks and scroll_to accept a ref from read_page/find; this is usually more reliable for elements outside the viewport.\n" +
    "* If a click seems to have no effect, take a new screenshot and adjust before retrying; do not repeat blind clicks.\n" +
    "* Actions:\n" +
    "  - left_click / right_click / double_click / triple_click: click at coordinate or ref (optional modifiers).\n" +
    "  - hover: move the pointer to coordinate or ref without clicking.\n" +
    "  - left_click_drag: press at start_coordinate, drag to coordinate, release.\n" +
    "  - type: type text into the focused element.\n" +
    '  - key: press keys or chords, space separated, e.g. "Enter", "Tab Tab", "cmd+a Backspace". Use cmd on macOS and ctrl elsewhere. Browser zoom shortcuts are rejected; use zoom.\n' +
    "  - scroll: wheel-scroll at coordinate in scroll_direction by scroll_amount ticks (default 3). Returns a screenshot.\n" +
    "  - scroll_to: scroll the element given by ref into view.\n" +
    "  - screenshot: capture the visible viewport. scale < 1 returns a smaller image; coordinates still use the full-scale frame.\n" +
    "  - zoom: capture region [x0, y0, x1, y1] (full-scale frame) at higher detail for reading small text or icons.\n" +
    "  - wait: pause for duration seconds (max 10).",
  input_schema: {
    type: "object",
    properties: {
      action: { type: "string", enum: COMPUTER_ACTIONS, description: "The action to perform." },
      tabId: tabId("act on"),
      coordinate: point("[x, y] in the full-scale screenshot frame. Target for clicks, hover, scroll, and the end point of left_click_drag."),
      start_coordinate: point("[x, y] start point for left_click_drag."),
      ref: { ...ref, description: ref.description + " Alternative to coordinate for clicks and hover; required for scroll_to." },
      text: { type: "string", description: "Text for type, or the key sequence for key." },
      modifiers: {
        type: "string",
        description: 'Modifier keys held during a click, joined by "+": ctrl, shift, alt, cmd/meta. Example: "cmd+shift".',
      },
      repeat: { type: "integer", minimum: 1, maximum: 100, description: "Times to repeat the key sequence (key only). Default 1." },
      scroll_direction: { type: "string", enum: ["up", "down", "left", "right"], description: "Direction for scroll." },
      scroll_amount: { type: "integer", minimum: 1, maximum: 10, description: "Wheel ticks for scroll. Default 3." },
      region: {
        type: "array",
        items: { type: "number" },
        minItems: 4,
        maxItems: 4,
        description: "[x0, y0, x1, y1] rectangle for zoom, in the full-scale screenshot frame.",
      },
      scale: {
        type: "number",
        minimum: 0.1,
        maximum: 1,
        description: "screenshot/zoom only: size factor for the returned image (default 1). Coordinates are unaffected.",
      },
      duration: { type: "number", minimum: 0, maximum: 10, description: "Seconds to wait (wait only)." },
    },
    required: ["action", "tabId"],
  },
};

/** 获取页面的无障碍结构树（包含 element ref 引用） */
export const READ_PAGE: ToolDefinition = {
  name: "read_page",
  description:
    "Return an accessibility-style outline of the page: one line per meaningful element with its role, name and a ref (e.g. [ref_12]) usable by computer, form_input, file_upload and upload_image. " +
    'By default ("all") the whole document is included, also off-screen and hidden elements; filter "interactive" keeps only buttons, links and form controls that are visible in the viewport. ' +
    "Use ref_id to expand one part of a large page.",
  input_schema: {
    type: "object",
    properties: {
      tabId: tabId("read"),
      filter: { type: "string", enum: ["interactive", "all"], description: 'Which elements to include. Default "all".' },
      depth: { type: "integer", minimum: 1, maximum: 60, description: "Maximum tree depth (default 15). Lower it if the output is too large." },
      ref_id: { type: "string", description: "Only return this element and its descendants." },
      max_chars: maxChars,
    },
    required: ["tabId"],
  },
};

/** 提取页面正文文本（优先主文章内容，适合阅读长篇文档） */
export const GET_PAGE_TEXT: ToolDefinition = {
  name: "get_page_text",
  description:
    "Return the readable text of the page as plain text, preferring the main article content when the page has one. Best for reading articles and documents; use read_page to find controls.",
  input_schema: {
    type: "object",
    properties: { tabId: tabId("read"), max_chars: maxChars },
    required: ["tabId"],
  },
};

/** 自然语言查找元素（语义定位输入框、按钮等，并分配 ref） */
export const FIND: ToolDefinition = {
  name: "find",
  description:
    'Locate elements by a natural-language description ("search box", "Add to cart button for the blue mug") and return up to 20 matches with refs. Faster than reading the whole outline when you know what you are looking for.',
  input_schema: {
    type: "object",
    properties: {
      query: { type: "string", description: "What to look for." },
      tabId: tabId("search"),
    },
    required: ["query", "tabId"],
  },
};

/** 表单控件赋值（支持文本框、单复选框、下拉框、范围滑块等，直接触发 input 与 change 事件） */
export const FORM_INPUT: ToolDefinition = {
  name: "form_input",
  description:
    "Set the value of a form control directly by ref: text inputs and textareas (string), checkboxes and radios (boolean), selects (option value or visible text), number/range inputs (number). Fires input and change events.",
  input_schema: {
    type: "object",
    properties: {
      ref,
      value: { type: ["string", "boolean", "number"], description: "The value to set." },
      tabId: tabId("edit"),
    },
    required: ["ref", "value", "tabId"],
  },
};

/** 在页面上下文中执行自定义 JavaScript 代码 */
export const JAVASCRIPT: ToolDefinition = {
  name: "javascript_tool",
  description:
    "Evaluate JavaScript in the page's own context (DOM, window and page globals). Top-level await works and the value of the last expression is returned, so write `document.title` rather than `return document.title`. Results are JSON-serialised.",
  input_schema: {
    type: "object",
    properties: {
      action: { type: "string", enum: ["javascript_exec"], description: 'Always "javascript_exec".' },
      text: { type: "string", description: "The code to evaluate." },
      tabId: tabId("run code in"),
    },
    required: ["action", "text", "tabId"],
  },
};

/** 读取页面的控制台日志输出（log、warn、error、未捕获异常） */
export const READ_CONSOLE: ToolDefinition = {
  name: "read_console_messages",
  description:
    "Read console output (log, warn, error and uncaught exceptions) collected for a tab. Collection starts the first time you call this for the tab, so if nothing is returned, reproduce the problem and call it again. Use pattern to filter.",
  input_schema: {
    type: "object",
    properties: {
      tabId: tabId("read console output from"),
      pattern: { type: "string", description: "Regular expression; only matching messages are returned." },
      onlyErrors: { type: "boolean", description: "Only errors and exceptions." },
      clear: { type: "boolean", description: "Forget the returned messages after reading." },
      limit: { type: "integer", minimum: 1, maximum: 1000, description: "Maximum messages to return (default 100, newest last)." },
    },
    required: ["tabId"],
  },
};

/** 读取页面的 HTTP 网络请求记录 */
export const READ_NETWORK: ToolDefinition = {
  name: "read_network_requests",
  description:
    "List HTTP requests made by a tab (method, URL, status, type). Collection starts the first time you call this for the tab and the list resets when the tab navigates to another site. Use urlPattern to filter.",
  input_schema: {
    type: "object",
    properties: {
      tabId: tabId("read requests from"),
      urlPattern: { type: "string", description: "Substring the request URL must contain." },
      clear: { type: "boolean", description: "Forget the returned requests after reading." },
      limit: { type: "integer", minimum: 1, maximum: 1000, description: "Maximum requests to return (default 100, newest last)." },
    },
    required: ["tabId"],
  },
};

/** 上传本地文件到页面中的文件输入框（绕过系统原生文件选择弹窗） */
export const FILE_UPLOAD: ToolDefinition = {
  name: "file_upload",
  description:
    "Put local files into a file input (by ref) without opening the native file picker. Never click file inputs or upload buttons: the picker dialog is invisible to you. Find the <input type=file> with read_page or find and pass its ref.",
  input_schema: {
    type: "object",
    properties: {
      paths: {
        type: "array",
        items: { type: "string" },
        minItems: 1,
        description: "Absolute paths of the files on this computer.",
      },
      ref,
      tabId: tabId("upload to"),
    },
    required: ["paths", "ref", "tabId"],
  },
};

/** 上传或拖放之前截获的页面截图（支持填入文件选择框或拖放到画布/区域） */
export const UPLOAD_IMAGE: ToolDefinition = {
  name: "upload_image",
  description:
    "Upload a screenshot you captured earlier (by its image ID) either into a file input (ref) or by dropping it onto a point of the page (coordinate), e.g. an editor canvas. Give exactly one of ref or coordinate.",
  input_schema: {
    type: "object",
    properties: {
      imageId: { type: "string", description: "ID printed with an earlier screenshot or zoom result." },
      ref,
      coordinate: point("Drop point [x, y] in the full-scale screenshot frame."),
      filename: { type: "string", description: 'File name shown to the page (default "image.jpg").' },
      tabId: tabId("upload to"),
    },
    required: ["imageId", "tabId"],
  },
};

/** 调整浏览器窗口尺寸（用于测试响应式布局或特定分辨率） */
export const RESIZE_WINDOW: ToolDefinition = {
  name: "resize_window",
  description: "Resize the browser window that contains the tab, e.g. to test a responsive layout. Sizes are in screen pixels.",
  input_schema: {
    type: "object",
    properties: {
      width: { type: "integer", minimum: 200, maximum: 10000, description: "Window width." },
      height: { type: "integer", minimum: 200, maximum: 10000, description: "Window height." },
      tabId: tabId("resize the window of"),
    },
    required: ["width", "height", "tabId"],
  },
};

/** 录制 Agent 操作过程并导出为动图 GIF */
export const GIF_CREATOR: ToolDefinition = {
  name: "gif_creator",
  description:
    "Record the agent's actions in a tab group as an animated GIF. start_recording begins capturing a frame after each action; stop_recording stops but keeps frames; export renders the GIF and either downloads it (download: true) or drops it onto the page at coordinate; clear discards frames.",
  input_schema: {
    type: "object",
    properties: {
      action: { type: "string", enum: ["start_recording", "stop_recording", "export", "clear"], description: "What to do." },
      tabId: tabId("record"),
      download: { type: "boolean", description: "export only: save the GIF to the Downloads folder." },
      coordinate: point("export only: drop the GIF at this point instead of downloading."),
      filename: { type: "string", description: 'export only: file name (default "recording-<time>.gif").' },
      options: {
        type: "object",
        description: "export only: overlay switches, all default true.",
        properties: {
          showClickIndicators: { type: "boolean" },
          showActionLabels: { type: "boolean" },
          showProgressBar: { type: "boolean" },
        },
      },
    },
    required: ["action", "tabId"],
  },
};

/** 批量顺序执行多个浏览器工具调用（遇到错误即停），减少网络往返耗时 */
export const BROWSER_BATCH: ToolDefinition = {
  name: "browser_batch",
  description:
    "Run several browser tool calls in one step, in order, stopping at the first error. Each action is {name, input} with exactly the input you would pass to that tool. " +
    "Prefer this whenever you can predict two or more steps, e.g. click a field, type, press Enter, take a screenshot. " +
    "Coordinates in a batch refer to the screenshot you saw before the batch. browser_batch cannot be nested.",
  input_schema: {
    type: "object",
    properties: {
      actions: {
        type: "array",
        minItems: 1,
        maxItems: 50,
        description: "Tool calls to run in order.",
        items: {
          type: "object",
          properties: {
            name: { type: "string", description: "Tool name, e.g. computer, navigate, find." },
            input: { type: "object", description: "That tool's input." },
          },
          required: ["name", "input"],
        },
      },
    },
    required: ["actions"],
  },
};

const SUBMIT_RESULT: ToolDefinition = {
  name: "submit_result",
  description: "Submit structured result (form fields or key-value data) extracted from pages as requested by the task.",
  input_schema: {
    type: "object",
    properties: {
      data: {
        type: "object",
        description: "Key-value dictionary containing the extracted field names and their values.",
      },
    },
    required: ["data"],
  },
};

/** 暴露给大模型的完整工具列表（顺序固定，便于 API 提示词缓存 Prompt Caching） */
export const MODEL_TOOLS: readonly ToolDefinition[] = [
  TABS_CONTEXT,
  TABS_CREATE,
  TABS_CLOSE,
  NAVIGATE,
  COMPUTER,
  READ_PAGE,
  GET_PAGE_TEXT,
  FIND,
  FORM_INPUT,
  JAVASCRIPT,
  READ_CONSOLE,
  READ_NETWORK,
  FILE_UPLOAD,
  UPLOAD_IMAGE,
  RESIZE_WINDOW,
  GIF_CREATOR,
  BROWSER_BATCH,
  SUBMIT_RESULT,
];

/** 工具名称字面量联合类型 */
export type ToolName =
  | "tabs_context_mcp"
  | "tabs_create_mcp"
  | "tabs_close_mcp"
  | "navigate"
  | "computer"
  | "read_page"
  | "get_page_text"
  | "find"
  | "form_input"
  | "javascript_tool"
  | "read_console_messages"
  | "read_network_requests"
  | "file_upload"
  | "upload_image"
  | "resize_window"
  | "gif_creator"
  | "browser_batch"
  | "submit_result";

/**
 * 标记每个工具的执行位置：
 * - `extension`: 原样透传给浏览器扩展处理；
 * - `app`: 由 App 本地层实现（如 find 和 batch）；
 * - `app+extension`: App 先转换入参（如读取磁盘文件二进制），再下发给扩展。
 */
export const TOOL_EXECUTOR: Record<ToolName, "extension" | "app" | "app+extension"> = {
  tabs_context_mcp: "extension",
  tabs_create_mcp: "extension",
  tabs_close_mcp: "extension",
  navigate: "extension",
  computer: "extension",
  read_page: "extension",
  get_page_text: "extension",
  find: "app",
  form_input: "extension",
  javascript_tool: "extension",
  read_console_messages: "extension",
  read_network_requests: "extension",
  file_upload: "app+extension",
  upload_image: "extension",
  resize_window: "extension",
  gif_creator: "extension",
  browser_batch: "app",
  submit_result: "app",
};

/** 扩展内部支持的 DOM 候选元素搜索工具（供 App 端的 find 工具使用） */
export const FIND_CANDIDATES_TOOL = "find_candidates";

/** 根据工具名称获取对应的工具定义 */
export const getToolDefinition = (name: string): ToolDefinition | undefined => MODEL_TOOLS.find((t) => t.name === name);
