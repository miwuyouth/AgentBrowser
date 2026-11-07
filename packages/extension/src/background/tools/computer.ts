/**
 * 屏幕/键鼠自动化底层驱动工具（`computer` 工具）。
 *
 * 核心机制：
 * 1. 拟真键鼠事件驱动：通过 CDP 模拟真实的鼠标点击（单/双/三击、右击、拖拽、悬停）、滚轮平滑滚动与真实按键序列输入；
 * 2. 目标坐标换算：
 *    - 若提供 `ref`：向页面 Content Script 实时查询元素中心点坐标，并在必要时先滚动到视口；
 *    - 若提供全量截图坐标 `coordinate`：通过 `toViewport` 自动换算为当前标签页视口坐标；
 * 3. 新建标签页感知（`watchNewTabs`）：在点击如 `target="_blank"` 链接时，自动感知并抓取新打开的标签页 ID，提示模型；
 * 4. 滚轮操作即时回馈：scroll 滚轮滚动后会自动附带一张当前最新截屏，模型一步即可看到滚动结果；
 * 5. 区域高精度缩放（`zoom`）：裁切页面微小局部区域（如验证码、小图标、细微文字）以高清图回传给大模型。
 */

import { COMPUTER, type ComputerAction } from "@agent-browser/protocol";
import { ToolError, sleep } from "../errors.ts";
import { storeImage } from "../images.ts";
import { click, drag, moveMouse, parseChord, parseModifiers, pressChord, typeText, wheel, type MouseButton } from "../input.ts";
import { callPage } from "../page.ts";
import { screenshot, toFrame, toViewport, zoom } from "../screenshot.ts";
import { tabGroup } from "../tab-group.ts";
import type { ToolContext, ToolOutput, ToolSpec } from "./types.ts";

/** computer 工具入参结构 */
interface ComputerInput {
  action: ComputerAction;
  tabId: number;
  coordinate?: [number, number];
  start_coordinate?: [number, number];
  ref?: string;
  text?: string;
  modifiers?: string;
  repeat?: number;
  scroll_direction?: "up" | "down" | "left" | "right";
  scroll_amount?: number;
  region?: [number, number, number, number];
  scale?: number;
  duration?: number;
}

/** 鼠标点击动作配置映射 */
const CLICKS: Record<string, { button: MouseButton; count: number; verb: string }> = {
  left_click: { button: "left", count: 1, verb: "Clicked" },
  right_click: { button: "right", count: 1, verb: "Right-clicked" },
  double_click: { button: "left", count: 2, verb: "Double-clicked" },
  triple_click: { button: "left", count: 3, verb: "Triple-clicked" },
};

const ZOOM_SHORTCUT = /^(?:.*\+)?(?:=|\+|-|0|plus|minus)$/i;
const RELOAD_SHORTCUT = /^(?:(?:cmd|meta|ctrl|control)\+(?:shift\+)?r|(?:shift\+|ctrl\+)?f5)$/i;

const fmt = (p: readonly number[]) => `(${p.map((n) => Math.round(n)).join(", ")})`;

/** 支持被 signal 提前终止的等待延时 */
function abortable(ms: number, signal: AbortSignal) {
  return new Promise<void>((resolve, reject) => {
    const timer = setTimeout(resolve, ms);
    signal.addEventListener("abort", () => {
      clearTimeout(timer);
      reject(new ToolError("cancelled", "Cancelled."));
    }, { once: true });
  });
}

/** 从 ref 或 coordinate 中解析最终点击的目标坐标（CSS 像素） */
async function target(input: ComputerInput, tabId: number): Promise<{ x: number; y: number; desc: string; note?: string }> {
  if (input.ref && input.coordinate) throw new ToolError("input_invalid", "Give either ref or coordinate, not both.");
  if (input.ref) {
    const p = await callPage(tabId, "elementPoint", input.ref);
    if (p.width === 0 && p.height === 0) throw new ToolError("element_not_visible", `${p.label} has no size on screen (it may be hidden).`);
    const note = p.coveredBy ? `Note: the centre of ${input.ref} is covered by a <${p.coveredBy}> element; the click may land on it.` : undefined;
    return { x: p.x, y: p.y, desc: `on ${p.label}`, ...(note ? { note } : {}) };
  }
  if (!input.coordinate) throw new ToolError("input_invalid", `${input.action} needs coordinate or ref.`);
  const [x, y] = await toViewport(tabId, input.coordinate);
  return { x, y, desc: `at ${fmt(input.coordinate)}` };
}

