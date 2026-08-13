import { describe, it, expect } from 'vitest'
import { createDesk } from '../../src/cards/desk'
import { createOrchestrator } from '../../src/cards/orchestrator'
import { createStore } from '../../src/core/store'
import { CARD_RULES, DATA_BUILDERS } from '../../src/config/cardRules'
import { formOf } from '../../src/config/forms'
import { dimsOf } from '../../src/config/grid'
import { SIGNALS } from '../../src/config/signals'
import { CONSTRAINTS } from '../../src/config/constraints'

/**
 * 时钟氛围卡（用户实拍反馈）：时间/天气做成背景层，卡片压上来时
 * 从缝里漏出来很丑——改成**真正的卡**，走同一套仲裁：
 * 空桌面它把场子撑起来（右侧锚定），桌面忙时第一个让位，
 * 空间空出来 reconcile 自动把它请回来。"无常驻卡"的精神不破——
 * 它是可挤的氛围填充，不是钉死的家具。
 */

const boot = () => {
  let now = 0
  const store = createStore(SIGNALS, CONSTRAINTS)
  const desk = createDesk(() => now)
  createOrchestrator({ store, desk, rules: CARD_RULES, builders: DATA_BUILDERS, deps: { store } }).start()
  return { store, desk, tick: (ms: number) => { now += ms } }
}

describe('时钟卡：氛围填充的生命周期', () => {
  it('空桌面自动出现，锚定右侧', () => {
    const { desk } = boot()
    const c = desk.layout().cards.find(c => c.template === 'clock')
    expect(c, '开机就该在').toBeTruthy()
    // 右锚定：8 列宽的 1/3 卡起点在第 4 列（4+8=12 贴右缘）
    expect(c!.col + c!.colSpan).toBe(12)
  })

  it('最低优先级：普通 task 卡都能挤动它', () => {
    const { desk } = boot()
    expect(desk.priorityOf('rule', 'ambient')).toBeLessThan(desk.priorityOf('task', 'normal'))
  })

  it('桌面挤满时让位，空间释放后自己回来——不用任何人操心', () => {
    const { desk, tick } = boot()
    const ids: string[] = []
    for (let i = 0; i < 24; i++) { tick(10); ids.push(desk.show({ template: 'feedback', size: 'chip', minSize: 'chip', kind: 'system', ttl: 'untilDismissed', data: { title: '填' + i, text: 'x' } }).cardId!) }
    expect(desk.layout().cards.find(c => c.template === 'clock'), '让位').toBeUndefined()
    for (const id of ids.slice(0, 10)) desk.dismiss(id)
    expect(desk.layout().cards.find(c => c.template === 'clock'), '回来').toBeTruthy()
  })

  it('用户划走就不纠缠（会话内不回来）', () => {
    const { desk } = boot()
    const id = desk.layout().cards.find(c => c.template === 'clock')!.id
    desk.dismiss(id, { byUser: true })
    const x = desk.show({ template: 'feedback', size: '1/6', ttl: 60, data: { title: 'x', text: 'x' } }).cardId!
    desk.dismiss(x)   // 触发一次 refill 检查
    expect(desk.layout().cards.find(c => c.template === 'clock')).toBeUndefined()
  })
})

describe('时钟卡形态', () => {
  it('时间任何档都在；日期要 card 档；天气要 panel 档', () => {
    expect(formOf('clock', ...dimsOf('chip')).blocks).toEqual(['time'])
    expect(formOf('clock', ...dimsOf('1/6')).blocks).toContain('date')
    expect(formOf('clock', ...dimsOf('1/3')).blocks).toContain('wx')
  })
})

describe('右锚定是通用机制，不是时钟专属', () => {
  it("anchor:'right' 的卡从右往左找位", () => {
    const d = createDesk()
    const r = d.show({ template: 'feedback', size: '1/6', ttl: 60, anchor: 'right', data: { title: 'x', text: 'x' } } as any)
    const c = d.layout().cards.find(x => x.id === r.cardId)!
    expect(c.col + c.colSpan).toBe(12)
  })
})
