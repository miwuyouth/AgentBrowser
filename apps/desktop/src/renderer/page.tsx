import { createContext, type ComponentChildren } from "preact";
import { useContext } from "preact/hooks";
import { Icon } from "./icons.tsx";
import { shortcut } from "./platform.ts";

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
 * @param desc 可选的页面副标题或简要说明（可带行内链接，如「全部结果 ›」）
 * @param children 放置在右侧的操作按钮区域插槽
 */
export function PageHead({ title, desc, children }: { title: string; desc?: ComponentChildren; children?: ComponentChildren }) {
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

/** 「< 返回」要回到的上一页：显示的文字和点击后的动作 */
export interface BackTarget {
  label: string;
  onBack: () => void;
}

/** 由 `app.tsx` 的 `Main` 根据导航历史提供；顶级页面没有上一页时为 null */
export const BackContext = createContext<BackTarget | null>(null);

/**
 * 页面左上角的「< 上一页」返回按钮。
 *
 * 【调用时机】在所有二级页面（编辑任务、运行详情、这一轮、实时运行等）的顶部渲染。
 * 【作用】回到真正的上一页（按导航历史）；没有历史时（如从系统通知直接打开）回到所属的上级页面；
 * 顶级页面没有上一页，不渲染任何内容。
 */
export function BackButton() {
  const back = useContext(BackContext);
  if (!back) return null;
  return (
    <button type="button" class="back" title={`返回上一页（${shortcut("[")}）`} onClick={back.onBack}>
      <Icon name="back" size={14} />
      {back.label}
    </button>
  );
}