/** 监听某动作执行过程中是否触发了新标签页打开（如 target=_blank 链接） */
async function watchNewTabs<T>(tabId: number, action: () => Promise<T>): Promise<{ result: T; opened: number[] }> {
  const opened: number[] = [];
  const listener = (tab: chrome.tabs.Tab) => {
    if (tab.openerTabId === tabId && tab.id !== undefined) opened.push(tab.id);
  };
  chrome.tabs.onCreated.addListener(listener);
  try {
    const result = await action();
    await sleep(350);
    return { result, opened };
  } finally {
    chrome.tabs.onCreated.removeListener(listener);
  }
}

/** 截取当前视口图像并缓存到本地内存图片池 */
async function capture(tabId: number, scale: number | undefined, prefix = "Screenshot"): Promise<ToolOutput> {
  const shot = await screenshot(tabId, scale ?? 1);
  const stored = storeImage({ data: shot.data, mediaType: "image/jpeg", width: shot.width, height: shot.height });
  const frameNote =
    shot.width !== shot.frame.frameWidth ? ` Coordinates use the full-scale frame ${shot.frame.frameWidth}x${shot.frame.frameHeight}.` : "";
  return {
    text: `${prefix} captured (${shot.width}x${shot.height}), image ID ${stored.id}.${frameNote}`,
    image: { data: shot.data, mediaType: "image/jpeg" },
  };
}

