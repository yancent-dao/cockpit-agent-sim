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
