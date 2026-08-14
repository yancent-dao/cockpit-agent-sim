import { describe, it, expect } from 'vitest'
import {
  GRID, TIERS, ALIAS, normalizeTier, dimsOf, cellsOfTier, tierNames, pixelsOf, boxOf,
  contentCols, listCols, listCapacity,
} from '../../src/config/grid'

/**
 * ══════════ 栅格 12×4 → 12×8（2026-08-14 重设计） ══════════
 *
 * ## 为什么改
 *
 * 12 列是对的（能被 2/3/4/6 整除，6+6 · 4+4+4 · 2×6 三种分栏同时成立），
 * **4 行是错的**：横轴有 6 个宽度档，纵轴只有 3 个高度档（231/486/996），
 * 而且 486 → 996 是个 2 倍跳跃，中间什么都没有。
 *
 * 后果具体到能指出来：宽高比 1.63 那一族只有 box(4×2) 和 stage(8×4) 两级，
 * 中间那级不存在。于是"播放器中档不合理""导航中档太空""大量空白"
 * ——三个抱怨是同一件事：**中档没有合适的形状可选**，只能在"压扁"
 * 和"高度翻倍留白"之间二选一。
 *
 * ## 为什么是 8 而不是别的
 *
 * 8 = 2×4，所以旧的每个高度都能被整除保留（下面第一组断言就是这个）。
 * 12×5 单元格能变正方（181×180）但 5 是奇数没法对半分；
 * 12×6 高度档只有三级还跟已有像素全对不上；
 * 12×12 太细，偶数跨度下反而拿不到 231 和 741。
 * **8 是唯一既向后兼容又真正加档的行数。**
 *
 * ## 不变量变简单了
 *
 * 以前列是「偶数宽 + 偶数起点」、行是「高度只取 1/2/4 且按自身高度对齐」两套规则；
 * 现在两个轴同一条：**跨度取偶数、起点取偶数、最小 2×2**。
 */

/**
 * 迁移前（12×4）各档位的**画布**像素 —— 手抄下来当基准，不从新代码算。
 * 这些数字进过生成式卡的模板描述，模型见过，改了就是所有排版一夜错位。
 */
const LEGACY_CANVAS = {
  chip:  { w: 335,  h: 187 },   // 旧 2×1
  strip: { w: 745,  h: 187 },   // 旧 4×1
  bar:   { w: 1156, h: 187 },   // 旧 6×1
  box:   { w: 745,  h: 442 },   // 旧 card 4×2（别名 1/6）
  wide:  { w: 1156, h: 442 },   // 旧 6×2
  panel: { w: 1567, h: 442 },   // 旧 8×2（别名 1/3）
  band:  { w: 2388, h: 442 },   // 旧 banner 12×2（别名 1/2）
  tower: { w: 745,  h: 952 },   // 旧 4×4
  stage: { w: 1567, h: 952 },   // 旧 8×4（别名 2/3）
  full:  { w: 2388, h: 952 },   // 旧 12×4
} as const

describe('栅格改成 12×8', () => {
  it('12 列 × 8 行 = 96 单元', () => {
    expect(GRID.cols).toBe(12)
    expect(GRID.rows).toBe(8)
  })

  /**
   * **迁移唯一需要的保险。** 改的是坐标刻度不是卡片大小 ——
   * 每个已有档位的真实像素必须一个不差，否则所有排版一夜之间全错位。
   */
  it('已有档位的画布像素一个不差', () => {
    for (const [name, px] of Object.entries(LEGACY_CANVAS)) {
      const now = pixelsOf(name)
      expect(now.w, `${name} 宽`).toBe(px.w)
      expect(now.h, `${name} 高`).toBe(px.h)
    }
  })

  it('外框高度只剩 231 / 486 / 741 / 996 四档，741 是新增的那档', () => {
    const heights = [...new Set(tierNames().map(n => boxOf(n).h))].sort((a, b) => a - b)
    expect(heights).toEqual([231, 486, 741, 996])
  })

  it('画布 = 外框减掉两侧内边距', () => {
    for (const n of tierNames()) {
      expect(pixelsOf(n).w).toBe(boxOf(n).w - 52)
      expect(pixelsOf(n).h).toBe(boxOf(n).h - 44)
    }
  })
})

