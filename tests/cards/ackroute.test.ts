import { describe, it, expect } from 'vitest'
import { createStore } from '../../src/core/store'
import { createDesk } from '../../src/cards/desk'
import { createOrchestrator } from '../../src/cards/orchestrator'
import { SIGNALS } from '../../src/config/signals'
import { CONSTRAINTS } from '../../src/config/constraints'
import { CARD_RULES, DATA_BUILDERS } from '../../src/config/cardRules'

/**
 * ══════════ 车控回执改走横幅 ══════════
 *
 * 产品判断（2026-08-14）：「开车窗、开空调这种显示状态的卡片应当是通知，
 * 不是卡片吧」。
 *
 * 两条事实加重了它：车控卡的交互声明**只有滑走/缩放/关闭**（滑块画出来
 * 点不了，连"可调面板"都不是），而 ttl 不填 = untilDismissed，
 * **永不自动消失** —— 一句"开车窗"换来一张常驻卡，一直占着 1/6 桌面。
 *
 * 分派仍然走 `channelOf`（判据只看卡片自己的字段），落点在编排器：
 * desk 只管布局，不发消息。
 */
const boot = () => {
  const store = createStore(SIGNALS, CONSTRAINTS)
  const desk = createDesk()
  const acks: Array<{ key: string; title: string; text: string }> = []
  createOrchestrator({
    store, desk, rules: CARD_RULES, builders: DATA_BUILDERS,
    deps: { store } as any,
    onAck: (a: any) => acks.push(a),
  } as any).start()
  acks.length = 0        // 启动即评估会先刷一轮，只看后面用户动作触发的
  return { store, desk, acks }
}

describe('开车窗开空调是通知', () => {
  it('开车窗：出横幅，桌面上不多一张卡', () => {
    const { store, desk, acks } = boot()
    store.set('cabin.window.driver.position', 60)
    expect(desk.layout().cards.filter(c => c.template === 'control'), '不该建卡').toHaveLength(0)
    expect(acks.length, '该出一条横幅').toBeGreaterThan(0)
    expect(acks[0].title).toBe('车窗')
    expect(acks[0].text, '横幅要说清结果').toContain('主驾 60%')
  })

  it('开空调同理', () => {
    const { store, desk, acks } = boot()
    store.set('cabin.climate.targetTemp', 26)
    expect(desk.layout().cards.filter(c => c.template === 'control')).toHaveLength(0)
    expect(acks.some(a => a.title === '空调')).toBe(true)
  })

  /**
   * **车门那条不动。** "门还开着"是持续的安全状态不是回执 ——
   * 它现在是 urgency:'urgent'，看一眼就完了的东西不会给这个等级。
   */
  it('车门/后备箱仍然是卡片 —— 那是持续的安全状态不是回执', () => {
    const { store, desk } = boot()
    store.set('cabin.door.driver.isOpen', true)
    expect(desk.layout().cards.some(c => c.key === 'openings'), '车门卡必须在').toBe(true)
  })

  it('导航、播放器这些内容卡一张都没少', () => {
    const rules = CARD_RULES.filter(r => ['nav', 'player', 'player-video'].includes(r.card.key))
    for (const r of rules) expect((r.card as any).ack, `${r.card.key} 不该被标成回执`).toBeFalsy()
  })
})

/**
 * ══════════ 回执要说「刚做了什么」，不是「现在全量什么状态」 ══════════
 *
 * 灯光从 2 个扩到 8 个之后这条立刻绷不住了：用户说「开后雾灯」，
 * 回执却是「近光 自动 · 远光 关 · 前雾灯 关 · 后雾灯 关 · 还有 4 项」——
 * 四项里三项跟他无关，而他真正做的那件事被挤到看不见的地方。
 *
 * `store.subscribe` 的回调**本来就带着变化的 path**，只是编排器没往下传。
 * 传给 builder 之后，回执才对得上「回执」这个名字。
 */
describe('回执只报刚变的那件事', () => {
  it('开后雾灯 → 回执说的是后雾灯，不是把八盏灯全报一遍', () => {
    const { store, acks } = boot()
    store.set('cabin.light.fogRear.state', 'on')
    const a = acks.find(x => x.key === 'lights')!
    expect(a, '该出回执').toBeTruthy()
    expect(a.text).toContain('后雾灯')
    expect(a.text, '别把无关的灯也报出来').not.toContain('近光')
    expect(a.text, '别出现"还有 N 项"').not.toContain('还有')
  })

  it('关灯也说得出来 —— 不能因为值是"关"就当没发生', () => {
    const { store, acks } = boot()
    store.set('cabin.light.highBeam.state', 'on')
    acks.length = 0
    store.set('cabin.light.highBeam.state', 'off')
    expect(acks.find(x => x.key === 'lights')?.text).toContain('远光')
  })

  /** 补回通道（refill）没有"刚变的那条"，这时候退回全量，别报空 */
  it('拿不到变化路径时退回全量，不是空白', () => {
    const { store, acks } = boot()
    store.set('cabin.light.fogFront.state', 'on')
    expect(acks.find(x => x.key === 'lights')!.text.length).toBeGreaterThan(0)
  })
})
