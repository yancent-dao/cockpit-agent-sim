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
  const acks: Array<{ title: string; text: string }> = []
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