describe('形状表', () => {
  it('十四个形状，按占用单元数升序声明', () => {
    expect(tierNames()).toEqual([
      'chip', 'strip', 'tile', 'bar', 'box', 'frame', 'wide',
      'panel', 'tower', 'hall', 'band', 'court', 'stage', 'full',
    ])
    const cells = tierNames().map(cellsOfTier)
    for (let i = 1; i < cells.length; i++)
      expect(cells[i], `${tierNames()[i]} 不该小于 ${tierNames()[i - 1]}`).toBeGreaterThanOrEqual(cells[i - 1])
  })

  it('新增的四个形状各就各位', () => {
    expect(dimsOf('tile')).toEqual([2, 4])    // 387×486 · 0.80 小竖块
    expect(dimsOf('frame')).toEqual([4, 6])   // 797×741 · 1.08 全表最接近正方
    expect(dimsOf('hall')).toEqual([6, 6])    // 1208×741 · 1.63 缺的那个中档
    expect(dimsOf('court')).toEqual([6, 8])   // 1208×996 · 1.21 竖版大块
  })

  /**
   * 不变量：**两个轴同一条规则**。跨度偶数 + 起点偶数 ⇒ 任何空隙的宽高都是偶数，
   * 最小的 2×2 永远填得上，不出现死缝。
   */
  it('宽和高都是偶数 —— 死缝的根，两个轴同一条规则', () => {
    for (const [n, t] of Object.entries(TIERS)) {
      expect(t.w % 2, `${n} 宽 ${t.w}`).toBe(0)
      expect(t.h % 2, `${n} 高 ${t.h}`).toBe(0)
    }
  })

  it('最小的卡是 2×2，没有更薄的', () => {
    for (const [n, t] of Object.entries(TIERS)) {
      expect(t.w, `${n} 宽`).toBeGreaterThanOrEqual(2)
      expect(t.h, `${n} 高`).toBeGreaterThanOrEqual(2)
    }
  })

  it('没有档位超出栅格', () => {
    for (const [n, t] of Object.entries(TIERS)) {
      expect(t.w, `${n}.w`).toBeLessThanOrEqual(GRID.cols)
      expect(t.h, `${n}.h`).toBeLessThanOrEqual(GRID.rows)
    }
  })

  /**
   * 相似族：宽高比 1.63 的四个形状共用**骨架**（哪些块、怎么摆），
   * 但内容密度必须各不相同 —— 这条在形态函数那边测，这里只锁几何。
   */
  it('chip / box / hall / stage 是宽高比几乎相同的相似族', () => {
    const r = (n: string) => { const p = boxOf(n); return p.w / p.h }
    for (const n of ['chip', 'box', 'hall', 'stage'])
      expect(r(n), `${n} 比 ${r(n).toFixed(3)}`).toBeCloseTo(1.64, 1)
  })

  it('frame 是全表最接近正方形的形状', () => {
    const off = (n: string) => { const p = boxOf(n); return Math.abs(p.w / p.h - 1) }
    const best = tierNames().reduce((a, b) => (off(a) <= off(b) ? a : b))
    expect(best).toBe('frame')
  })
})

/**
 * 老尺寸名要继续能用 —— 几百个老测试和已有 cardRules 靠它。
 * 分数名（'1/6' 这些）从**配置里**清掉了，但别名表得留着。
 */
