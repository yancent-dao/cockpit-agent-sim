/**
 * 横幅通道 —— 第二条显示通道，锚定桌面区顶部，一次一条排队。
 *
 * 诊断 6：拒绝原因、约束不满足、能力缺失、卡片被挤出的告知，
 * 现在全靠往桌面塞一张卡。一句话的提示占掉 1/6 桌面，而且跟正经内容卡
 * 长得一样，用户分不出「这是结果」还是「这是解释」。
 *
 * 这里只有队列逻辑，不碰 DOM —— 车机屏那边跑不了单测，但
 * 「三条提示同时来该显示哪条」这件事必须可测。
 */

export interface Banner {
  text: string
  /** 标题行，可省 */
  title?: string
  /** 语义色。不给就按 reason 查 toneOf */
  tone?: 'danger' | 'warn' | 'info' | 'ok'
  /** 停留多久（毫秒）。不给就一直挂着，等下一条来才换 */
  ttl?: number
  /** 插队到最前面。安全相关的横幅在队尾等着不可接受 */
  jump?: boolean
}

/**
 * 原因 → 语义色。
 *
 * 诊断 5 的另一半：这四种现在全是橙色，用户分不出
 * 「不让做」「条件不满足」「顺手告诉你一声」「做完了」。
 */
const TONE: Record<string, Banner['tone']> = {
  rejected: 'danger',      // 不让做（黑名单、约束 reject）
  constraint: 'warn',      // 条件不满足（车速、挡位）——跟"不让做"不是一回事
  limited: 'warn',
  evicted: 'info',         // 卡片被挤出的告知，不是错误
  unsupported: 'info',     // 能力缺失
  done: 'ok',
}
/** 认不出的退到 info —— 误报成红色比不报更糟 */
export const toneOf = (reason?: string): Banner['tone'] => TONE[reason ?? ''] ?? 'info'

export interface BannerHost {
  show: (b: Banner) => void
  hide: () => void
  clock?: () => number
}

export function createBannerQueue(host: BannerHost) {
  const clock = host.clock ?? Date.now
  const queue: Banner[] = []
  let current: Banner | null = null
  let shownAt = 0

  const advance = () => {
    const next = queue.shift()
    // 换条也要先收再放：横幅有进场动画，直接换文字不会重播，
    // 用户会以为还是刚才那条没消失
    if (current) host.hide()
    if (!next) { current = null; if (!current) host.hide(); return }
    current = next
    shownAt = clock()
    host.show(next)
  }

  return {
    push(b: Banner) {
      // 同一条原因反复触发（用户连着说三次"开窗"都被同一条约束拦下）不该排三条队 ——
      // 那会让他等 9 秒才看到别的
      const same = (x: Banner) => x.text === b.text && x.title === b.title
      if (current && same(current)) return
      if (queue.some(same)) return
      if (b.jump) queue.unshift(b); else queue.push(b)
      if (!current) advance()
    },
    /** 由 rAF 或定时器驱动：到点就让位给下一条 */
    tick() {
      if (!current?.ttl) return
      if (clock() - shownAt >= current.ttl) advance()
    },
    clear() {
      queue.length = 0
      current = null
      host.hide()
    },
    pending: () => queue.length,
    current: () => current,
  }
}
