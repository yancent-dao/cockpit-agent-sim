/**
 * 机票/酒店的示例数据源（2026-08-20）——**同时是录制槽**。
 *
 * ## 为什么这一类允许 mock
 *
 * 项目的规矩是三方一律接真实 API（绘本那十九条教训：假 fetcher 什么都不
 * 校验，很多问题只有真打才发现）。这里破例，理由是**代价被算清楚了**：
 *
 *   · 整条链路（建任务→配委托→采样→到价→趋势卡→播报）用**汇率**就能
 *     完整演，而汇率零 Key、有真历史、全是真的
 *   · 机酒在 RapidAPI 上的候选全是非官方封装，免费层 50 次/月，
 *     开发调试期几天就烧完
 *
 * 所以 mock 机酒损失的是"机票价格是真的"这**一个点**，不是 Demo 的真实性。
 *
 * ## 破例的两条底线
 *
 * ① **不许冒充真数据**。每个报价带 note 标明是示例——PRD 5.6「数据过期
 *    标注时间，不冒充实时数据」是同一条纪律，模型看得见就不会说成实时价。
 * ② **必须可重放**。同一条委托每次得到同一条曲线（id 做种子的确定性游走），
 *    同一场 Demo 演两遍长得一样——同卡片布局那条「不追求最优解，
 *    追求可预测解」。
 *
 * ## 怎么换成真的
 *
 * 这是**录制槽**不是终点：拿到 RapidAPI Key 后真打一次，把响应落成
 * fixture 覆盖 `BASE`，或者干脆写个 rapidapi.ts 实现同一个 PriceSource
 * 契约——上层（采样一轮、趋势分析、卡片）一行都不用改。源是表里的一行。
 */
import type { PriceSource } from './travelSources'
import type { WatchKind } from '../state/travel'

/** 卡片与模型都要看见的标记。别让示例数据悄悄穿上真数据的衣服 */
export const MOCK_NOTE = '示例数据'

/**
 * 各类的基准价与日波动幅度。真接上之后这张表整个被上游取代。
 * swing 是**日间**波动：第一版给了 13%，眼看曲线时发现那是锯齿不是价格——
 * 真实机票一天动几个百分点。噪声过大还会淹掉趋势，让方向判定失效。
 */
const BASE: Partial<Record<WatchKind, { mid: number; swing: number; drift: number }>> = {
  // 成都↔首尔往返，30 天从 ~2400 走到 ~1900：演示要能跌破提醒线，
  // 不然「到价触发」那一段根本没法演
  flight: { mid: 2150, swing: 0.045, drift: -0.22 },
  // 明洞一晚，波动小、略升（周末满房那条剧情用得上）
  hotel: { mid: 620, swing: 0.035, drift: 0.05 },
}

/** 字符串 → 种子。同一条委托永远同一条曲线，Demo 可重放 */
const seedOf = (s: string): number => {
  let h = 2166136261
  for (let i = 0; i < s.length; i++) { h ^= s.charCodeAt(i); h = Math.imul(h, 16777619) }
  return h >>> 0
}

/** 确定性伪随机（mulberry32）。不用 Math.random——那样每次刷新曲线都变 */
const rngOf = (seed: number) => () => {
  seed = (seed + 0x6D2B79F5) >>> 0
  let t = Math.imul(seed ^ (seed >>> 15), 1 | seed)
  t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t
  return ((t ^ (t >>> 14)) >>> 0) / 4294967296
}

const DAY = 86_400_000

/**
 * 第 i 天（0 = 30 天前，days = 今天）的价格。
 * 趋势 + 噪声，两者都由种子决定，所以整条曲线是纯函数。
 */
function priceAt(kind: WatchKind, seed: number, i: number, days: number): number {
  const b = BASE[kind] ?? { mid: 1000, swing: 0.1, drift: 0 }
  const rnd = rngOf(seed + i * 7919)
  const progress = days === 0 ? 1 : i / days
  const trend = 1 + b.drift * progress
  const noise = 1 + (rnd() - 0.5) * b.swing
  return Math.round(b.mid * trend * noise)
}

/** 每条委托的曲线偏一点，两张卡不能长成一个样 */
const shift = (id: string) => (seedOf(id) % 400) - 200

export function mockSource(clock: () => number = Date.now): PriceSource {
  const HIST = 30
  return {
    async quote(w) {
      const seed = seedOf(w.id + w.kind)
      return {
        value: priceAt(w.kind, seed, HIST, HIST) + shift(w.id),
        at: clock(),
        note: `${MOCK_NOTE}（机酒数据源未接，真实 Key 到位后自动换成实时价）`,
      }
    },
    async history(w, days = HIST) {
      const seed = seedOf(w.id + w.kind)
      const now = clock()
      const d = shift(w.id)
      return Array.from({ length: days }, (_, i) => ({
        at: now - (days - i) * DAY,
        value: priceAt(w.kind, seed, i, days) + d,
      }))
    },
  }
}
