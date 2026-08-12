/**
 * 手势分类 —— 纯算术，不碰 DOM。
 *
 * 方向锁是这里唯一的"聪明"：横向滑撤和纵向滚动会抢同一根手指，
 * 斜着划一律让给滚动（滚动是高频动作，误撤一张卡比多滚一下伤得多）。
 */

/** tap 的位移容差（stage 像素）。手指按下总会抖一两像素 */
export const TAP_SLOP = 10
/** 滑撤的最小横向位移。太小会把急躁的点按误判成撤卡 */
export const SWIPE_MIN = 80
/** 按住超过这个时长不算 tap——那是犹豫不是选择 */
const TAP_MAX_MS = 800

export type Gesture = 'tap' | 'swipe-x' | 'scroll' | null

export function classifyGesture(m: { dx: number; dy: number; dt: number }): Gesture {
  const ax = Math.abs(m.dx), ay = Math.abs(m.dy)
  if (ax < TAP_SLOP && ay < TAP_SLOP) return m.dt <= TAP_MAX_MS ? 'tap' : null
  // 方向锁：横向要**明显**大于纵向（2 倍）才算滑撤
  if (ax >= SWIPE_MIN && ax > ay * 2) return 'swipe-x'
  if (ay >= TAP_SLOP * 3) return 'scroll'
  return null
}
