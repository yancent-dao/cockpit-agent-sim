import { describe, it, expect } from 'vitest'
import { analyze, type Sample } from '../../src/core/trend'

/**
 * 趋势分析（旅行助手，2026-08-20）。「建议必须带依据」那条 PRD 红线的**机制半边**。
 *
 * ## 这里刻意不做什么
 *
 * 不产出「可以下单」这类**推荐**。分位、极值、方向、离提醒线还差多少——
 * 这些是**事实**，算出来给模型当依据；买不买、要不要提醒用户现在下手，
 * 是策略，归模型。这条线跟 `climate.set 绝不因为外面冷就自己多加两度`
 * 是同一条：Tool 摆事实，Agent 做决定。
 *
 * 分档（低位/偏低/中位/偏高/高位）留在这一层，因为它是**分位数的命名**，
 * 不是建议——跟 navCompareRoutes 给路线打「最快」标签同性质：描述数据，
 * 不替用户拿主意。
 */

const s = (vals: number[]): Sample[] =>
  vals.map((value, i) => ({ at: i * 86_400_000, value }))

describe('极值与中位：曲线的坐标轴靠它', () => {
  it('给出 30 天最低最高中位', () => {
    const r = analyze(s([2400, 2000, 1800, 2200, 2600]))
    expect(r.min).toBe(1800)
    expect(r.max).toBe(2600)
    expect(r.median).toBe(2200)
  })

  it('偶数个样本时中位取中间两个的平均', () => {
    expect(analyze(s([100, 200, 300, 400])).median).toBe(250)
  })

  it('样本为空时不炸，给出空结论——新建的委托还没采过是常态', () => {
    const r = analyze([])
    expect(r.count).toBe(0)
    expect(r.band).toBe('unknown')
    expect(r.direction).toBe('unknown')
  })

  it('只有一个样本：极值就是它，但方向仍是未知——一个点画不出趋势', () => {
    const r = analyze(s([1868]))
    expect(r.min).toBe(1868)
    expect(r.max).toBe(1868)
    expect(r.direction).toBe('unknown')
  })
})

describe('分位与分档：当前值在 30 天里贵不贵', () => {
  it('最低价 = 0 分位 = 低位', () => {
    const r = analyze(s([1800, 2000, 2200, 2400, 2600]), 1800)
    expect(r.percentile).toBeCloseTo(0, 2)
    expect(r.band).toBe('low')
  })

  it('最高价 = 1 分位 = 高位', () => {
    const r = analyze(s([1800, 2000, 2200, 2400, 2600]), 2600)
    expect(r.percentile).toBeCloseTo(1, 2)
    expect(r.band).toBe('high')
  })

  it('正中间 = 中位档', () => {
    const r = analyze(s([1000, 2000, 3000]), 2000)
    expect(r.percentile).toBeCloseTo(0.5, 2)
    expect(r.band).toBe('mid')
  })

  it('不传当前值就用最后一个样本——采样刚写进去，不用调用方再喂一遍', () => {
    const r = analyze(s([2600, 2400, 2200, 2000, 1800]))
    expect(r.current).toBe(1800)
    expect(r.band).toBe('low')
  })

  it('全都一个价时分位不炸（除零）——淡季价格纹丝不动是真会发生的', () => {
    const r = analyze(s([2000, 2000, 2000]), 2000)
    expect(Number.isFinite(r.percentile)).toBe(true)
    expect(r.band).not.toBe('unknown')
  })
})

describe('方向：最近在涨还是在跌', () => {
  it('一路下跌 → falling', () => {
    expect(analyze(s([2600, 2500, 2300, 2100, 1900, 1868])).direction).toBe('falling')
  })

  it('一路上涨 → rising', () => {
    expect(analyze(s([1800, 1900, 2100, 2300, 2500])).direction).toBe('rising')
  })

  it('小幅震荡不算趋势 → flat，别把噪声报成拐点', () => {
    expect(analyze(s([2000, 2010, 1995, 2005, 2000])).direction).toBe('flat')
  })

  it('跟上一个样本的差额单独给出——卡上那个「较昨日」靠它', () => {
    const r = analyze(s([2000, 1954]))
    expect(r.changeFromPrev).toBe(-46)
  })
})

describe('离提醒线还差多少', () => {
  it('低于阈值 → 已达成，差额为负', () => {
    const r = analyze(s([2200, 1868]), undefined, { threshold: 2000, direction: 'below' })
    expect(r.hitThreshold).toBe(true)
    expect(r.toThreshold).toBe(-132)
  })

  it('还没到 → 未达成，差额是还要跌多少', () => {
    const r = analyze(s([2200, 2150]), undefined, { threshold: 2000, direction: 'below' })
    expect(r.hitThreshold).toBe(false)
    expect(r.toThreshold).toBe(150)
  })

  it('方向是 above 时反过来算——汇率盯的是「涨到多少」', () => {
    const r = analyze(s([20500, 20800]), undefined, { threshold: 21000, direction: 'above' })
    expect(r.hitThreshold).toBe(false)
    expect(r.toThreshold).toBe(200)
  })

  it('没设阈值时这两个字段是空的，不是 0——「没设」和「差 0」不是一回事', () => {
    const r = analyze(s([2000]))
    expect(r.hitThreshold).toBeUndefined()
    expect(r.toThreshold).toBeUndefined()
  })
})
