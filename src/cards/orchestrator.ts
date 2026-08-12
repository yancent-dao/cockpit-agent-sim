import { CARD_TEMPLATES } from '../config/cards'
import type { Store } from '../core/store'
import type { Op } from '../core/types'
import type { Desk } from './desk'
import type { CardRule, BuilderDeps } from '../config/cardRules'

/**
 * 卡片编排器 —— 桌面 = f(车辆状态)
 *
 * 订阅 Store → 评估规则 → 通过与 Agent 相同的 desk API 建/更/撤卡。
 * 同一布局仲裁，不开后门；模型只为规则覆盖不到的临场内容（候选列表、临时提醒）建卡。
 */

const compare = (a: any, op: Op, b: any) =>
  op === '>' ? a > b : op === '<' ? a < b : op === '>=' ? a >= b
  : op === '<=' ? a <= b : op === '==' ? a === b : a !== b

export interface OrchestratorOpts {
  store: Store
  desk: Desk
  rules: CardRule[]
  builders: Record<string, (d: BuilderDeps) => any>
  deps: BuilderDeps
}

export function createOrchestrator({ store, desk, rules, builders, deps }: OrchestratorOpts) {
  const unsubs: Array<() => void> = []

  const isActive = (r: CardRule) =>
    (r.when ?? []).every(([path, op, value]) => compare(store.get(path), op, value))

  /** 确保卡片在场且数据最新。事件卡顺带刷新寿命 */
  const apply = (r: CardRule) => {
    const build = builders[r.card.data]
    // 规则不写尺寸就用模板的默认值——改默认尺寸只改一处
    const size = r.card.size ?? CARD_TEMPLATES.find(t => t.id === r.card.template)?.defaultSize as any
    desk.render({
      key: r.card.key, template: r.card.template, size,
      kind: 'rule', evictable: r.card.evictable, urgency: r.card.urgency,
      ttl: r.card.ttl ?? 'untilDismissed',
      refreshTtl: r.card.ttl !== undefined,
      data: build ? build(deps) : {},
    })
  }

  const retire = (r: CardRule) => {
    const c = desk.findByKey(r.card.key)
    if (c) desk.dismiss(c.id)
  }

  const evaluate = (r: CardRule) => {
    if (!r.when) return // 事件卡只由 watch 触发
    isActive(r) ? apply(r) : retire(r)
  }

  function start() {
    for (const r of rules) {
      for (const path of new Set((r.when ?? []).map(w => w[0])))
        unsubs.push(store.subscribe(path, () => evaluate(r)))
      for (const pattern of r.watch)
        unsubs.push(store.subscribe(pattern, () => {
          if (r.when) { if (isActive(r)) apply(r) } // 状态卡：活跃时刷新数据
          else apply(r)                              // 事件卡：一触即现
        }))
      evaluate(r) // 启动即评估，覆盖"状态早已成立"的场景（如刷新页面时导航正在进行）
    }
  }

  return { start, stop: () => { unsubs.forEach(u => u()); unsubs.length = 0 } }
}

export type Orchestrator = ReturnType<typeof createOrchestrator>
