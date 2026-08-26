import { describe, it, expect } from 'vitest'
import { fitScale, MIN_SCALE } from '../../src/screen/overflowgate'

/**
 * ══════════ 生成式卡溢出的第四、第五道闸 ══════════
 *
 * 前三道闸已经有了：消毒白名单 · 像素契约 · 尺寸自愈（升档）。
 * 天花板是**只会升档，升到最大档还溢出就直接裁掉** —— 用户看到的
 * 就是撞上天花板之后的样子。另外自愈只测高度，长表格横向溢出完全不触发。
 *
 * 闸四：整体 `transform: scale()`，溢出从"裁掉一半"变成"整张缩小"，
 *       **信息不丢**，这是关键区别。
 * 闸五：缩不下去就剥到纯文字。**宁可显示得少，不要显示得糊。**
 */

const box = { w: 1000, h: 600 }

describe('装得下就不动', () => {
  it('内容比画布小 —— 不缩放', () => {
    expect(fitScale({ ...box, contentW: 900, contentH: 500 })).toEqual({ do: 'none' })
  })

  it('刚好装下也不动 —— 别为了亚像素舍入去缩', () => {
    expect(fitScale({ ...box, contentW: 1000, contentH: 600 })).toEqual({ do: 'none' })
  })
})

describe('闸四：整体缩放', () => {
  it('高度溢出 → 按高度比缩', () => {
    const r = fitScale({ ...box, contentW: 900, contentH: 750 })
    expect(r.do).toBe('scale')
    expect(r.do === 'scale' && r.scale).toBeCloseTo(600 / 750, 3)
  })

  /** 上一版只测高度，长表格横向溢出完全不触发 */
  it('宽度溢出同样要缩 —— 长表格是横着出界的', () => {
    const r = fitScale({ ...box, contentW: 1250, contentH: 500 })
    expect(r.do).toBe('scale')
    expect(r.do === 'scale' && r.scale).toBeCloseTo(1000 / 1250, 3)
  })

  it('两个方向都溢出时取更小的那个比例', () => {
    const r = fitScale({ ...box, contentW: 1250, contentH: 900 })
    // 宽 0.8、高 0.667 —— 取 0.667，否则另一个方向还是出界
    expect(r.do === 'scale' && r.scale).toBeCloseTo(600 / 900, 3)
  })
})

describe('闸五：缩不下去就换文字', () => {
  /**
   * 缩到 0.65 以下说明模型排了三倍于画布的内容，缩到那个份上也读不了。
   * 剥到纯文字兜底 —— **宁可显示得少，不要显示得糊**。
   */
  it('超过下限就降级为纯文字，不硬缩', () => {
    expect(fitScale({ ...box, contentW: 900, contentH: 1500 })).toEqual({ do: 'text' })
  })

  it('正好在下限上还是缩，不是降级 —— 边界要明确', () => {
    const r = fitScale({ ...box, contentW: 900, contentH: Math.floor(600 / MIN_SCALE) })
    expect(r.do).toBe('scale')
  })

  it('下限不能定得太狠 —— 0.65 已经是能读的底线', () => {
    expect(MIN_SCALE).toBeGreaterThanOrEqual(0.6)
    expect(MIN_SCALE).toBeLessThan(1)
  })
})

describe('坏输入不把卡片带崩', () => {
  it('测不到尺寸时当没溢出', () => {
    expect(fitScale({ w: 0, h: 0, contentW: 100, contentH: 100 })).toEqual({ do: 'none' })
    expect(fitScale({ ...box, contentW: 0, contentH: 0 })).toEqual({ do: 'none' })
  })

  it('负数或 NaN 一律当没溢出', () => {
    expect(fitScale({ ...box, contentW: NaN, contentH: 800 })).toEqual({ do: 'none' })
    expect(fitScale({ ...box, contentW: -5, contentH: -5 })).toEqual({ do: 'none' })
  })
})

/**
 * ══════════ 闸的次序重排：滚动进来，剥文字退到最后 ══════════
 *
 * 实拍（2026-08-14）：研究报告在 canvas 卡里反复溢出，日志刷了几十条
 * 「内容超出部分用户看不到」，子 Agent 一轮轮砍内容，最后用户看到的是
 * 半份报告。产品决策：**能滚就别丢**。
 *
 * 但滚动不是万能钥匙，次序有讲究：
 *   · 轻微溢出（缩一点还能读）→ **缩放**。为 10% 的溢出让用户去滚很烦，
 *     一屏看全永远优于要动手。
 *   · 严重溢出（缩下去就读不了了）→ **滚动**。信息一个字不丢。
 *   · 行驶中不给滚 —— 滚动要眼睛加手，那是 HMI 大忌，退回剥文字。
 *   · 横向严重溢出滚动也救不了（车机上横滚读长表格是灾难）→ 剥文字。
 */
describe('严重溢出：能滚就别丢', () => {
  const tall = { ...box, contentW: 900, contentH: 3000 }   // 纵向三倍，横向没问题

  it('停车时给滚动，不再剥成纯文字', () => {
    expect(fitScale({ ...tall, canScroll: true })).toEqual({ do: 'scroll' })
  })

  it('行驶中不给滚 —— 滚动要眼睛加手', () => {
    expect(fitScale({ ...tall, canScroll: false })).toEqual({ do: 'text' })
  })

  it('不说能不能滚时按不能算 —— 安全侧默认', () => {
    expect(fitScale(tall)).toEqual({ do: 'text' })
  })

  /** 轻微溢出仍然缩放：为一点点溢出让用户去滚是倒退 */
  it('缩一缩就能读的，还是缩，不劳烦用户滚', () => {
    const r = fitScale({ ...box, contentW: 900, contentH: 750, canScroll: true })
    expect(r.do).toBe('scale')
  })

  /**
   * 横向严重溢出滚动救不了 —— 车机上横着滚读长表格是灾难，
   * 而且一行读一半再横滚回来，比看不全更糟。
   */
  it('横向严重溢出照样剥文字，滚动只管纵向', () => {
    expect(fitScale({ ...box, contentW: 4000, contentH: 500, canScroll: true }))
      .toEqual({ do: 'text' })
  })

  it('横纵都严重溢出也剥文字', () => {
    expect(fitScale({ ...box, contentW: 4000, contentH: 3000, canScroll: true }))
      .toEqual({ do: 'text' })
  })

  it('装得下的时候 canScroll 不改变任何事', () => {
    expect(fitScale({ ...box, contentW: 900, contentH: 500, canScroll: true })).toEqual({ do: 'none' })
  })
})

describe('stickyClasses：渲染器后加的状态类在 className 单写者重写时保留（2026-08-25 实拍：生成式卡滑动只有第一次有效——cvscroll 被 4 秒心跳抹掉，同 is-video 先例）', () => {
  it('存在的保留、不存在的不凭空加', async () => {
    const { stickyClasses } = await import('../../src/screen/overflowgate')
    const has = (n: string) => n === 'cvscroll'
    expect(stickyClasses(has, ['cvscroll', 'cvend', 'fresh'])).toBe(' cvscroll')
    expect(stickyClasses(() => false, ['cvscroll', 'cvend'])).toBe('')
  })
})
