import type { PageError } from "./api.ts";

/**
 * Stable element references ("ref_N") shared by all tools. Elements are held
 * weakly so the page can garbage-collect removed nodes.
 */
const byRef = new Map<string, WeakRef<Element>>();
const byElement = new WeakMap<Element, string>();
let counter = 0;

export function refFor(el: Element): string {
  const existing = byElement.get(el);
  if (existing && byRef.get(existing)?.deref() === el) return existing;
  const ref = `ref_${++counter}`;
  byRef.set(ref, new WeakRef(el));
  byElement.set(el, ref);
  return ref;
}

export function resolveRef(ref: string): Element {
  const el = byRef.get(ref)?.deref();
  if (!el || !el.isConnected) {
    byRef.delete(ref);
    throw pageError(
      "ref_stale",
      `Element ${ref} is no longer on the page. Call read_page or find again to get fresh refs.`,
    );
  }
  return el;
}

/** Drop entries whose element was collected. */
export function pruneRefs() {
  for (const [ref, weak] of byRef) if (!weak.deref()) byRef.delete(ref);
}

export function pageError(code: string, message: string): PageError {
  const err = new Error(message) as PageError;
  err.code = code;
  return err;
}
