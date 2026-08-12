/**
 * 生成式卡的尺寸自愈决策 —— 机制，零模型（公理 4）。
 *
 * "动态尺寸 ≠ 任意像素"（任意像素会同时废掉死缝不变量、可预测性、像素契约）。
 * 动态 = 在十档白名单内按**实测内容高度**升降：
 * 溢出升一档（屏幕不可滚动，超出的部分用户永远看不到），
 * 内容不足六成缩一档还位给桌面。
 *
 * 两道闸：≤2 次防振荡（升上去又量出偏小又缩回来的循环）；
 * sizeLocked 例外——用户缩小过的卡宁可折角提示，意愿 > 建议。
 */
import { pixelsOf, cellsOfTier, normalizeTier } from '../config/grid'

/**
 * 自愈阶梯：按面积升序，**tower 除外**——它是 4×4 竖条（专用档），
 * 混进序列会让 1/2 的"下一步"变成宽度砍半、内容反而更高。
 * 模型要竖条卡自己显式声明，自愈不路过它。
 * 1/6 溢出的第一步是 wide（加宽）：文字回流后高度自然缩，
 * 加宽治不好的下一步再加高（1/3 → 1/2 → 2/3），bump 上限 2 兜底防振荡。
 */
const LADDER = ['chip', 'strip', 'bar', '1/6', 'wide', '1/3', '1/2', '2/3', 'full']
  .sort((a, b) => cellsOfTier(a) - cellsOfTier(b))

export interface HealOpts { bumps: number; sizeLocked?: boolean }

export function healStep(size: string, contentPx: number, opts: HealOpts): string | null {
  if (opts.sizeLocked) return null
  if (opts.bumps >= 2) return null
  const idx = LADDER.findIndex(z => normalizeTier(z) === normalizeTier(size))
  if (idx < 0) return null
  const canvasH = pixelsOf(size).h
  // +2 是亚像素舍入的余量——跟车机屏溢出检测同一个数
  if (contentPx > canvasH + 2) return idx < LADDER.length - 1 ? LADDER[idx + 1] : null
  if (contentPx < canvasH * 0.6) return idx > 0 ? LADDER[idx - 1] : null
  return null
}
