import { describe, it, expect, beforeEach } from 'vitest'
import { createAutomationStore, type AutomationRule } from '../../src/state/automation'
import { createAutomationEngine } from '../../src/core/automation'
import { createStore } from '../../src/core/store'
import { SIGNALS } from '../../src/config/signals'
import { CONSTRAINTS } from '../../src/config/constraints'

/**
 * 自动化任务（设计文档 2026-08-18-automation-design.md）。
 * 规则是用户数据（跟 cardRules 同构），引擎只判定与 emit——
 * 动作执行在装配层，core 不认识 registry/pipeline。
 */

const mem = () => { const m = new Map<string, string>(); return { get: (k: string) => m.get(k) ?? null, set: (k: string, v: string) => m.set(k, v) } }

const RAIN: AutomationRule = {
  id: 'a1', name: '雨天模式', enabled: true,
  when: [['signal', 'env.weather', '==', 'rain']],
  do: [{ tool: 'wiper.set', args: { mode: 'low' } }],
}

describe('规则仓（localStorage 域仓同款）', () => {
  it('增删改查 + 持久化', () => {
    const storage = mem()
    const a = createAutomationStore(storage)
    a.add(RAIN)
    expect(a.list()).toHaveLength(1)
    a.toggle('a1', false)
    expect(a.list()[0].enabled).toBe(false)
    // 重新加载还在——后台任务的地基是持久化
    const b = createAutomationStore(storage)
    expect(b.list()).toHaveLength(1)
    expect(b.list()[0].enabled).toBe(false)
    b.remove('a1')
    expect(b.list()).toHaveLength(0)
  })
  it('坏数据兜底成空表，不炸', () => {
    const storage = mem()
    storage.set('cockpit-sim:automations', '{bad json')
    expect(createAutomationStore(storage).list()).toEqual([])
  })
})

describe('引擎：边沿触发（任务大师同款语义）', () => {
  let store: ReturnType<typeof createStore>
  let fired: string[]
  let clockMs: number
  const mkEngine = (rules: AutomationRule[]) => {
    const a = createAutomationStore(mem())
    rules.forEach(r => a.add(r))
    const e = createAutomationEngine(store, a, r => fired.push(r.id), () => clockMs)
    return { a, e }
  }
  beforeEach(() => {
    store = createStore(SIGNALS, CONSTRAINTS)
    fired = []
    clockMs = new Date('2026-08-18T15:59:00').getTime()
  })

  it('条件从不满足→满足的那一刻 fire 一次，持续满足不重复', () => {
    const { e } = mkEngine([RAIN])
    e.evaluate()                       // rain 未满足
    store.setDirect('env.weather', 'rain')
    e.evaluate()
    e.evaluate()                       // 持续满足，不再 fire
    expect(fired).toEqual(['a1'])
    store.setDirect('env.weather', 'clear')
    e.evaluate()
    store.setDirect('env.weather', 'rain')   // 再次跨沿 → 再 fire
    e.evaluate()
    expect(fired).toEqual(['a1', 'a1'])
  })

  it('时间条件：到点的那一分钟 fire 一次，同一分钟不重复', () => {
    const { e } = mkEngine([{ id: 't1', name: '四点开空调', enabled: true,
      when: [['time', '16:00']], do: [{ tool: 'climate.set', args: { power: true } }] }])
    e.evaluate()                       // 15:59
    expect(fired).toEqual([])
    clockMs = new Date('2026-08-18T16:00:10').getTime()
    e.evaluate()
    clockMs = new Date('2026-08-18T16:00:50').getTime()
    e.evaluate()                       // 同一分钟
    expect(fired).toEqual(['t1'])
    clockMs = new Date('2026-08-19T16:00:00').getTime()
    e.evaluate()                       // 第二天再来
    expect(fired).toEqual(['t1', 't1'])
  })

  it('停用的规则不 fire；手动任务（无条件）永不自动 fire', () => {
    const { a, e } = mkEngine([{ ...RAIN, enabled: false },
      { id: 'm1', name: '手动', enabled: true, when: [], do: [{ prompt: '推荐股票' }] }])
    store.setDirect('env.weather', 'rain')
    e.evaluate()
    expect(fired).toEqual([])
    a.toggle('a1', true)
    e.evaluate()                       // 启用时已满足——启用视为进入监听，满足即沿
    expect(fired).toEqual(['a1'])
  })

  it('信号+时间混合条件要同时满足', () => {
    const { e } = mkEngine([{ id: 'x', name: '开车时四点', enabled: true,
      when: [['signal', 'vehicle.gear', '==', 'd'], ['time', '16:00']],
      do: [{ prompt: '推荐当天的股票' }] }])
    clockMs = new Date('2026-08-18T16:00:00').getTime()
    e.evaluate()                       // 时间到了但没挂 D
    expect(fired).toEqual([])
    store.setDirect('vehicle.gear', 'd')
    e.evaluate()
    expect(fired).toEqual(['x'])
  })

  it('fire 时记 lastRun', () => {
    const { a, e } = mkEngine([RAIN])
    store.setDirect('env.weather', 'rain')
    e.evaluate()
    expect(a.list()[0].lastRun).toBe(clockMs)
  })
})
