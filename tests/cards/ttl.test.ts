import { describe, it, expect } from 'vitest'
import { CARD_RULES } from '../../src/config/cardRules'
import { TOOLS } from '../../src/config/tools'
import { createDesk } from '../../src/cards/desk'

/**
 * 卡片默认**不自动消失**。
 *
 * 之前车控反馈卡统一 30 秒退场 —— 演示时最常见的抱怨是「我还没讲到它就没了」。
 * 而且 30 这个数字是拍的：用户看一眼车窗开度要 3 秒，讲解一段要 2 分钟，
 * 同一个数字伺候不了这两种场合。
 *
 * 桌面满了自然会挤（七档缩放 + LRU），**让空间竞争决定谁退场，
 * 比让秒表决定更接近真实的注意力分配**。
 */
describe('规则卡不再定时消失', () => {
  it('cardRules 里没有卡片声明秒数 ttl', () => {
    const timed = CARD_RULES.filter(r => typeof r.card.ttl === 'number')
    expect(timed.map(r => r.id), '这些还在定时退场').toEqual([])
  })

  it('车控反馈卡活到被挤掉为止', () => {
    const d = createDesk()
    const r = d.show({ template: 'control', size: '1/6', ttl: 'untilDismissed',
      data: { title: '车窗', items: [{ label: '主驾', value: 30 }] } })
    expect(r.status).toBe('ok')
    d.tick()   // 走一遍生命周期
    expect(d.layout().cards).toHaveLength(1)
  })
})

/**
 * 但**问题类**卡片该有寿命：voice.ask 的问句、MRTR 确认、候选列表，
 * 挂在那儿不撤就是一直在问一个用户早就跳过的问题。
 * 具体多久由模型定 —— 它才知道这次问的是「要不要」还是「哪一个」。
 */
describe('模型能自己定卡片寿命', () => {
  const show = TOOLS.find(t => t.name === 'card.show')!

  it('card.show 的 ttl 仍然必填 —— 强制模型每次想一下这张卡该活多久', () => {
    expect((show.params as any).ttl.required).toBe(true)
  })

  it('ttl 描述给出判据，不是让模型瞎猜数字', () => {
    const d = (show.params as any).ttl.desc as string
    // 说清什么时候用常驻
    expect(d).toMatch(/untilDismissed/)
    // 说清什么时候用秒数，并且举了问题类的例子
    expect(d).toMatch(/秒/)
    expect(d, '要告诉它哪类卡该设秒数').toMatch(/问|选|确认/)
  })

  it('传数字就按秒数走，到点退场', () => {
    let now = 0
    const d = createDesk(() => now)
    d.show({ template: 'feedback', size: '1/6', ttl: 5, data: { title: '好了', text: 'x' } })
    now += 4000; d.tick()
    expect(d.layout().cards, '4 秒还在').toHaveLength(1)
    now += 2000; d.tick()
    expect(d.layout().cards, '6 秒该走了').toHaveLength(0)
  })

  it('untilDismissed 的卡不会被 tick 撤掉', () => {
    let now = 0
    const d = createDesk(() => now)
    d.show({ template: 'weather', size: '1/6', ttl: 'untilDismissed', data: { title: '天气', now: { temperature: 25, weather: '晴' } } })
    now += 3600_000; d.tick()
    expect(d.layout().cards).toHaveLength(1)
  })
})
