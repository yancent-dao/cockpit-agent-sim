import { describe, it, expect } from 'vitest'
import { due, createMonitor, type MonitorItem } from '../../src/core/monitor'

/**
 * 采样调度（旅行助手的任务引擎，2026-08-20）。
 *
 * 产品定的策略是「10 分钟 / 1 小时 / 每次上电一次 / 新建任务后一次」——
 * 四条听着是四种模式，其实是**两个数据字段**的组合：
 *   · everyMs   定时间隔（10 分钟还是 1 小时，是数据不是代码）
 *   · onBoot    上电补采
 * 而「新建任务后采一次」不需要任何特殊分支：新监控项的 lastAt 是空的，
 * 空就是"从没采过"，从没采过就立刻到期。加一种采样节奏 = 表里改个数字。
 *
 * 引擎不认识"机票""汇率"——它只认识"一个带间隔和上次采样时间的条目"，
 * 跟约束引擎/自动化引擎同一条边界：只判定，取数和建卡在装配层。
 */

const MIN = 60_000
const HOUR = 60 * MIN

describe('due()：此刻谁该采样了', () => {
  it('从没采过的立刻到期——「新建任务后采一次」不需要特殊分支', () => {
    const items: MonitorItem[] = [{ id: 'flight', everyMs: HOUR }]
    expect(due(items, 1_000_000)).toEqual(['flight'])
  })

  it('定时间隔到了才到期', () => {
    const items: MonitorItem[] = [{ id: 'flight', everyMs: HOUR, lastAt: 1_000_000 }]
    expect(due(items, 1_000_000 + HOUR - 1)).toEqual([])
    expect(due(items, 1_000_000 + HOUR)).toEqual(['flight'])
  })

  it('10 分钟档与 1 小时档只是数字不同，走同一条判定', () => {
    const items: MonitorItem[] = [
      { id: 'fast', everyMs: 10 * MIN, lastAt: 1_000_000 },
      { id: 'slow', everyMs: HOUR, lastAt: 1_000_000 },
    ]
    expect(due(items, 1_000_000 + 12 * MIN)).toEqual(['fast'])
  })

  it('上电时 onBoot 的一律补采，不管上次是几分钟前采的', () => {
    const items: MonitorItem[] = [
      { id: 'flight', everyMs: HOUR, onBoot: true, lastAt: 1_000_000 },
      { id: 'news', everyMs: 24 * HOUR, onBoot: true, lastAt: 1_000_000 },
    ]
    expect(due(items, 1_000_000 + MIN, true).sort()).toEqual(['flight', 'news'])
  })

  it('上电时没声明 onBoot 的，仍按自己的间隔算——上电不是万能刷新键', () => {
    const items: MonitorItem[] = [{ id: 'fx', everyMs: 24 * HOUR, lastAt: 1_000_000 }]
    expect(due(items, 1_000_000 + MIN, true)).toEqual([])
  })

  it('不填 everyMs = 只在上电和新建时采，平时不动', () => {
    const items: MonitorItem[] = [{ id: 'once', onBoot: true, lastAt: 1_000_000 }]
    expect(due(items, 1_000_000 + 10 * HOUR)).toEqual([])
    expect(due(items, 1_000_000 + MIN, true)).toEqual(['once'])
  })
})

describe('createMonitor：装配层的定时器壳', () => {
  it('tick 把到期的交给 onDue，没到期的一个都不给', () => {
    let now = 1_000_000
    const items: MonitorItem[] = [
      { id: 'flight', everyMs: HOUR, lastAt: now },
      { id: 'fx', everyMs: 24 * HOUR, lastAt: now },
    ]
    const fired: string[][] = []
    const m = createMonitor({ items: () => items, onDue: ids => fired.push(ids), clock: () => now })
    now += 30 * MIN
    m.tick()
    expect(fired).toEqual([])          // 都没到
    now += 31 * MIN
    m.tick()
    expect(fired).toEqual([['flight']])
  })

  it('boot() 触发一次上电补采', () => {
    const now = 1_000_000
    const items: MonitorItem[] = [{ id: 'flight', everyMs: HOUR, onBoot: true, lastAt: now }]
    const fired: string[][] = []
    const m = createMonitor({ items: () => items, onDue: ids => fired.push(ids), clock: () => now })
    m.boot()
    expect(fired).toEqual([['flight']])
  })

  it('没有任何到期项时不叫 onDue——空转不该惊动装配层', () => {
    const now = 1_000_000
    let called = 0
    const m = createMonitor({
      items: () => [{ id: 'a', everyMs: HOUR, lastAt: now }],
      onDue: () => { called++ }, clock: () => now,
    })
    m.tick()
    expect(called).toBe(0)
  })
})