/** 执行 computer 工具的具体动作 */
async function run(input: ComputerInput, ctx: ToolContext): Promise<ToolOutput> {
  const tabId = ctx.tabId!;
  if (input.action !== "wait") await tabGroup.focus(ctx.tab!);

  switch (input.action) {
    case "left_click":
    case "right_click":
    case "double_click":
    case "triple_click": {
      const spec = CLICKS[input.action]!;
      const modifiers = parseModifiers(input.modifiers);
      const t = await target(input, tabId);
      const { opened } = await watchNewTabs(tabId, () => click(tabId, t.x, t.y, { button: spec.button, count: spec.count, modifiers }));
      if (t.note) ctx.notes.push(t.note);
      if (opened.length) ctx.notes.push(`The click opened new tab(s): ${opened.join(", ")}. Pass that tabId to interact with it.`);
      return { text: `${spec.verb} ${t.desc}.`, recordable: { label: input.action, point: [t.x, t.y] }, withTabs: opened.length > 0 };
    }

    case "hover": {
      const t = await target(input, tabId);
      await moveMouse(tabId, t.x, t.y);
      await sleep(150);
      return { text: `Moved the pointer ${t.desc}.`, recordable: { label: "hover", point: [t.x, t.y] } };
    }

    case "left_click_drag": {
      if (!input.start_coordinate || !input.coordinate) {
        throw new ToolError("input_invalid", "left_click_drag needs start_coordinate and coordinate.");
      }
      const from = await toViewport(tabId, input.start_coordinate, "start_coordinate");
      const to = await toViewport(tabId, input.coordinate);
      await drag(tabId, from, to);
      return {
        text: `Dragged from ${fmt(input.start_coordinate)} to ${fmt(input.coordinate)}.`,
        recordable: { label: "drag", point: to },
      };
    }

    case "type": {
      if (!input.text) throw new ToolError("input_invalid", "type needs non-empty text.");
      await typeText(tabId, input.text);
      return { text: `Typed ${JSON.stringify(input.text.length > 200 ? input.text.slice(0, 200) + "…" : input.text)}.`, recordable: { label: "type" } };
    }

    case "key": {
      const sequence = (input.text ?? "").trim().split(/\s+/).filter(Boolean);
      if (sequence.length === 0) throw new ToolError("input_invalid", "key needs text, e.g. \"Enter\" or \"cmd+a\".");
      const repeat = input.repeat ?? 1;
      if (sequence.length === 1 && RELOAD_SHORTCUT.test(sequence[0]!)) {
        const hard = /shift|ctrl\+f5/i.test(sequence[0]!);
        await chrome.tabs.reload(tabId, { bypassCache: hard });
        return { text: `Reloaded the page${hard ? " (bypassing the cache)" : ""}.`, recordable: { label: "reload" } };
      }
      const chords = sequence.map((k) => {
        if (/[+]/.test(k) && /(cmd|meta|ctrl|control)\+/i.test(k) && ZOOM_SHORTCUT.test(k)) {
          throw new ToolError("page_zoom_shortcut_unsupported", `"${k}" was not pressed: browser zoom shortcuts are not supported. Use the zoom action to inspect a region.`);
        }
        return parseChord(k);
      });
      for (let i = 0; i < repeat; i++) {
        for (const chord of chords) {
          if (ctx.signal.aborted) throw new ToolError("cancelled", "Cancelled.");
          await pressChord(tabId, chord);
          await sleep(15);
        }
      }
      return { text: `Pressed ${sequence.join(" ")}${repeat > 1 ? ` ×${repeat}` : ""}.`, recordable: { label: `key ${sequence.join(" ")}` } };
    }

    case "scroll": {
      if (!input.coordinate) throw new ToolError("input_invalid", "scroll needs coordinate (where to place the wheel).");
      const [x, y] = await toViewport(tabId, input.coordinate);
      const dir = input.scroll_direction ?? "down";
      const ticks = input.scroll_amount ?? 3;
      const step = 100 * ticks;
      const [dx, dy] = dir === "up" ? [0, -step] : dir === "down" ? [0, step] : dir === "left" ? [-step, 0] : [step, 0];
      await wheel(tabId, x, y, dx, dy);
      await sleep(350);
      const shot = await capture(tabId, undefined, "Screenshot after scrolling");
      return { ...shot, text: `Scrolled ${dir} by ${ticks} ticks at ${fmt(input.coordinate)}.\n${shot.text}`, recordable: { label: `scroll ${dir}`, point: [x, y] } };
    }

    case "scroll_to": {
      if (!input.ref) throw new ToolError("input_invalid", "scroll_to needs ref.");
      const p = await callPage(tabId, "scrollTo", input.ref);
      await sleep(150);
      const frame = toFrame(tabId, p.x, p.y);
      return { text: `Scrolled ${p.label} into view${frame ? `; its centre is now near ${fmt(frame)}` : ""}.`, recordable: { label: "scroll_to" } };
    }

    case "screenshot":
      return capture(tabId, input.scale);

    case "zoom": {
      if (!input.region) throw new ToolError("input_invalid", "zoom needs region [x0, y0, x1, y1].");
      const z = await zoom(tabId, input.region, input.scale ?? 1);
      const stored = storeImage({ data: z.data, mediaType: "image/jpeg", width: z.width, height: z.height });
      return {
        text: `Zoomed into region ${fmt(z.region)} (${z.width}x${z.height}), image ID ${stored.id}. Coordinates still refer to the full-scale frame.`,
        image: { data: z.data, mediaType: "image/jpeg" },
      };
    }

    case "wait": {
      const seconds = input.duration;
      if (!seconds || seconds <= 0) throw new ToolError("input_invalid", "wait needs a positive duration (seconds).");
      await abortable(Math.min(seconds, 10) * 1000, ctx.signal);
      return { text: `Waited ${seconds} second${seconds === 1 ? "" : "s"}.` };
    }
  }
}

export const computerTool: ToolSpec = {
  name: COMPUTER.name,
  schema: COMPUTER.input_schema,
  needsTab: true,
  run,
};