describe('别名：分数名与旧档位名都还能用', () => {
  it('分数名映射到形状名', () => {
    expect(normalizeTier('1/6')).toBe('box')
    expect(normalizeTier('1/3')).toBe('panel')
    expect(normalizeTier('1/2')).toBe('band')
    expect(normalizeTier('2/3')).toBe('stage')
  })

  it('改名前的档位名也认', () => {
    expect(normalizeTier('card')).toBe('box')
    expect(normalizeTier('banner')).toBe('band')
  })

  it('认不出来的退到基准档 —— 一个错名字不该让整张卡不显示', () => {
    expect(normalizeTier('不存在的档')).toBe('box')
  })

  it('别名指向的都是真档位', () => {
    for (const [from, to] of Object.entries(ALIAS))
      expect(TIERS, `${from} → ${to} 指向了不存在的档位`).toHaveProperty(to)
  })
})

/**
 * 分栏分两套。**列表类最多 2 栏** —— 横向多栏的编号列表反而更难扫，
 * 眼睛要在几列之间来回跳；而对比卡、逐时预报这类"从左往右比"的内容
 * 栏数越多越好。阅读方向决定分栏上限。
 */
describe('分栏', () => {
  it('通用内容按宽度给 1/2/3/4 栏', () => {
    expect(contentCols(2)).toBe(1)
    expect(contentCols(4)).toBe(1)
    expect(contentCols(6)).toBe(2)
    expect(contentCols(8)).toBe(3)
    expect(contentCols(12)).toBe(4)
  })

  it('列表类最多 2 栏', () => {
    expect(listCols(4)).toBe(1)
    expect(listCols(6)).toBe(2)
    expect(listCols(8)).toBe(2)
    expect(listCols(12)).toBe(2)
  })
})

describe('列表容量', () => {
  it('高度不足一张标准卡时放不下带副标题的条目', () => {
    expect(listCapacity(4, 2)).toBe(0)   // strip 797×231
    expect(listCapacity(6, 2)).toBe(0)   // bar 1208×231
  })

  it('列表三档的条数：4 → 8 → 16', () => {
    expect(listCapacity(...dimsOf('box'))).toBe(4)      // 4×4 单栏
    expect(listCapacity(...dimsOf('tower'))).toBe(8)    // 4×8 单栏
    expect(listCapacity(...dimsOf('court'))).toBe(16)   // 6×8 双栏
  })
})

/**
 * 生成式卡要把**当前卡片的真实像素**告诉模型（「你拿到一块 745×442 的画布，
 * 不能滚动，超出会被裁掉」）。不给这个数字它必然溢出 ——
 * 它没有别的办法知道自己有多大。
 */
describe('像素契约', () => {
  it('每个形状都算得出正数画布', () => {
    for (const n of tierNames()) {
      expect(pixelsOf(n).w, `${n} 宽`).toBeGreaterThan(0)
      expect(pixelsOf(n).h, `${n} 高`).toBeGreaterThan(0)
    }
  })

  it('形状越大画布越大', () => {
    expect(pixelsOf('stage').w).toBeGreaterThan(pixelsOf('box').w)
    expect(pixelsOf('full').h).toBeGreaterThan(pixelsOf('band').h)
    expect(pixelsOf('hall').h).toBeGreaterThan(pixelsOf('wide').h)
  })

  it('full 的宽度接近整个桌面区（差的是左右 padding）', () => {
    expect(pixelsOf('full').w).toBeGreaterThan(2200)
    expect(pixelsOf('full').w).toBeLessThan(2450)
  })

  // 跨列的卡片把中间的 gap 也吃掉了，不算的话报给模型的数字会偏小一大截
  it('跨列时把中间的 gap 算进去', () => {
    expect(pixelsOf('panel').w).toBeGreaterThan(pixelsOf('box').w * 2)
  })

  it('别名同样能查', () => {
    expect(pixelsOf('2/3')).toEqual(pixelsOf('stage'))
    expect(pixelsOf('card')).toEqual(pixelsOf('box'))
  })

  it('新名字原样返回', () => {
    for (const n of tierNames()) expect(normalizeTier(n), n).toBe(n)
  })
})
