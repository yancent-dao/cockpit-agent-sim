import { describe, it, expect, beforeEach } from 'vitest'
import { cardBody, listBody } from '../../src/screen/render'
import { createDesk } from '../../src/cards/desk'

const V = (template: string, data: any, size = 'card') => ({ template, size, title: data.title ?? '', data } as any)

/**
 * 诊断 8：generic 模板声明 data:{title,text,items?,actions?}，
 * 但渲染的 default 分支只画 text，items 和 actions 被静默吞掉。
 * **这是 bug 不是设计问题** —— 不修的话模型会因为 generic 不好用而滥用 canvas。
 */
describe('generic 卡不再丢数据', () => {
  it('渲染 items', () => {
    const h = cardBody(V('generic', { text: '开头', items: [{ label: '甲', value: '1' }, { label: '乙', value: '2' }] }))
    expect(h).toContain('甲')
    expect(h).toContain('乙')
  })

  it('渲染 actions', () => {
    const h = cardBody(V('generic', { text: 'x', actions: ['确认', '取消'] }))
    expect(h).toContain('确认')
    expect(h).toContain('取消')
  })

  it('只给 text 时照常渲染，不因为补了 items 就退化', () => {
    expect(cardBody(V('generic', { text: '就一句话' }))).toContain('就一句话')
  })

  it('三样都给时都在', () => {
    const h = cardBody(V('generic', { text: 'T', items: [{ label: 'I' }], actions: ['A'] }))
    for (const s of ['T', 'I', 'A']) expect(h, s).toContain(s)
  })

  it('转义用户内容，模型吐出的尖括号不能变成标签', () => {
    const h = cardBody(V('generic', { text: '<img src=x onerror=alert(1)>' }))
    expect(h).not.toContain('<img')
    expect(h).toContain('&lt;img')
  })
})

/**
 * 诊断 7：`.listcard{overflow:auto}` 但屏幕 cursor:none 不可交互，滚不了。
 * 12 条候选放进小卡，第 4 条之后用户永远不知道存在。
 */
describe('列表截断与「还有 N 条」', () => {
  const items = Array.from({ length: 12 }, (_, i) => ({ label: `选项${i + 1}`, sub: `说明${i + 1}` }))

  it('超过上限就截断，不靠滚动', () => {
    const h = listBody(items, { maxItems: 4 })
    expect(h).toContain('选项4')
    expect(h).not.toContain('选项5')
  })

  it('截断后必须写明还剩几条 —— 否则用户永远不知道有第 5 条', () => {
    expect(listBody(items, { maxItems: 4 })).toContain('8')
  })

  it('没超上限就不出这行', () => {
    expect(listBody(items.slice(0, 3), { maxItems: 4 })).not.toMatch(/还有/)
  })

  it('count 策略只报数量，一条都不列 —— chip 档放不下选项', () => {
    const h = listBody(items, { maxItems: 0, overflow: 'count' })
    expect(h).toContain('12')
    expect(h).not.toContain('选项1')
  })

  // 序号由 CSS counter 生成（<ol> + counter-increment），DOM 里没有数字文本。
  // 这是对的做法——截断后编号自动连续，不用手动算
  it('用 <ol> 让序号由 CSS 连续生成，截断后不会跳号', () => {
    const h = listBody(items, { maxItems: 3 })
    expect(h).toContain('<ol')
    expect((h.match(/<li>/g) ?? []).length).toBe(3)
  })
})

/**
 * 「还有 N 条」不只是 UI —— 必须同时回给 Agent。
 * 否则模型以为屏上有 12 条、张口就说「第 10 个」，用户根本看不到。
 */
describe('溢出信息进 desk.summary()', () => {
  let desk: ReturnType<typeof createDesk>
  beforeEach(() => { desk = createDesk() })

  it('卡片带 moreCount 时，summary 说得出还有几条没显示', () => {
    desk.show({
      template: 'list', size: '1/3', ttl: 120,
      data: { title: '附近充电站', items: [{ label: 'a' }], moreCount: 8 },
    })
    expect(desk.summary()).toContain('8')
  })

  it('没有溢出就不提', () => {
    desk.show({ template: 'list', size: '1/3', ttl: 120, data: { title: '候选', items: [{ label: 'a' }] } })
    expect(desk.summary()).not.toMatch(/没显示/)
  })
})
