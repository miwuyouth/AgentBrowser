import type { ComponentChildren } from "preact";

/**
 * 通用页面头部标题栏组件。
 *
 * 【调用时机】
 * 在任务列表（TasksView）、任务编辑器（EditorView）、运行历史（RunsView）、环境管理（EnvView）等所有主工作区页面的顶层渲染。
 *
 * 【作用】
 * 提供一致规范的页面标头布局：
 * - 左侧呈现清晰的页面一级标题（title）与补充说明文字（desc）；
 * - 右侧插槽（children）用于自适应容纳该页面专属的主要操作按钮与控件组合。
 *
 * @param title 页面主标题
 * @param desc 可选的页面副标题或简要说明
 * @param children 放置在右侧的操作按钮区域插槽
 */
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
