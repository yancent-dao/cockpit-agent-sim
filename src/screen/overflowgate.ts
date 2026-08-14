/**
 * 生成式卡溢出的**第四、第五道闸** —— 纯函数，机制不是策略。
 *
 * 前三道已经有了：消毒白名单（`sanitize.ts`）· 像素契约（模板 desc 里
 * 拼进真实像素）· 尺寸自愈（`heal.ts` 按实测高度升档）。
 *
 * 天花板在这里：自愈**只会升档，升到最大档还溢出就直接裁掉**，
 * 而且只测高度 —— 长表格横向出界完全不触发。用户看到的溢出就是
 * 撞上天花板之后的样子。
 *
 *   闸四 · 整体缩放：溢出从"裁掉一半"变成"整张缩小"，**信息不丢**。
 *   闸五 · 文字兜底：缩到读不了的份上就剥到纯文字。
 *          **宁可显示得少，不要显示得糊。**
 *
 * 纯 CSS `transform`，零依赖。
 */

/**
 * 缩放下限。低于这个值说明模型排了三倍于画布的内容 ——
 * 缩到那个份上字已经读不了，硬缩只是把"看不全"换成"看不清"。
 */
export const MIN_SCALE = 0.65

export interface FitInput {
  /** 画布可用宽高 */
  w: number
  h: number
  /** 内容的实测宽高 */
  contentW: number
  contentH: number
}

export type FitResult =
  | { do: 'none' }
  | { do: 'scale'; scale: number }
  | { do: 'text' }

const ok = (n: number) => Number.isFinite(n) && n > 0

export function fitScale(i: FitInput): FitResult {
  // 测不到尺寸（还没布局 / 节点被隐藏）时当没溢出 —— 别拿 NaN 去算 transform
  if (![i.w, i.h, i.contentW, i.contentH].every(ok)) return { do: 'none' }

  const kx = i.w / i.contentW
  const ky = i.h / i.contentH
  // 两个方向都得装下，所以取更小的那个比例
  const k = Math.min(kx, ky)
  if (k >= 1) return { do: 'none' }
  if (k < MIN_SCALE) return { do: 'text' }
  return { do: 'scale', scale: k }
}
