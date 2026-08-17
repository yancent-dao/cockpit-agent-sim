import { describe, it, expect } from 'vitest'
import { hourlyView } from '../../src/screen/render'

/**
 * ══════════ 逐时柱要能读，不是六个色块 ══════════
 *
 * 实拍（2026-08-17）：用户「要最详细的」，看到的是 6 个几乎一样高的蓝方块。
 * 根因是柱高用**绝对温度**线性映射（temp×2.6%）—— 成都今天 22.4/22.5/22.6°，
 * 三根柱子差 0.5%，肉眼看不出；又全在下雨，全蓝。
 *
 * 天气 App 的通行做法：**按当日温差归一化**（最冷→矮、最热→高），
 * 每根标时间和度数 —— 柱子才从装饰变成信息。
 */
const h = (time: string, temp: number, pop = 0) => ({ time, temp, pop, weather: '' })

describe('柱高按当日温差归一化', () => {
  it('最冷最矮、最热最高，中间按比例', () => {
    const v = hourlyView([h('T11:00', 20), h('T12:00', 25), h('T13:00', 30)])
    expect(v[0].pct).toBeLessThan(v[1].pct)
    expect(v[1].pct).toBeLessThan(v[2].pct)
    expect(v[2].pct - v[0].pct, '温差要拉满可视范围').toBeGreaterThan(40)
  })

  /** 实拍那天的样子：温度几乎不变。全贴地或全顶天都难看，取中 */
  it('全天温度几乎一样时柱子取中，不贴地不顶天', () => {
    const v = hourlyView([h('T11:00', 22.4), h('T12:00', 22.5), h('T13:00', 22.6)])
    for (const b of v) {
      expect(b.pct).toBeGreaterThan(30)
      expect(b.pct).toBeLessThan(80)
    }
  })

  it('柱高永远在可视区间内 —— 顶部要留给温度数字', () => {
    const v = hourlyView([h('T11:00', -10), h('T12:00', 40)])
    expect(v[0].pct).toBeGreaterThanOrEqual(20)
    expect(v[1].pct).toBeLessThanOrEqual(95)
  })
})

describe('每根柱子带时间和度数', () => {
  it('第一根标「现在」，其余标钟点', () => {
    const v = hourlyView([h('2026-08-17T11:00', 22), h('2026-08-17T12:00', 23), h('2026-08-17T14:00', 24)])
    expect(v[0].label).toBe('现在')
    expect(v[1].label).toBe('12时')
    expect(v[2].label).toBe('14时')
  })

  it('温度取整带度号', () => {
    expect(hourlyView([h('T11:00', 22.6)])[0].temp).toBe('23°')
  })

  it('降水概率 ≥40 标湿', () => {
    const v = hourlyView([h('T11:00', 22, 80), h('T12:00', 22, 10)])
    expect(v[0].wet).toBe(true)
    expect(v[1].wet).toBe(false)
  })
})

describe('坏数据不崩', () => {
  it('空数组返回空', () => {
    expect(hourlyView([])).toEqual([])
  })
  it('缺字段的条目跳过', () => {
    const v = hourlyView([h('T11:00', 22), { time: 'T12:00' } as any, null as any])
    expect(v).toHaveLength(1)
  })
})
