/**
 * 绘本的朗读推进决策 —— 纯函数，机制不是策略。
 *
 * 一页念完之后该做什么：往下翻、等画面追上来、还是把话头交回给孩子。
 * **问什么话归模型**（技能包里那句「你觉得后面会发生什么呢，我们一起来写」），
 * 这里只回答「现在该轮到谁开口」。
 *
 * 抽成纯函数是因为车机屏那边是 DOM 操作跑不了单测，而这个判断错一次就是
 * "一章讲完卡在最后一页不动了"或者"每页都问一遍烦死人"。
 */

/**
 * 读完最后一页到开口提问之间的停顿。
 *
 * **这一秒是设计的一部分，不是随手加的防抖。** 立刻问等于不给回味的时间，
 * 孩子答不上来 —— 大人给小孩讲完一段也会停一下再问"你猜后来呢"。
 */
export const ASK_DELAY_MS = 1000

export interface ReadState {
  /** 当前第几页（1 开始） */
  page: number
  /** 本章最后一页是第几页。缺失时退到整本的最后一页 */
  chapterEnd?: number
  /** 整本共几页 */
  total: number
  /** story.phase */
  phase: string
  /** 还有几页在画 */
  pending: number
}

export type ReadNext =
  | { do: 'none' }
  | { do: 'advance' }
  | { do: 'wait' }
  | { do: 'ask'; delay: number }

export function afterRead(s: ReadState): ReadNext {
  // 只有正在讲述时才推进。定妆、提问、成书都是别人在主导
  if (s.phase !== 'telling' || !s.page || !s.total) return { do: 'none' }

  const end = s.chapterEnd || s.total
  /**
   * 章末：把话头交回去。**就算图还没画完也要问** ——
   * 提问不需要画面，卡着不动才是最糟的。
   */
  if (s.page >= end) return { do: 'ask', delay: ASK_DELAY_MS }

  /**
   * 章中但下一页的图还在画：等一等，让画面追上声音。
   * 文字先出、图片后到是设计里的正常状态，但**已经翻过去却没有画面**
   * 会让孩子对着一块空白听故事。
   */
  if (s.pending > 0) return { do: 'wait' }

  return { do: 'advance' }
}
