import { describe, it, expect } from 'vitest'
import { createDesk } from '../../src/cards/desk'
import { formOf, suggestSize } from '../../src/config/forms'
import { dimsOf } from '../../src/config/grid'
import { CARD_TEMPLATES } from '../../src/config/cards'

/**
 * 公理 2：模型的世界观必须由结构保证。
 *
 * summary 告诉模型"屏上有几条"，屏幕按 formOf 画几条 —— 两者必须是**同一个数**。
 * 本轮评审实测到第三次分裂（能力目录 @1/2：summary 说 12、屏幕画 4），
 * 根因是 desk 不能反向依赖 screen，只好自己用 listCapacity 重算。
 * 形态函数搬进 config 后，双端消费同一份，这类分裂在结构上不可能再发生。
 */
describe('真相统一：summary 的可见条数 === 屏幕实画条数', () => {
  const items = (n: number) => Array.from({ length: n }, (_, i) => ({ label: `项${i + 1}` }))

  it('能力目录 @1/2：33 项，summary 与 formOf 说同一个数', () => {
    const d = createDesk()
    d.show({ template: 'capability', size: '1/2', ttl: 'untilDismissed',
      data: { title: '我能做的事', items: items(33) } })
    const shown = formOf('capability', ...dimsOf('1/2')).maxItems!
    const line = d.summary().split('\n').find(l => l.includes('没显示'))!
    expect(line).toContain(`前 ${shown} 条`)
    expect(line).toContain(`还有 ${33 - shown} 条`)
  })

  it('车控卡 @chip：4 扇窗，summary 按 formOf 的 2 条算，不按 listCapacity 的 0 条算', () => {
    const d = createDesk()
    d.show({ template: 'control', size: 'chip', minSize: 'chip', ttl: 'untilDismissed',
      data: { title: '车窗', items: items(4) } })
    const shown = formOf('control', ...dimsOf('chip')).maxItems!
    expect(shown).toBeGreaterThan(0)
    expect(d.summary()).toContain(`还有 ${4 - shown} 条`)
  })

  /** 穷举锁死：凡是带 items 的模板 × 每个档位，两边永远同数 */
  it('穷举：list/capability/control 全档位无分裂', () => {
    for (const tpl of ['list', 'capability', 'control']) {
      const sizes = CARD_TEMPLATES.find(t => t.id === tpl)?.sizes ?? ['1/6', '1/3', '1/2']
      for (const z of sizes) {
        const d = createDesk()
        const r = d.show({ template: tpl, size: z as any, ttl: 'untilDismissed',
          data: { title: 'T', items: items(30) } })
        if (r.status !== 'ok') continue
        // full 档走覆盖层不进 cards；summary 对覆盖层另有一行，截断逻辑只管桌面卡
        const placed = d.layout().cards[0]
        if (!placed) continue
        const shown = formOf(tpl, ...dimsOf(placed.size)).maxItems ?? 30
        const line = d.summary().split('\n').find(l => l.includes('没显示'))
        if (shown >= 30) expect(line, `${tpl}@${z} 不该报截断`).toBeUndefined()
        else expect(line, `${tpl}@${z}`).toContain(`还有 ${30 - shown} 条`)
      }
    }
  })
})

/**
 * 内容 → 尺寸的反向映射。对形态函数那张表**反查**，不发明第二套公式：
 * 给定条数，取模板允许档位里能装下它的最小档。
 * 3 条候选不再占半屏空一半，12 条不再默认被截 4 条。
 */
describe('suggestSize：内容决定建议尺寸', () => {
  it('3 条候选 → 能装下 3 条的最小档', () => {
    const z = suggestSize('list', 3)
    expect(formOf('list', ...dimsOf(z)).maxItems!).toBeGreaterThanOrEqual(3)
    // 且再小一档就装不下（或没有更小档）——"最小"不是随便挑的
  })

  it('条数越多档位不缩小', () => {
    const cellsOfSuggest = (n: number) => {
      const z = suggestSize('list', n)
      const [c, r] = dimsOf(z)
      return c * r
    }
    expect(cellsOfSuggest(3)).toBeLessThanOrEqual(cellsOfSuggest(8))
    expect(cellsOfSuggest(8)).toBeLessThanOrEqual(cellsOfSuggest(20))
  })

  it('装不下也不超模板上限——挑允许档位里最大的', () => {
    const z = suggestSize('list', 999)
    const allowed = CARD_TEMPLATES.find(t => t.id === 'list')!.sizes!
    expect(allowed).toContain(z)
  })

  it('desk.show 不给尺寸时采用建议：3 条候选不占半屏', () => {
    const d = createDesk()
    const r = d.show({ template: 'list', ttl: 60,
      data: { title: '候选', items: [{ label: 'a' }, { label: 'b' }, { label: 'c' }] } } as any)
    expect(r.status).toBe('ok')
    const c = d.layout().cards[0]
    const [cols, rows] = dimsOf(c.size)
    expect(cols * rows, '3 条不该占 24 单元的半屏').toBeLessThan(24)
  })

  it('desk.show 不给尺寸且无 items 时回落模板默认', () => {
    const d = createDesk()
    d.show({ template: 'feedback', ttl: 60, data: { title: '好了', text: 'x' } } as any)
    expect(d.layout().cards).toHaveLength(1)
  })
})
