import { CARD_TEMPLATES } from '../config/cards'
import type { Store } from '../core/store'
import { compare } from '../core/types'
import type { Desk } from './desk'
import type { CardRule, BuilderDeps } from '../config/cardRules'
import { channelOf } from '../config/priority'
import { ackLine } from './summary'

/**
 * 卡片编排器 —— 桌面 = f(车辆状态)
 *
 * 订阅 Store → 评估规则 → 通过与 Agent 相同的 desk API 建/更/撤卡。
 * 同一布局仲裁，不开后门；模型只为规则覆盖不到的临场内容（候选列表、临时提醒）建卡。
 */

export interface OrchestratorOpts {
  store: Store
  desk: Desk
  rules: CardRule[]
  builders: Record<string, (d: BuilderDeps) => any>
  deps: BuilderDeps
  /**
   * 回执通道。标了 `ack` 的规则不建卡，走这里 —— 由装配方接到横幅上。
   * **分派在 `channelOf`，落点在编排器**：desk 只管布局，不发消息。
   */
  onAck?: (a: { key: string; title: string; text: string }) => void
}

export function createOrchestrator({ store, desk, rules, builders, deps, onAck }: OrchestratorOpts) {
  const unsubs: Array<() => void> = []

  const isActive = (r: CardRule) =>
    (r.when ?? []).every(([path, op, value]) => compare(store.get(path), op, value))

  /** 确保卡片在场且数据最新。事件卡顺带刷新寿命 */
  const apply = (r: CardRule) => {
    const build = builders[r.card.data]
    /**
     * 回执走横幅，不进桌面（产品判断：开车窗开空调是通知不是卡片）。
     * 分派仍然问 `channelOf` —— 判据只看卡片自己的字段，不看模板名。
     */
    if (channelOf({ ack: r.card.ack, urgency: r.card.urgency }) === 'banner') {
      const d = build ? build(deps) : {}
      onAck?.({ key: r.card.key, title: String(d?.title ?? ''), text: ackLine(d) })
      return
    }
    // 规则不写尺寸就用模板的默认值——改默认尺寸只改一处
    const size = r.card.size ?? CARD_TEMPLATES.find(t => t.id === r.card.template)?.defaultSize as any
    desk.render({
      key: r.card.key, template: r.card.template, size,
      kind: 'rule', evictable: r.card.evictable, urgency: r.card.urgency, anchor: r.card.anchor,
      ttl: r.card.ttl ?? 'untilDismissed',
      refreshTtl: r.card.ttl !== undefined,
      data: build ? build(deps) : {},
    })
  }

  /**
   * 补回通道（reconcile 第一步）：规则条件仍成立但卡不在台上（被挤掉了，
   * 台上台下都算"不在场"——`findByKey` 现在等位区也认得到，所以判据必须
   * 明确是"不在台上"，不是"哪都找不到"）→ 重新断言。
   *
   * 这修的是核心不变量：桌面 = f(车辆状态)，不是 f(状态, 历史路径)——
   * 播放器被挤掉后歌还在放，屏上就该有它。等位区里的卡再次断言正是它
   * 重新尝试上台的机会（desk.render 对排队中的卡会立即重试 fit，不必等 tick）。
   * 用户亲手关掉的跳过（isSuppressed），直到 watch 信号变化让规则重新断言。
   */
  const refill = () => {
    const onstage = new Set(desk.layout().cards.map(c => c.key))
    for (const r of rules)
      if (r.when && isActive(r) && !onstage.has(r.card.key) && !desk.isSuppressed(r.card.key))
        apply(r)
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
    // 补回订阅：desk 每次变化都看一眼有没有"该在场却缺席"的规则卡
    unsubs.push(desk.subscribe(refill))
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
