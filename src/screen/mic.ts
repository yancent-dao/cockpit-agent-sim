/**
 * 麦克风仲裁（语音链路设计 2026-08-18 §1）。
 *
 * 全系统只有一个"麦克风"：谁想出声先过裁判。决策收在这个纯函数里
 * （屏端是所有声音的物理出口，在张嘴的地方做单写者——绘本这类不经
 * pipeline 的声源也漏不掉），执行是 main.ts 里的薄层。
 *
 * 用户开口不在表里——那不是声源，是最高打断力，由 hush 直接清场。
 */

export type MicSource = 'confirm' | 'turn' | 'story' | 'delivery'

/** 数字越小优先级越高。confirm（安全类问题）> 话术 > 绘本 > 后台交付 */
export const PRIORITY: Record<MicSource, number> = {
  confirm: 1, turn: 2, story: 3, delivery: 4,
}

/**
 * 一个出声请求该怎么处置。
 * - 高优先级打断低的（确认问句可以打断绘本页——被打断的页由执行层记着重读）
 * - turn 遇上 story 是唯一的 drop：衔接话术过期即无意义，排队只会在
 *   故事讲完后冒出一句没头没尾的话
 * - 其余低优先级一律排队（delivery 捡空闲说）
 */
export function micAct(req: MicSource, current: MicSource | null): 'speak' | 'interrupt' | 'queue' | 'drop' {
  if (!current) return 'speak'
  // 特例在优先级之前：turn 虽然排位比 story 高，但**不许打断故事**——
  // 画外音把正文顶掉，孩子听到的故事就断了；而过期的衔接话术也不值得排队
  if (req === 'turn' && current === 'story') return 'drop'
  if (PRIORITY[req] < PRIORITY[current]) return 'interrupt'
  return 'queue'
}
