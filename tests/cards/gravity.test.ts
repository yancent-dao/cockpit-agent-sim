import { describe, it, expect, beforeEach } from 'vitest'
import { createDesk } from '../../src/cards/desk'
import { cellsOfTier } from '../../src/config/grid'

/**
 * ══════════ 布局重力：空白聚到右下，不散成一堆洞 ══════════
 *
 * 实拍反馈："整体的卡片布局看起来太散了，没有一定的逻辑"。
 *
 * 机制根因是：布局有**位置粘性**（每张卡优先回到上次的位置，避免乱跳）
 * 但**没有重力** —— 一张卡缩小或关闭之后，它让出的空间成为一个洞，
 * 右边和下面的卡不会流过来补，因为它们都还粘在原位。洞越攒越多，
 * 看起来就是散的。
 *
 * 加一趟**紧凑化**：每张卡尝试挪到"更左上"的合法位置，反复到稳定。
 */

let now = 1000
let desk: ReturnType<typeof createDesk>
const mk = (o: any = {}) => desk.show({ template: 'canvas', size: 'box', ttl: 'untilDismissed', ...o })
beforeEach(() => { now = 1000; desk = createDesk(() => now) })

/**
 * 紧凑化的**真定义**：没有任何一张卡还能挪到更左上的合法位置。
 *
 * 别用"还剩几个洞"来判 —— 洞夹在中间和聚在右下角，洞的**数量**一样，
 * 而那正是"散"和"整齐"的全部区别。第一版测试就是这么假绿的。
 */
const movable = () => {
  const l = desk.layout()
  const g: boolean[][] = Array.from({ length: 8 }, () => Array(12).fill(false))
  for (const c of l.cards)
    for (let r = c.row; r < c.row + c.rowSpan; r++)
      for (let x = c.col; x < c.col + c.colSpan; x++) g[r][x] = true
  const out: string[] = []
  for (const c of l.cards) {
    // 先把这张卡自己挖掉，再看有没有更早的空位放得下
    const clear = (v: boolean) => {
      for (let r = c.row; r < c.row + c.rowSpan; r++)
        for (let x = c.col; x < c.col + c.colSpan; x++) g[r][x] = v
    }
    clear(false)
    const here = c.row * 12 + c.col
    outer: for (let r = 0; r + c.rowSpan <= 8; r += 2) {
      for (let x = 0; x + c.colSpan <= 12; x += 2) {
        if (r * 12 + x >= here) break outer
        let ok = true
        for (let dr = 0; dr < c.rowSpan && ok; dr++)
          for (let dx = 0; dx < c.colSpan && ok; dx++) if (g[r + dr][x + dx]) ok = false
        if (ok) { out.push(`${c.data?.title ?? c.id} 本可挪到 ${r},${x}（现在 ${c.row},${c.col}）`); break outer }
      }
    }
    clear(true)
  }
  return out
}

/** 所有卡片占用单元的总和，用来确认紧凑化没弄丢卡 */
const used = () => desk.layout().cards.reduce((n, c) => n + cellsOfTier(c.size), 0)

describe('关掉中间一张卡，后面的流上来补', () => {
  it('不留可填的洞在已占区之间', () => {
    const ids = []
    for (let i = 0; i < 6; i++) { ids.push(mk({ data: { title: 'C' + i } }).cardId!); now += 10 }
    expect(desk.layout().cards).toHaveLength(6)
    desk.dismiss(ids[1])            // 挖掉第二张，中间出一个洞
    desk.tick()
    expect(desk.layout().cards).toHaveLength(5)
    // 空白必须聚到右下角，不是夹在中间
    expect(movable(), '还有卡能往左上挪 —— 中间留着洞').toEqual([])
  })

  it('紧凑化不会弄丢卡片，也不会改尺寸', () => {
    for (let i = 0; i < 5; i++) { mk({ data: { title: 'C' + i } }); now += 10 }
    const before = used()
    desk.dismiss(desk.layout().cards[0].id)
    desk.tick()
    expect(used()).toBe(before - cellsOfTier('box'))
    for (const c of desk.layout().cards) expect(c.size).toBe('box')
  })
})

describe('没有洞的时候一动不动', () => {
  /**
   * "卡片自己跑了"是最反直觉的体验。紧凑化**只在真有洞时触发** ——
   * 桌面本来就密实的话，位置粘性说了算。
   */
  it('桌面密实时重排不改变任何卡的位置', () => {
    for (let i = 0; i < 6; i++) { mk({ data: { title: 'C' + i } }); now += 10 }
    const before = desk.layout().cards.map(c => `${c.id}@${c.row},${c.col}`).sort()
    desk.tick(); desk.tick()
    expect(desk.layout().cards.map(c => `${c.id}@${c.row},${c.col}`).sort()).toEqual(before)
  })
})

describe('左锚定的卡不被重力拖走', () => {
  it('导航卡始终在左上角', () => {
    mk({ size: 'stage', template: 'nav', kind: 'rule', evictable: false, data: { title: '导航' } })
    now += 10
    const a = mk({ data: { title: 'A' } }).cardId!
    now += 10; mk({ data: { title: 'B' } })
    desk.dismiss(a)
    desk.tick()
    const nav = desk.layout().cards.find(c => c.template === 'nav')!
    expect([nav.row, nav.col]).toEqual([0, 0])
  })
})

describe('稳定性', () => {
  /** 反复 tick 必须收敛，不能来回搬 —— 那在屏幕上就是卡片抖动 */
  it('连续重排收敛到同一个布局', () => {
    for (let i = 0; i < 4; i++) { mk({ data: { title: 'C' + i } }); now += 10 }
    desk.dismiss(desk.layout().cards[1].id)
    desk.tick()
    const a = desk.layout().cards.map(c => `${c.id}@${c.row},${c.col}`).sort()
    for (let i = 0; i < 5; i++) desk.tick()
    expect(desk.layout().cards.map(c => `${c.id}@${c.row},${c.col}`).sort()).toEqual(a)
  })

  it('高优先级的卡仍然排在前面', () => {
    mk({ data: { title: '低' } }); now += 10
    mk({ kind: 'system', data: { title: '高' } }); now += 10
    desk.tick()
    const cards = desk.layout().cards
    const hi = cards.find(c => c.data?.title === '高')!
    const lo = cards.find(c => c.data?.title === '低')!
    expect(hi.row * 12 + hi.col).toBeLessThan(lo.row * 12 + lo.col)
  })
})
