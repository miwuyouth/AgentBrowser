/**
 * 默认 Profile / 默认内核的推导模块。
 * 全局只有一个默认 Profile，默认内核就是它所在的内核。
 * 纯函数、不依赖 Electron，方便单独进行单元测试。
 */

/** Profile 引用信息：包含 Profile 自身的唯一 ID 与其归属的浏览器内核 ID */
export interface ProfileRef {
  /** Profile 唯一标识，格式通常为 `${kernelId}::${dirName}` */
  id: string;
  /** 所属浏览器内核的唯一标识 */
  kernelId: string;
}

/** 默认内核 / Profile 推导所需的输入数据结构 */
export interface DefaultsInput {
  /** 当前系统中检测到的浏览器内核列表及其安装状态 */
  kernels: { id: string; installed: boolean }[];
  /** 系统中所有的 Profile 引用，通常按内核顺序排列 */
  refs: ProfileRef[];
  /** 用户先前显式保存的默认 Profile ID；若未设置则为空字符串 */
  savedProfile: string;
  /** 旧版本遗留保存的「默认内核」ID；仅在尚未设置 savedProfile 时用于平滑迁移 */
  legacyKernel: string;
}

/**
 * 推导当前全局默认的 Profile ID。
 *
 * 【调用时机】
 * - 应用启动加载配置文件、初始化任务列表或内核列表时调用（由 `storage.ts` 的 `resolveDefaultProfileId` 触发）。
 * - 渲染进程通过 IPC 请求全局状态，重新组装默认 Profile / 内核标识时调用。
 *
 * 【作用】
 * 根据已安装的内核以及用户配置偏好，选定最合适的默认 Profile：
 * 1. 优先使用用户主动保存且所属内核已安装的 Profile；
 * 2. 若未指定，则尝试平滑迁移，选取旧版本「默认内核」下的第一个可用 Profile；
 * 3. 若均不匹配，降级回退取第一个可用（所属内核已安装）的 Profile，兜底返回全部 Profile 的第一项。
 *
 * @param i 包含内核状态、Profile 列表及用户持久化配置的输入对象
 * @returns 选定的默认 Profile ID，若无可用 Profile 则返回 undefined
 */
export function pickDefaultProfile(i: DefaultsInput): string | undefined {
  const installed = new Set(i.kernels.filter((k) => k.installed).map((k) => k.id));
  const usable = i.refs.filter((r) => installed.has(r.kernelId));

  if (i.savedProfile && usable.some((r) => r.id === i.savedProfile)) return i.savedProfile;

  const legacyHit = usable.find((r) => r.kernelId === i.legacyKernel);
  if (legacyHit) return legacyHit.id;

  return (usable[0] ?? i.refs[0])?.id;
}

/**
 * 推导当前全局默认的浏览器内核 ID。
 *
 * 【调用时机】
 * - 应用启动装配任务列表、解析未显式绑定内核的任务时调用（由 `storage.ts` 的 `resolveDefaultKernelId` 触发）。
 * - 组装内核卡片展示列表并标记 `isDefault` 状态时调用。
 *
 * 【作用】
 * 推导出默认的内核 ID。由于系统设计中「全局只有一个默认 Profile，默认内核即为该 Profile 所在的内核」，
 * 本函数先通过 `pickDefaultProfile` 找到默认 Profile 并获取其所属内核；
 * 若该内核未安装或不存在，则依次回退到旧版本默认内核、第一个已安装的内核或第一个内核。
 *
 * @param i 包含内核状态、Profile 列表及用户持久化配置的输入对象
 * @returns 选定的默认内核 ID，若列表为空则返回 undefined
 */
export function pickDefaultKernel(i: DefaultsInput): string | undefined {
  const profileId = pickDefaultProfile(i);
  const owner = i.kernels.find((k) => k.id === i.refs.find((r) => r.id === profileId)?.kernelId);
  if (owner?.installed) return owner.id;

  const legacy = i.kernels.find((k) => k.id === i.legacyKernel && k.installed);
  return (legacy ?? i.kernels.find((k) => k.installed) ?? i.kernels[0])?.id;
}
