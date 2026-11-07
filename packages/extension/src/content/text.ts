import type { PageTextResult } from "./api.ts";

/** Pick the element that most likely holds the main content. */
function mainContent(): { el: HTMLElement; source: string } {
  const candidates = [...document.querySelectorAll<HTMLElement>("article, main, [role=main], [itemprop=articleBody]")];
  let best: HTMLElement | undefined;
  let bestLength = 0;
  for (const el of candidates) {
    const len = (el.innerText || "").length;
    if (len > bestLength) {
      best = el;
      bestLength = len;
    }
  }
  const bodyLength = (document.body?.innerText || "").length;
  // Only prefer the article when it carries a substantial share of the page.
  if (best && bestLength >= 500 && bestLength >= bodyLength * 0.3) {
    return { el: best, source: best.tagName.toLowerCase() };
  }
  return { el: document.body ?? document.documentElement, source: "body" };
}

export function extractPageText(maxChars: number): PageTextResult {
  const { el, source } = mainContent();
  const raw = el.innerText || el.textContent || "";
  const cleaned = raw
    .replace(/[ \t ]+/g, " ")
    .replace(/ *\n */g, "\n")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
  let text = cleaned;
  if (text.length > maxChars) {
    text = text.slice(0, maxChars) + `\n[truncated: showing ${maxChars} of ${cleaned.length} characters. Pass a larger max_chars to read more.]`;
  }
  return { title: document.title, url: location.href, text, fullLength: cleaned.length, source };
}
