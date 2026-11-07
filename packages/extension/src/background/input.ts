import { cdp } from "./cdp.ts";
import { ToolError, sleep } from "./errors.ts";
import { MAC_EDIT_COMMANDS, MODIFIER_BITS, keyForChar, keyForName, type KeyDef } from "./keys.ts";
import { sendToPage } from "./page.ts";

const isMac = /Mac/i.test((navigator as any).userAgentData?.platform ?? navigator.platform ?? "");

export type MouseButton = "left" | "right" | "middle";
const BUTTON_BITS: Record<MouseButton, number> = { left: 1, right: 2, middle: 4 };

export function parseModifiers(spec: string | undefined): number {
  if (!spec) return 0;
  let bits = 0;
  for (const part of spec.toLowerCase().split("+").map((s) => s.trim()).filter(Boolean)) {
    const bit = MODIFIER_BITS[part];
    if (bit === undefined) throw new ToolError("input_invalid", `Unknown modifier "${part}". Use ctrl, shift, alt or cmd.`);
    bits |= bit;
  }
  return bits;
}

const mouse = (tabId: number, params: Record<string, unknown>) => cdp.send(tabId, "Input.dispatchMouseEvent", params);

/** 在执行底层 CDP 拟真键鼠动作期间，向页面发送临时放行信号，使 CDP 事件穿透防误触遮罩 */
async function withCdpInput<T>(tabId: number, fn: () => Promise<T>): Promise<T> {
  await sendToPage(tabId, { type: "agent-browser:cdp-input", active: true });
  try {
    return await fn();
  } finally {
    await sendToPage(tabId, { type: "agent-browser:cdp-input", active: false });
  }
}

export async function moveMouse(tabId: number, x: number, y: number, buttons = 0, modifiers = 0) {
  await mouse(tabId, { type: "mouseMoved", x, y, button: buttons ? "left" : "none", buttons, modifiers });
}

export async function click(tabId: number, x: number, y: number, opts: { button?: MouseButton; count?: number; modifiers?: number } = {}) {
  const button = opts.button ?? "left";
  const count = opts.count ?? 1;
  const modifiers = opts.modifiers ?? 0;
  return withCdpInput(tabId, async () => {
    void sendToPage(tabId, { type: "agent-browser:pointer", x, y });
    await moveMouse(tabId, x, y, 0, modifiers);
    await sleep(30);
    for (let i = 1; i <= count; i++) {
      await mouse(tabId, { type: "mousePressed", x, y, button, buttons: BUTTON_BITS[button], clickCount: i, modifiers });
      await mouse(tabId, { type: "mouseReleased", x, y, button, buttons: 0, clickCount: i, modifiers });
      if (i < count) await sleep(60);
    }
  });
}

export async function drag(tabId: number, from: [number, number], to: [number, number]) {
  return withCdpInput(tabId, async () => {
    await moveMouse(tabId, from[0], from[1]);
    await mouse(tabId, { type: "mousePressed", x: from[0], y: from[1], button: "left", buttons: 1, clickCount: 1 });
    const steps = 12;
    for (let i = 1; i <= steps; i++) {
      const x = from[0] + ((to[0] - from[0]) * i) / steps;
      const y = from[1] + ((to[1] - from[1]) * i) / steps;
      await mouse(tabId, { type: "mouseMoved", x, y, button: "left", buttons: 1 });
      await sleep(16);
    }
    await mouse(tabId, { type: "mouseReleased", x: to[0], y: to[1], button: "left", buttons: 0, clickCount: 1 });
    void sendToPage(tabId, { type: "agent-browser:pointer", x: to[0], y: to[1] });
  });
}

export async function wheel(tabId: number, x: number, y: number, deltaX: number, deltaY: number) {
  return withCdpInput(tabId, async () => {
    await moveMouse(tabId, x, y);
    await mouse(tabId, { type: "mouseWheel", x, y, deltaX, deltaY });
  });
}

const keyEvent = (tabId: number, params: Record<string, unknown>) => cdp.send(tabId, "Input.dispatchKeyEvent", params);

