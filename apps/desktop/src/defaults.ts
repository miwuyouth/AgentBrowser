/**
 * 默认 Profile / 默认内核的推导。全局只有一个默认 Profile，默认内核就是它所在的内核。
 * 纯函数、不依赖 Electron，方便单独测试。
 */

export interface ProfileRef {
  id: string;
  kernelId: string;
}

export interface DefaultsInput {
  kernels: { id: string; installed: boolean }[];
  /** 所有 Profile，按内核顺序排 */
  refs: ProfileRef[];
  /** 用户保存的默认 Profile；没有则为空串 */
  savedProfile: string;
  /** 旧版本保存的「默认内核」；只在没有 savedProfile 时用来迁移 */
  legacyKernel: string;
}

/**
 * 用户选的那个；它不存在、或所在内核没装，就按顺序取第一个可用的。
 * 迁移：没有默认 Profile 时，取旧「默认内核」下的第一个 Profile。
 */
export function pickDefaultProfile(i: DefaultsInput): string | undefined {
  const installed = new Set(i.kernels.filter((k) => k.installed).map((k) => k.id));
  const usable = i.refs.filter((r) => installed.has(r.kernelId));

  if (i.savedProfile && usable.some((r) => r.id === i.savedProfile)) return i.savedProfile;

  const legacyHit = usable.find((r) => r.kernelId === i.legacyKernel);
  if (legacyHit) return legacyHit.id;

  return (usable[0] ?? i.refs[0])?.id;
}

/** 默认内核：默认 Profile 所在的内核；它没装或没有 Profile 时，退回旧默认内核、第一个已装的、第一个 */
export function pickDefaultKernel(i: DefaultsInput): string | undefined {
  const profileId = pickDefaultProfile(i);
  const owner = i.kernels.find((k) => k.id === i.refs.find((r) => r.id === profileId)?.kernelId);
  if (owner?.installed) return owner.id;

  const legacy = i.kernels.find((k) => k.id === i.legacyKernel && k.installed);
  return (legacy ?? i.kernels.find((k) => k.installed) ?? i.kernels[0])?.id;
}
