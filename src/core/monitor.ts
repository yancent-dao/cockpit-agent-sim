/**
 * 采样调度——约束引擎、自动化引擎的第三个姐妹（旅行助手任务引擎，2026-08-20）。
 *
 * 只做一件事：**判定谁该采样了**。取数、比对、建卡、播报全在装配层——
 * core 不认识 registry 也不认识 travel 域仓，这条边界跟 automation.ts 一模一样。
 *
 * ## 为什么采样策略是数据不是代码
 *
 * 产品给的是四条策略：10 分钟 / 1 小时 / 每次上电一次 / 新建任务后一次。
 * 照字面实现就是四个分支，加第五种就得改代码——正好踩中「加能力 = 加数据」。
 * 拆开看它们只是两个字段的组合：
 *
 *   10 分钟          → everyMs: 600_000
 *   1 小时           → everyMs: 3_600_000
 *   每次上电一次      → onBoot: true
 *   新建任务后一次    → **不需要任何字段**
 *
 * 最后一条是白捡的：新监控项的 lastAt 是空的，空 = 从没采过 = 立刻到期。
 * 「建完任务马上出第一份数据」于是成了 lastAt 语义的自然结果，
 * 而不是一条要单独维护的规则。
 *
 * ## 端上跑，不追实时
 *
 * 这是车机端跑的模拟环境，价格场景本身也不要求秒级——所以调度粒度按分钟给
 * 就够，没有 setInterval 抖动补偿、没有漏采追赶。下电（关窗口）即停，
 * 上电（重新打开）由装配层调一次 boot() 补齐，跟自动化引擎「车机窗口在
 * 任务就在」是同一条零后端边界。
 */

export interface MonitorItem {
  id: string
  /** 定时采样间隔（毫秒）。不填 = 只在上电与新建时采，平时不动 */
  everyMs?: number
  /** 上电补采一次。机票酒店这类「隔了一夜可能变了」的开，汇率新闻按自己的日频走 */
  onBoot?: boolean
  /** 上次采样时刻。**空 = 从没采过 = 立刻到期**（新建任务后第一次采样靠这个） */
  lastAt?: number
}

/**
 * 此刻谁该采样了。纯函数——车机屏那边是定时器和网络请求，跑不了单测，
 * 判定这半边抽出来才测得到。
 */
export function due(items: MonitorItem[], now: number, boot = false): string[] {
  return items.filter(i => {
    if (i.lastAt === undefined) return true          // 从没采过
    if (boot && i.onBoot) return true                // 上电补采
    return i.everyMs !== undefined && now - i.lastAt >= i.everyMs
  }).map(i => i.id)
}

export interface MonitorDeps {
  /** 当前监控项快照。每次判定都重新取——增删监控项不用重建引擎 */
  items: () => MonitorItem[]
  /** 到期通知。**只在真有到期项时调**，空转不惊动装配层 */
  onDue: (ids: string[]) => void
  clock?: () => number
}

/** 定时器壳。装配层每分钟 tick 一次，上电时 boot 一次 */
export function createMonitor(deps: MonitorDeps) {
  const { items, onDue, clock = Date.now } = deps
  const run = (boot: boolean) => {
    const ids = due(items(), clock(), boot)
    if (ids.length) onDue(ids)
  }
  return {
    tick: () => run(false),
    boot: () => run(true),
  }
}

export type Monitor = ReturnType<typeof createMonitor>