async function keyDown(tabId: number, def: KeyDef, modifiers: number, commands: string[] = []) {
  // Shortcuts held with ctrl/cmd must not insert their character.
  const text = modifiers & (2 | 4) ? undefined : def.text;
  await keyEvent(tabId, {
    type: text ? "keyDown" : "rawKeyDown",
    key: def.key,
    code: def.code,
    windowsVirtualKeyCode: def.keyCode,
    nativeVirtualKeyCode: def.keyCode,
    modifiers,
    text: text ?? "",
    unmodifiedText: text ?? "",
    location: def.location ?? 0,
    commands,
  });
}

async function keyUp(tabId: number, def: KeyDef, modifiers: number) {
  await keyEvent(tabId, {
    type: "keyUp",
    key: def.key,
    code: def.code,
    windowsVirtualKeyCode: def.keyCode,
    nativeVirtualKeyCode: def.keyCode,
    modifiers,
    location: def.location ?? 0,
  });
}

/** 模拟用户打字：US 键盘字符发送单个按键事件，其余字符通过 IME 方式插入 */
export async function typeText(tabId: number, text: string) {
  return withCdpInput(tabId, async () => {
    let pending = "";
    const flush = async () => {
      if (!pending) return;
      await cdp.send(tabId, "Input.insertText", { text: pending });
      pending = "";
    };
    for (const ch of text) {
      if (ch === "\r") continue;
      if (ch === "\n" || ch === "\t") {
        await flush();
        const def = keyForName(ch === "\n" ? "enter" : "tab")!;
        await keyDown(tabId, def, 0);
        await keyUp(tabId, def, 0);
        continue;
      }
      const hit = keyForChar(ch);
      if (!hit) {
        pending += ch;
        continue;
      }
      await flush();
      const modifiers = hit.shift ? 8 : 0;
      await keyDown(tabId, hit.def, modifiers);
      await keyUp(tabId, hit.def, modifiers);
    }
    await flush();
  });
}

export interface Chord {
  key: KeyDef;
  keyName: string;
  modifierNames: string[];
  modifiers: number;
}

export function parseChord(spec: string): Chord {
  const parts = spec.endsWith("++") ? [...spec.slice(0, -2).split("+"), "+"] : spec.split("+");
  const keyName = parts.pop() ?? "";
  const modifierNames: string[] = [];
  let modifiers = 0;
  for (const raw of parts) {
    const m = raw.toLowerCase();
    const bit = MODIFIER_BITS[m];
    if (bit === undefined) throw new ToolError("input_invalid", `Unknown modifier "${raw}" in "${spec}".`);
    modifiers |= bit;
    modifierNames.push(bit === 1 ? "alt" : bit === 2 ? "ctrl" : bit === 4 ? "meta" : "shift");
  }
  let key = keyForName(keyName);
  if (!key) throw new ToolError("input_invalid", `Unknown key "${keyName}" in "${spec}".`);
  // shift+a should produce "A", like a real keyboard.
  if (modifiers & 8 && key.text && keyName.length === 1) {
    const shifted = keyForChar(keyName.toUpperCase());
    if (shifted?.shift) key = shifted.def;
  }
  return { key, keyName: keyName.toLowerCase(), modifierNames, modifiers };
}

export async function pressChord(tabId: number, chord: Chord) {
  return withCdpInput(tabId, async () => {
    const order = ["meta", "ctrl", "alt", "shift"];
    const held = order.filter((m) => chord.modifierNames.includes(m));
    let active = 0;
    for (const m of held) {
      active |= MODIFIER_BITS[m]!;
      await keyDown(tabId, keyForName(m)!, active);
    }
    const commandKey = [...held.filter((m) => m !== "ctrl").sort(), chord.key.key.toLowerCase()].join("+");
    const command = isMac && !held.includes("ctrl") ? MAC_EDIT_COMMANDS[commandKey] : undefined;
    await keyDown(tabId, chord.key, chord.modifiers, command ? [command] : []);
    await keyUp(tabId, chord.key, chord.modifiers);
    for (const m of held.reverse()) {
      active &= ~MODIFIER_BITS[m]!;
      await keyUp(tabId, keyForName(m)!, active);
    }
  });
}
