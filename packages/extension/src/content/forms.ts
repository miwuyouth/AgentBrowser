import type { TransferFile } from "./api.ts";
import { accessibleName, roleOf } from "./tree.ts";
import { pageError, resolveRef } from "./refs.ts";

function label(el: Element, ref: string): string {
  const name = accessibleName(el);
  return `${ref} (${roleOf(el)}${name ? ` "${name}"` : ""})`;
}

/** Assign through the prototype setter so frameworks like React notice the change. */
function setNativeValue(el: HTMLInputElement | HTMLTextAreaElement | HTMLSelectElement, value: string) {
  const proto = Object.getPrototypeOf(el);
  const setter = Object.getOwnPropertyDescriptor(proto, "value")?.set;
  if (setter) setter.call(el, value);
  else el.value = value;
}

function fire(el: Element, ...types: string[]) {
  for (const type of types) el.dispatchEvent(new Event(type, { bubbles: true }));
}

export function setValue(ref: string, value: string | number | boolean): string {
  const el = resolveRef(ref);
  const tag = el.tagName.toLowerCase();
  (el as HTMLElement).focus?.({ preventScroll: false });

  if (tag === "select") {
    const select = el as HTMLSelectElement;
    const wanted = String(value).trim();
    const options = [...select.options];
    const match =
      options.find((o) => o.value === wanted) ??
      options.find((o) => o.textContent?.trim() === wanted) ??
      options.find((o) => o.textContent?.trim().toLowerCase() === wanted.toLowerCase());
    if (!match) {
      const available = options.slice(0, 30).map((o) => JSON.stringify(o.textContent?.trim() ?? o.value)).join(", ");
      throw pageError("option_not_found", `No option matching ${JSON.stringify(wanted)} in ${label(el, ref)}. Options: ${available}`);
    }
    if (select.multiple) match.selected = true;
    else setNativeValue(select, match.value);
    fire(select, "input", "change");
    return `Selected ${JSON.stringify(match.textContent?.trim())} in ${label(el, ref)}`;
  }

  if (tag === "input") {
    const input = el as HTMLInputElement;
    if (input.type === "checkbox" || input.type === "radio") {
      if (typeof value !== "boolean") throw pageError("input_invalid", `${label(el, ref)} needs a boolean value`);
      if (input.checked !== value) input.click(); // click() keeps framework handlers and radio groups consistent
      if (input.checked !== value) {
        input.checked = value;
        fire(input, "input", "change");
      }
      return `${value ? "Checked" : "Unchecked"} ${label(el, ref)}`;
    }
    if (input.type === "file") throw pageError("input_invalid", `${label(el, ref)} is a file input; use file_upload`);
    setNativeValue(input, String(value));
    fire(input, "input", "change");
    return `Set ${label(el, ref)} to ${JSON.stringify(input.type === "password" ? "[redacted]" : String(value))}`;
  }

  if (tag === "textarea") {
    setNativeValue(el as HTMLTextAreaElement, String(value));
    fire(el, "input", "change");
    return `Set ${label(el, ref)}`;
  }

  if ((el as HTMLElement).isContentEditable) {
    const sel = getSelection();
    const range = document.createRange();
    range.selectNodeContents(el);
    sel?.removeAllRanges();
    sel?.addRange(range);
    if (!document.execCommand("insertText", false, String(value))) {
      el.textContent = String(value);
      fire(el, "input");
    }
    return `Set the text of ${label(el, ref)}`;
  }

  throw pageError("input_invalid", `${label(el, ref)} is not a form control. Use computer to click or type instead.`);
}

function toFiles(files: TransferFile[]): File[] {
  return files.map((f) => {
    const bytes = Uint8Array.from(atob(f.data), (c) => c.charCodeAt(0));
    return new File([bytes], f.name, { type: f.mimeType || "application/octet-stream" });
  });
}

function findFileInput(el: Element): HTMLInputElement | null {
  if (el instanceof HTMLInputElement && el.type === "file") return el;
  return el.querySelector<HTMLInputElement>("input[type=file]");
}

export function setFiles(ref: string, files: TransferFile[]): string {
  const el = resolveRef(ref);
  const input = findFileInput(el);
  if (!input) throw pageError("input_invalid", `${label(el, ref)} is not a file input and contains none.`);
  if (!input.multiple && files.length > 1) throw pageError("input_invalid", "This file input accepts a single file.");
  const transfer = new DataTransfer();
  for (const f of toFiles(files)) transfer.items.add(f);
  input.files = transfer.files;
  fire(input, "input", "change");
  return `Attached ${files.map((f) => f.name).join(", ")} to ${label(input, ref)}`;
}

/** Simulate dropping files at a viewport point (CSS pixels). */
export function dropFiles(x: number, y: number, files: TransferFile[]): string {
  const target = document.elementFromPoint(x, y);
  if (!target) throw pageError("coordinate_out_of_bounds", `Nothing at (${Math.round(x)}, ${Math.round(y)}) to drop onto.`);
  const transfer = new DataTransfer();
  for (const f of toFiles(files)) transfer.items.add(f);
  const init = { bubbles: true, cancelable: true, clientX: x, clientY: y, dataTransfer: transfer };
  for (const type of ["dragenter", "dragover", "drop"]) target.dispatchEvent(new DragEvent(type, init));
  return `Dropped ${files.map((f) => f.name).join(", ")} onto <${target.tagName.toLowerCase()}>`;
}
