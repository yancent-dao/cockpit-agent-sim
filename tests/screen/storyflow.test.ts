import { describe, it, expect } from 'vitest'
import { afterRead, ASK_DELAY_MS } from '../../src/screen/storyflow'

/**
 * ══════════ 共创闭环：读完一章要把话头交回给孩子 ══════════
 *
 * 「一起写这个故事」的落点全在这一步。它必须是**机制**（读完 → 交还控制权），
 * 而**问什么话归模型**（技能包里那句「你觉得后面会发生什么呢」）。
 *
 * 抽成纯函数是因为车机屏那边是 DOM 操作跑不了单测，而这个判断错一次
 * 就是"一章讲完卡在最后一页不动了"或者"每页都问一遍烦死人"。
 */

const at = (page: number, chapterEnd: number, o: any = {}) =>
  afterRead({ page, chapterEnd, total: chapterEnd, phase: 'telling', pending: 0, ...o })

describe('章中：自动翻下一页', () => {
  it('还没到本章最后一页就往下翻', () => {
    expect(at(1, 3)).toEqual({ do: 'advance' })
    expect(at(2, 3)).toEqual({ do: 'advance' })
  })
})

describe('章末：交还控制权', () => {
  it('读完本章最后一页就问孩子', () => {
    expect(at(3, 3).do).toBe('ask')
  })

  /**
   * **停 1 秒再问**。立刻问等于不给回味的时间，孩子答不上来 ——
   * 这一秒是设计的一部分，不是随手加的防抖。
   */
  it('要停一下，不是读完就立刻开口', () => {
    const r = at(3, 3)
    expect(r.do === 'ask' && r.delay).toBe(ASK_DELAY_MS)
    expect(ASK_DELAY_MS).toBeGreaterThanOrEqual(800)
  })
})

describe('图还没画完的时候', () => {
  /**
   * 文字先出、图片后到是设计里的正常状态。但**已经翻到的那页图还没到**时
   * 不该继续往下冲 —— 等一等，让画面追上声音。
   */
  it('下一页的图还在画就先等着，别把孩子甩在没有画面的地方', () => {
    expect(at(1, 3, { pending: 2 })).toEqual({ do: 'wait' })
  })

  it('图追上来了就继续', () => {
    expect(at(1, 3, { pending: 0 })).toEqual({ do: 'advance' })
  })

  /** 章末就算图没画完也要问 —— 提问不需要画面，卡着不动才是最糟的 */
  it('章末不受图影响，照样问', () => {
    expect(at(3, 3, { pending: 5 }).do).toBe('ask')
  })
})

describe('不在讲述状态时什么都不做', () => {
  it('定妆、提问、成书阶段都不触发翻页', () => {
    for (const phase of ['idle', 'cast', 'asking', 'done'])
      expect(afterRead({ page: 1, chapterEnd: 3, total: 3, phase, pending: 0 }), phase)
        .toEqual({ do: 'none' })
  })
})

describe('边界', () => {
  it('没有页的时候不翻也不问', () => {
    expect(afterRead({ page: 0, chapterEnd: 0, total: 0, phase: 'telling', pending: 0 }))
      .toEqual({ do: 'none' })
  })

  /** chapterEnd 缺失（老数据、手改过）时退到"整本的最后一页"，不卡死 */
  it('缺 chapterEnd 时按整本的最后一页算', () => {
    expect(afterRead({ page: 4, total: 4, phase: 'telling', pending: 0 } as any).do).toBe('ask')
    expect(afterRead({ page: 2, total: 4, phase: 'telling', pending: 0 } as any).do).toBe('advance')
  })
})
