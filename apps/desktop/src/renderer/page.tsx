import type { ComponentChildren } from "preact";

/** 所有页面共用的标题区：左边标题与说明，右边放操作 */
export function PageHead({ title, desc, children }: { title: string; desc?: string; children?: ComponentChildren }) {
  return (
    <header class="page-head">
      <div>
        <h1 class="page-title">{title}</h1>
        {desc && <p class="page-desc">{desc}</p>}
      </div>
      {children}
    </header>
  );
}
