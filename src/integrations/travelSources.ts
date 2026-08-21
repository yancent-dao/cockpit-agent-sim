/**
 * 监控项的数据源与采样一轮（旅行助手，2026-08-20）。
 *
 * ## 源是一张表，不是一串 if
 *
 * 四类监控项（机票/酒店/汇率/新闻）各有各的 CP，而机酒的选型还在进行中
 * （Amadeus 对国内航线覆盖差，RapidAPI 候选调研中）。把源做成
 * `kind → PriceSource` 的表之后，这个未决的决定不阻塞任何东西：
 * **没接的 kind 静默跳过，接上就是往表里加一行**，采样逻辑一行不用改。
 * 跟「加能力 = 加数据」同一条；换 CP 的成本因此是一个函数，不是一次重构。
 *
 * ## 这一层做什么、不做什么
 *
 * 做：并发取数、写样本、判阈值（边沿，只响一次）、坏源降级。
 * 不做：建卡、播报、决定要不要提醒用户——那些在装配层和模型那边。
 */
import type { TravelStore, TravelWatch, WatchKind } from '../state/travel'
import type { Sample } from '../core/trend'
import type { FxClient } from './frankfurter'

export interface PriceQuote {
  value: number
  at: number
  /** 给模型看的补充事实（"含税""3 小时前的缓存价"），不是话术 */
  note?: string
}

export interface PriceSource {
  quote(w: TravelWatch): Promise<PriceQuote>
  /**
   * 上游直接给的历史。有的源有（汇率），有的没有（多数机酒 API）——
   * 没有就不实现，靠自己每天采样慢慢攒，30 天后一样有曲线。
   */
  history?(w: TravelWatch, days: number): Promise<Sample[]>
}

export type SourceMap = Partial<Record<WatchKind, PriceSource>>

export interface Fired {
  watch: TravelWatch
  value: number
  at: number
  note?: string
}

/**
 * 采一轮。调度器给 id，这里取数写仓判阈值，把**真正触发了的**交回去。
 *
 * 三条降级都是静默跳过而不是抛（PRD 5.6）：源报错、这个 kind 还没接源、
 * id 在仓里找不到。一项坏了不许拖垮整轮——十几个监控项里挂一个，
 * 其余的数据照样该更新。
 */
export async function sampleRound(
  store: TravelStore,
  ids: string[],
  sources: SourceMap,
): Promise<Fired[]> {
  const all = store.watches()
  // 并发取数：串行采十几项要十几个网络往返，并发只花最慢那一次
  // （多区县天气那次的教训：串行 15 个要 30 秒，并发 3 秒出齐）
  const results = await Promise.all(ids.map(async (id): Promise<Fired | null> => {
    const w = all.find(x => x.id === id)
    if (!w) return null
    const src = sources[w.kind]
    if (!src) return null                       // 这类还没接源
    let q: PriceQuote
    try { q = await src.quote(w) } catch { return null }   // 坏源静默跳过

    store.addSample(w.id, q.value, q.at)

    if (w.threshold === undefined) return null  // 只采样不提醒（趋势用）
    if (w.status !== 'active') return null      // 已触发/已撤销：边沿，不重复响
    const below = (w.direction ?? 'below') === 'below'
    const hit = below ? q.value <= w.threshold : q.value >= w.threshold
    if (!hit) return null

    store.markFired(w.id, q.value, q.at)
    return { watch: { ...w, status: 'fired', lastValue: q.value, lastAt: q.at }, value: q.value, at: q.at, note: q.note }
  }))
  return results.filter((r): r is Fired => r !== null)
}

/* ── 具体的源 ── */

/** label 里认币种对（"CNY→KRW"）。认不出用默认——待定态任务的 label 可能还很粗 */
const CURRENCY = /([A-Z]{3})\s*[→\->/]+\s*([A-Z]{3})/
const pair = (label: string): [string, string] => {
  const m = CURRENCY.exec(label)
  return m ? [m[1], m[2]] : ['CNY', 'KRW']
}

/**
 * 汇率源。**报的是 per100**（100 CNY 兑多少 KRW）——跟卡上、跟人说的
 * 口径一致，别让阈值判定和用户看到的数字是两套刻度。
 */
export function fxSource(fx: FxClient, clock: () => number = Date.now): PriceSource {
  return {
    async quote(w) {
      const [base, sym] = pair(w.label)
      const p = await fx.latest(base, sym)
      return { value: p.per100, at: clock() }
    },
    async history(w, days) {
      const [base, sym] = pair(w.label)
      const now = clock()
      const iso = (ms: number) => new Date(ms).toISOString().slice(0, 10)
      const pts = await fx.series(base, sym, iso(now - days * 86_400_000), iso(now))
      return pts.map(p => ({ at: Date.parse(p.date), value: p.per100 }))
    },
  }
}
