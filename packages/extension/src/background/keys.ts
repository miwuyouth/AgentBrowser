/** US-layout key definitions for CDP Input.dispatchKeyEvent. */
export interface KeyDef {
  key: string;
  code: string;
  keyCode: number;
  text?: string;
  shiftKey?: string;
  location?: number;
}

const named: Record<string, KeyDef> = {
  enter: { key: "Enter", code: "Enter", keyCode: 13, text: "\r" },
  return: { key: "Enter", code: "Enter", keyCode: 13, text: "\r" },
  tab: { key: "Tab", code: "Tab", keyCode: 9 },
  backspace: { key: "Backspace", code: "Backspace", keyCode: 8 },
  delete: { key: "Delete", code: "Delete", keyCode: 46 },
  escape: { key: "Escape", code: "Escape", keyCode: 27 },
  esc: { key: "Escape", code: "Escape", keyCode: 27 },
  space: { key: " ", code: "Space", keyCode: 32, text: " " },
  arrowup: { key: "ArrowUp", code: "ArrowUp", keyCode: 38 },
  arrowdown: { key: "ArrowDown", code: "ArrowDown", keyCode: 40 },
  arrowleft: { key: "ArrowLeft", code: "ArrowLeft", keyCode: 37 },
  arrowright: { key: "ArrowRight", code: "ArrowRight", keyCode: 39 },
  up: { key: "ArrowUp", code: "ArrowUp", keyCode: 38 },
  down: { key: "ArrowDown", code: "ArrowDown", keyCode: 40 },
  left: { key: "ArrowLeft", code: "ArrowLeft", keyCode: 37 },
  right: { key: "ArrowRight", code: "ArrowRight", keyCode: 39 },
  home: { key: "Home", code: "Home", keyCode: 36 },
  end: { key: "End", code: "End", keyCode: 35 },
  pageup: { key: "PageUp", code: "PageUp", keyCode: 33 },
  pagedown: { key: "PageDown", code: "PageDown", keyCode: 34 },
  insert: { key: "Insert", code: "Insert", keyCode: 45 },
  shift: { key: "Shift", code: "ShiftLeft", keyCode: 16, location: 1 },
  control: { key: "Control", code: "ControlLeft", keyCode: 17, location: 1 },
  ctrl: { key: "Control", code: "ControlLeft", keyCode: 17, location: 1 },
  alt: { key: "Alt", code: "AltLeft", keyCode: 18, location: 1 },
  option: { key: "Alt", code: "AltLeft", keyCode: 18, location: 1 },
  meta: { key: "Meta", code: "MetaLeft", keyCode: 91, location: 1 },
  cmd: { key: "Meta", code: "MetaLeft", keyCode: 91, location: 1 },
  command: { key: "Meta", code: "MetaLeft", keyCode: 91, location: 1 },
  win: { key: "Meta", code: "MetaLeft", keyCode: 91, location: 1 },
};
for (let i = 1; i <= 12; i++) named[`f${i}`] = { key: `F${i}`, code: `F${i}`, keyCode: 111 + i };

// [unshifted, shifted, code, keyCode]
const punctuation: [string, string, string, number][] = [
  ["`", "~", "Backquote", 192],
  ["-", "_", "Minus", 189],
  ["=", "+", "Equal", 187],
  ["[", "{", "BracketLeft", 219],
  ["]", "}", "BracketRight", 221],
  ["\\", "|", "Backslash", 220],
  [";", ":", "Semicolon", 186],
  ["'", '"', "Quote", 222],
  [",", "<", "Comma", 188],
  [".", ">", "Period", 190],
  ["/", "?", "Slash", 191],
];
const digitShift = ")!@#$%^&*(";

const byChar = new Map<string, { def: KeyDef; shift: boolean }>();
for (let i = 0; i < 26; i++) {
  const lower = String.fromCharCode(97 + i);
  const upper = lower.toUpperCase();
  const base = { code: `Key${upper}`, keyCode: 65 + i };
  byChar.set(lower, { def: { ...base, key: lower, text: lower }, shift: false });
  byChar.set(upper, { def: { ...base, key: upper, text: upper }, shift: true });
}
for (let d = 0; d <= 9; d++) {
  const ch = String(d);
  const base = { code: `Digit${ch}`, keyCode: 48 + d };
  byChar.set(ch, { def: { ...base, key: ch, text: ch }, shift: false });
  const s = digitShift[d]!;
  byChar.set(s, { def: { ...base, key: s, text: s }, shift: true });
}
for (const [plain, shifted, code, keyCode] of punctuation) {
  byChar.set(plain, { def: { key: plain, code, keyCode, text: plain }, shift: false });
  byChar.set(shifted, { def: { key: shifted, code, keyCode, text: shifted }, shift: true });
}
byChar.set(" ", { def: named.space!, shift: false });

/** Key for a single typed character (US layout), if it has one. */
export function keyForChar(ch: string) {
  return byChar.get(ch);
}

/** Key for a name in a `key` action ("Enter", "a", "F5", "ArrowLeft"). */
export function keyForName(name: string): KeyDef | undefined {
  const lower = name.toLowerCase();
  if (named[lower]) return named[lower];
  if (name.length === 1) {
    const hit = byChar.get(name) ?? byChar.get(lower);
    return hit?.def;
  }
  return undefined;
}

export const MODIFIER_BITS: Record<string, number> = {
  alt: 1,
  option: 1,
  ctrl: 2,
  control: 2,
  meta: 4,
  cmd: 4,
  command: 4,
  win: 4,
  windows: 4,
  super: 4,
  shift: 8,
};

/**
 * On macOS, Chrome only performs editing shortcuts sent through CDP when the
 * matching editing command is attached to the key event.
 */
export const MAC_EDIT_COMMANDS: Record<string, string> = {
  backspace: "deleteBackward",
  delete: "deleteForward",
  "alt+backspace": "deleteWordBackward",
  "alt+delete": "deleteWordForward",
  "meta+backspace": "deleteToBeginningOfLine",
  arrowleft: "moveLeft",
  arrowright: "moveRight",
  arrowup: "moveUp",
  arrowdown: "moveDown",
  "shift+arrowleft": "moveLeftAndModifySelection",
  "shift+arrowright": "moveRightAndModifySelection",
  "shift+arrowup": "moveUpAndModifySelection",
  "shift+arrowdown": "moveDownAndModifySelection",
  "alt+arrowleft": "moveWordLeft",
  "alt+arrowright": "moveWordRight",
  "alt+shift+arrowleft": "moveWordLeftAndModifySelection",
  "alt+shift+arrowright": "moveWordRightAndModifySelection",
  "meta+arrowleft": "moveToBeginningOfLine",
  "meta+arrowright": "moveToEndOfLine",
  "meta+arrowup": "moveToBeginningOfDocument",
  "meta+arrowdown": "moveToEndOfDocument",
  "meta+shift+arrowleft": "moveToBeginningOfLineAndModifySelection",
  "meta+shift+arrowright": "moveToEndOfLineAndModifySelection",
  "meta+shift+arrowup": "moveToBeginningOfDocumentAndModifySelection",
  "meta+shift+arrowdown": "moveToEndOfDocumentAndModifySelection",
  home: "scrollToBeginningOfDocument",
  end: "scrollToEndOfDocument",
  pageup: "scrollPageUp",
  pagedown: "scrollPageDown",
  "meta+a": "selectAll",
  "meta+c": "copy",
  "meta+x": "cut",
  "meta+v": "paste",
  "meta+z": "undo",
  "meta+shift+z": "redo",
};
