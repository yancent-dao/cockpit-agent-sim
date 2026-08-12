import { describe, it, expect } from 'vitest'
import { GRID, TIERS, LADDER, ALIAS, normalizeTier, dimsOf, cellsOfTier, tierNames } from '../../src/config/grid'

/**
 * 栅格与档位常量的**唯一出处**。
 *
 * 之前同一套数字抄了 5 份：desk.ts 的 ROWS/COLS、desk.ts 的 SHAPES、desk.ts 的 CELLS、
 * main.ts 的 occupied[2][3]、screen.html 的 repeat(3,1fr)。改栅格要同时改 5 处，
 * 漏一处就是"卡片算得下但画不出来"。
 */

describe('栅格', () => {
  it('12 列 × 4 行 = 48 单元', () => {
    expect(GRID.cols).toBe(12)
    expect(GRID.rows).toBe(4)
  })
})

describe('档位表', () => {
  it('十档齐全', () => {
    expect(tierNames()).toEqual(
      ['chip', 'strip', 'bar', 'card', 'wide', 'panel', 'banner', 'tower', 'stage', 'full'])
  })

  it('没有档位超出栅格', () => {
    for (const [n, t] of Object.entries(TIERS)) {
      expect(t.w, `${n}.w`).toBeLessThanOrEqual(GRID.cols)
      expect(t.h, `${n}.h`).toBeLessThanOrEqual(GRID.rows)
      expect(t.w, `${n}.w`).toBeGreaterThan(0)
      expect(t.h, `${n}.h`).toBeGreaterThan(0)
    }
  })

  /**
   * 不变量 ①：所有档位宽度为偶数。
   * 配合"列起点只取偶数"，空隙必为偶数宽，chip（宽 2）永远填得上 —— **不出现死缝**。
   * 之前 3 列栅格下 2/3 卡占 2 列，剩 1 列放不下横向 1/3，整张卡出不来。
   */
  it('宽度一律偶数 —— 死缝的根', () => {
    for (const [n, t] of Object.entries(TIERS)) expect(t.w % 2, `${n} 宽 ${t.w}`).toBe(0)
  })

  it('高度只有 1 / 2 / 4 三种 —— 3 会跟半高档错位', () => {
    for (const [n, t] of Object.entries(TIERS)) expect([1, 2, 4], `${n} 高 ${t.h}`).toContain(t.h)
  })

  it('降级阶梯从小到大严格递增，且都是通用档', () => {
    const cells = LADDER.map(n => cellsOfTier(n))
    for (let i = 1; i < cells.length; i++)
      expect(cells[i], `${LADDER[i]} 应大于 ${LADDER[i - 1]}`).toBeGreaterThan(cells[i - 1])
  })

  // tower/stage/full 是专用档：导航要 stage、车身图要 tower。不该被自动降级路过
  it('专用档不进阶梯', () => {
    for (const n of ['tower', 'stage', 'full']) expect(LADDER).not.toContain(n as any)
  })
})

/**
 * 别名是老尺寸名继续能用的关键。对外仍可写 '1/6'、'2/3'，内部一律新名字。
 * 漏一个入口，几百个老测试和已有的 cardRules 全红。
 */
describe('别名双向解析', () => {
  it('五个老名字都认得', () => {
    expect(normalizeTier('1/6')).toBe('card')
    expect(normalizeTier('1/3')).toBe('panel')
    expect(normalizeTier('1/2')).toBe('banner')
    expect(normalizeTier('2/3')).toBe('stage')
    expect(normalizeTier('full')).toBe('full')
  })

  it('新名字原样返回', () => {
    for (const n of tierNames()) expect(normalizeTier(n), n).toBe(n)
  })

  it('认不出来的退到 card —— 不能因为一个错名字整张卡不显示', () => {
    expect(normalizeTier('巨大')).toBe('card')
    expect(normalizeTier('')).toBe('card')
  })

  it('别名表里的档位都真实存在', () => {
    for (const [a, t] of Object.entries(ALIAS)) expect(TIERS[t], `${a}→${t}`).toBeTruthy()
  })

  it('dimsOf 对别名和新名字给同一个答案', () => {
    expect(dimsOf('2/3')).toEqual(dimsOf('stage'))
    expect(dimsOf('1/6')).toEqual([4, 2])
  })
})

describe('cellsOfTier：占几个单元', () => {
  it('按宽 × 高算', () => {
    expect(cellsOfTier('card')).toBe(8)
    expect(cellsOfTier('full')).toBe(GRID.cols * GRID.rows)
  })

  it('full 正好铺满一屏', () => {
    expect(cellsOfTier('full')).toBe(48)
  })
})
