/**
 * FLIP —— 让栅格移位从「瞬移」变成「滑过去」。
 *
 * CSS Grid 的 `grid-row`/`grid-column` **不能 transition**。renderDesk() 改完位置，
 * 卡片是瞬移的：导航卡一来，天气卡直接从左上闪到右下，用户根本没看清它去了哪。
 *
 * 做法：DOM 更新**前**记 first rect，更新**后**记 last rect，
 * 用反向 transform 把元素"拉回"旧位置，再动画归零。
 *
 * 这里只有算术，不碰 DOM —— 两个坑都是算错数导致的，必须能测。
 */

export interface Rect { left: number; top: number; width: number; height: number }

export interface Delta { dx: number; dy: number; sx: number; sy: number }

/**
 * @param scale 舞台缩放比。
 *
 * **坑 ①**：舞台是 `scale()` 过的（2560×1440 的虚拟屏适配到真实窗口）。
 * `getBoundingClientRect()` 返回**缩放后**像素，而 transform 作用在元素**本地**
 * 坐标系 —— dx/dy 必须先除以缩放比，否则 0.5 倍缩放下卡片会飞出去两倍距离。
 * sx/sy 是**比值**，缩放比在分子分母上抵消，不受影响。
 */
export function flipDelta(first: Rect, last: Rect, scale = 1): Delta {
  const k = Number.isFinite(scale) && scale > 0 ? scale : 1
  return {
    dx: (first.left - last.left) / k,
    dy: (first.top - last.top) / k,
    // 新宽高为 0 说明还没布局完，退回 1 而不是产生 Infinity
    sx: last.width > 0 ? first.width / last.width : 1,
    sy: last.height > 0 ? first.height / last.height : 1,
  }
}

/** 栅格坐标指纹。**只由行列跨度决定，跟数据无关** —— 这是坑 ② 的前提 */
export const posKey = (c: { row: number; col: number; rowSpan: number; colSpan: number }) =>
  `${c.row},${c.col},${c.rowSpan},${c.colSpan}`

/**
 * **坑 ②**：车窗过渡动画**每帧**调 renderDesk()。FLIP 每帧跑会打架，
 * 卡片抖得像坏掉的。只在栅格坐标真变化时触发 —— 纯数据刷新（ETA 从 18 变 17）
 * 位置不变，天然不触发。
 *
 * 没有旧位置（卡刚建出来）也算 noop：新卡走进场动画，不走 FLIP。
 */
export const isNoop = (prev: string | undefined, next: string) => prev === undefined || prev === next

/** 一次移动的完整描述，供 renderDesk 收集后统一提交 */
export interface Move { node: HTMLElement; first: Rect }

/**
 * 提交动画：先把元素按 delta 拉回旧位置（无过渡），下一帧再归零（带过渡）。
 *
 * 两帧是必须的 —— 同一帧里设了 transform 又立刻清掉，浏览器只会看到最终值，
 * 什么都不会动。
 */
export function commitMoves(moves: Move[], scale: number, duration = 380,
                            ease = 'cubic-bezier(.22,.61,.36,1)') {
  const deltas = moves.map(m => ({ m, d: flipDelta(m.first, m.node.getBoundingClientRect(), scale) }))
  for (const { m, d } of deltas) {
    if (!d.dx && !d.dy && d.sx === 1 && d.sy === 1) continue
    m.node.style.transition = 'none'
    m.node.style.transform = `translate(${d.dx}px,${d.dy}px) scale(${d.sx},${d.sy})`
  }
  requestAnimationFrame(() => {
    for (const { m } of deltas) {
      if (!m.node.style.transform) continue
      m.node.style.transition = `transform ${duration}ms ${ease}`
      m.node.style.transform = ''
    }
  })
}
