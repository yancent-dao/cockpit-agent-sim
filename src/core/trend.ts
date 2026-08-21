/**
 * 趋势分析（旅行助手，2026-08-20）——「建议必须带依据」那条 PRD 红线的**机制半边**。
 *
 * ## 边界：这里只摆事实，不做推荐
 *
 * 算的全是**数据的属性**：30 天极值、当前值的分位、最近的方向、离提醒线
 * 还差多少。**不产出「可以下单」**——买不买是策略，归模型；它拿着这些
 * 事实去组织那句「根据近 30 天价格推算，现在比较划算」。
 *
 * 这条线跟 `climate.set 绝不因为外面冷就自己多加两度` 是同一条。分档
 * （低位/偏低/中位/偏高/高位）留在这一层不算越界，因为它是**分位数的
 * 命名**而不是建议——同 navCompareRoutes 给路线打「最快」标签：描述
 * 数据，不替用户拿主意。
 *
 * 纯函数，没有 IO、没有时钟——采样在装配层，判定在这里，测得到。
 */

export interface Sample { at: number; value: number }

/** 分位命名。unknown 是"还没有样本"，跟"中位"不是一回事 */
export type Band = 'low' | 'midLow' | 'mid' | 'midHigh' | 'high' | 'unknown'
export type Direction = 'falling' | 'flat' | 'rising' | 'unknown'

export interface TrendResult {
  count: number
  current?: number
  min?: number
  max?: number
  median?: number
  /** 当前值在样本里的位置，0=最便宜 1=最贵 */
  percentile?: number
  band: Band
  direction: Direction
  /** 跟上一个样本比的差额（卡上那句「较昨日」） */
  changeFromPrev?: number
  /** 设了阈值才有：够没够到、还差多少。**没设 ≠ 差 0**，所以是 undefined 不是 0 */
  hitThreshold?: boolean
  toThreshold?: number
}

/** 分位 → 档名。五档，阈值是数据不是判断 */
const bandOf = (p: number): Band =>
  p <= 0.2 ? 'low' : p <= 0.4 ? 'midLow' : p <= 0.6 ? 'mid' : p <= 0.8 ? 'midHigh' : 'high'

/**
 * 方向判据：末尾若干点的线性走向，用**相对幅度**而不是绝对差——
 * 机票差 50 块和汇率差 50 韩元完全不是一回事。1% 以内算噪声不算趋势
 * （实拍教训的同族：天气逐时条第一版用绝对温度映射，三根柱子差 0.5% 肉眼看不出）。
 */
const NOISE = 0.01
/** 看最近几个点。太少认噪声，太多把老趋势也算进来 */
const TAIL = 5

function directionOf(vals: number[]): Direction {
  if (vals.length < 2) return 'unknown'
  const tail = vals.slice(-TAIL)
  const first = tail[0]
  const last = tail[tail.length - 1]
  if (!first) return 'unknown'
  const rel = (last - first) / Math.abs(first)
  return rel < -NOISE ? 'falling' : rel > NOISE ? 'rising' : 'flat'
}

export function analyze(
  samples: Sample[],
  current?: number,
  watch?: { threshold?: number; direction?: 'below' | 'above' },
): TrendResult {
  const sorted = [...samples].sort((a, b) => a.at - b.at)
  const vals = sorted.map(s => s.value)
  if (!vals.length) return { count: 0, band: 'unknown', direction: 'unknown' }

  // 不传当前值就用最后一个样本——刚写进仓的那个，不用调用方再喂一遍
  const cur = current ?? vals[vals.length - 1]
  const asc = [...vals].sort((a, b) => a - b)
  const min = asc[0]
  const max = asc[asc.length - 1]
  const mid = asc.length % 2
    ? asc[(asc.length - 1) / 2]
    : (asc[asc.length / 2 - 1] + asc[asc.length / 2]) / 2

  // 全都一个价时除零 —— 淡季价格纹丝不动是真会发生的，落在中位
  const span = max - min
  const percentile = span === 0 ? 0.5 : (cur - min) / span

  const out: TrendResult = {
    count: vals.length,
    current: cur, min, max, median: mid,
    percentile,
    band: bandOf(percentile),
    direction: directionOf(vals),
    ...(vals.length >= 2 ? { changeFromPrev: cur - vals[vals.length - 2] } : {}),
  }

  if (watch?.threshold !== undefined) {
    const below = (watch.direction ?? 'below') === 'below'
    out.hitThreshold = below ? cur <= watch.threshold : cur >= watch.threshold
    // 还差多少：正数 = 还要变这么多才够，负数 = 已经越过去了
    out.toThreshold = below ? cur - watch.threshold : watch.threshold - cur
  }
  return out
}
