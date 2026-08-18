/**
 * 自动化引擎——约束引擎的姐妹（设计文档 2026-08-18-automation-design.md）。
 *
 * 只做两件事：判定与 emit。动作执行在装配层——core 不认识 registry
 * 和 pipeline，这条边界跟「桌面 = f(状态)」的编排器一模一样。
 *
 * **边沿触发**（任务大师同款语义）：条件整体从"不满足 → 全满足"的那一刻
 * fire 一次，持续满足不重复；离开再进入才会再 fire。时间条件按分钟比对，
 * 同一分钟只算一次满足。启用一条已满足的规则视为"进入监听"，满足即沿。
 */
import type { Store } from './store'
import { compare } from './types'
import type { Op } from './types'
import type { AutomationStore, AutomationRule } from '../state/automation'

export function createAutomationEngine(
  store: Store,
  rules: AutomationStore,
  onFire: (rule: AutomationRule) => void,
  clock: () => number = Date.now,
) {
  /**
   * 上一次评估的"满足身份"——边沿检测的记忆。
   * 纯信号规则身份是 'met'；带时间条件的身份是「日期+分钟」——
   * 这样同一分钟连评不重复 fire，而隔天同一时刻（中间可能没有任何评估，
   * 比如页面睡了）照样算新的沿。停用/删除的自然遗忘。
   */
  const lastKey = new Map<string, string>()

  const stamp = (ms: number) => {
    const d = new Date(ms)
    return `${d.getFullYear()}-${d.getMonth()}-${d.getDate()} ${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`
  }

  const metKey = (r: AutomationRule): string => {
    if (!r.when.length) return ''
    const hasTime = r.when.some(c => c[0] === 'time')
    const ok = r.when.every(c =>
      c[0] === 'time'
        ? stamp(clock()).endsWith(` ${c[1]}`)
        : compare(store.get(c[1]), c[2] as Op, c[3]))
    if (!ok) return ''
    return hasTime ? stamp(clock()) : 'met'
  }

  /** 评估一轮。装配层在 store 变化时和时钟 tick（≤30s 一次）时各调一次 */
  function evaluate() {
    for (const r of rules.list()) {
      if (!r.enabled || !r.when.length) { lastKey.delete(r.id); continue }
      const key = metKey(r)
      const before = lastKey.get(r.id) ?? ''
      lastKey.set(r.id, key)
      if (key && key !== before) {
        rules.markRun(r.id, clock())
        onFire(rules.get(r.id) ?? r)
      }
    }
  }

  return { evaluate }
}

export type AutomationEngine = ReturnType<typeof createAutomationEngine>
