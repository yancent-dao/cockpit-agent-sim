import { describe, it, expect, beforeEach } from 'vitest'
import { createTravelStore, type TravelTask, type TravelWatch } from '../../src/state/travel'
import type { DomainStorage } from '../../src/state/domain'

/**
 * 旅行任务域仓（2026-08-20）。任务与委托跨上下电存续——关窗口 = 熄火，
 * 重新打开 = 上电，中间靠 localStorage 接上，这是「长时任务」的地基。
 *
 * 采样样本按 30 天滚动窗淘汰：趋势分析只看 30 天，攒更久既没人看
 * 又会把 localStorage 配额吃满（绘本那次 5MB 配额静默失败的教训）。
 */

const mem = (): DomainStorage & { dump: () => Map<string, string> } => {
  const m = new Map<string, string>()
  return { get: k => m.get(k) ?? null, set: (k, v) => m.set(k, v), dump: () => m }
}

const DAY = 86_400_000
let storage: ReturnType<typeof mem>

beforeEach(() => { storage = mem() })

const task = (over: Partial<TravelTask> = {}): TravelTask => ({
  id: 't1', title: '韩国行', destination: '首尔',
  status: 'active', createdAt: 1_000_000, ...over,
})
const watch = (over: Partial<TravelWatch> = {}): TravelWatch => ({
  id: 'w1', taskId: 't1', kind: 'flight', label: '成都→首尔 往返',
  status: 'active', ...over,
})

describe('任务：信息不全也照建（待定态）', () => {
  it('没有日期也能建，状态是 draft 不是报错——澄清慢慢补，别卡住用户', () => {
    const s = createTravelStore(storage)
    s.addTask(task({ status: 'draft', departDate: undefined }))
    const t = s.tasks()[0]
    expect(t.status).toBe('draft')
    expect(t.departDate).toBeUndefined()
  })

  it('补齐日期后可以转成 active', () => {
    const s = createTravelStore(storage)
    s.addTask(task({ status: 'draft' }))
    s.updateTask('t1', { departDate: '2026-09-02', status: 'active' })
    expect(s.tasks()[0].departDate).toBe('2026-09-02')
    expect(s.tasks()[0].status).toBe('active')
  })

  it('归档不删数据——归档任务要能查、能当模板复用', () => {
    const s = createTravelStore(storage)
    s.addTask(task())
    s.updateTask('t1', { status: 'archived' })
    expect(s.tasks()).toHaveLength(1)
    expect(s.tasks()[0].status).toBe('archived')
  })

  it('删任务连它的委托一起删——留下孤儿委托就是在盯一个不存在的行程', () => {
    const s = createTravelStore(storage)
    s.addTask(task())
    s.addWatch(watch())
    s.addWatch(watch({ id: 'w2', kind: 'hotel' }))
    s.addWatch(watch({ id: 'w3', taskId: 't2' }))   // 别的任务的，不该受牵连
    const removed = s.removeTask('t1')
    expect(removed.map(w => w.id).sort()).toEqual(['w1', 'w2'])
    expect(s.watches().map(w => w.id)).toEqual(['w3'])
  })
})

describe('防御性拷贝：外部引用不许穿透进仓', () => {
  it('调用方改自己手里的对象，仓里的事实不跟着变', () => {
    const s = createTravelStore(storage)
    const t = task()
    s.addTask(t)
    t.title = '被外部改了'
    expect(s.tasks()[0].title).toBe('韩国行')
  })

  it('读出来的也是副本，改它不影响仓', () => {
    const s = createTravelStore(storage)
    s.addTask(task())
    s.tasks()[0].title = '被外部改了'
    expect(s.tasks()[0].title).toBe('韩国行')
  })
})

describe('委托：生命周期与查询', () => {
  it('触发后状态变 fired，并记下触发时的值', () => {
    const s = createTravelStore(storage)
    s.addWatch(watch({ threshold: 2000, direction: 'below' }))
    s.markFired('w1', 1868, 1_500_000)
    const w = s.watches()[0]
    expect(w.status).toBe('fired')
    expect(w.lastValue).toBe(1868)
    expect(w.lastAt).toBe(1_500_000)
  })

  it('撤销后不再是生效中——"不用盯了"要真的停', () => {
    const s = createTravelStore(storage)
    s.addWatch(watch())
    s.cancelWatch('w1')
    expect(s.watches()[0].status).toBe('cancelled')
    expect(s.activeWatches()).toHaveLength(0)
  })

  it('过了有效期的自动算过期，不用等谁来清', () => {
    const s = createTravelStore(storage)
    s.addWatch(watch({ expiresAt: 1_000_000 }))
    expect(s.activeWatches(999_999)).toHaveLength(1)
    expect(s.activeWatches(1_000_001)).toHaveLength(0)
  })

  it('记一次采样会顺带更新 lastAt——调度器靠它算下次什么时候采', () => {
    const s = createTravelStore(storage)
    s.addWatch(watch())
    s.addSample('w1', 1868, 1_200_000)
    expect(s.watches()[0].lastAt).toBe(1_200_000)
    expect(s.watches()[0].lastValue).toBe(1868)
  })
})

describe('采样样本：30 天滚动窗', () => {
  it('超过 30 天的样本自动淘汰，不让 localStorage 越攒越满', () => {
    const s = createTravelStore(storage)
    s.addWatch(watch())
    const now = 100 * DAY
    s.addSample('w1', 2400, now - 31 * DAY)
    s.addSample('w1', 2200, now - 29 * DAY)
    s.addSample('w1', 1868, now)
    const kept = s.samples('w1', now)
    expect(kept.map(x => x.value)).toEqual([2200, 1868])
  })

  it('按时间正序给出——画曲线不用调用方自己排', () => {
    const s = createTravelStore(storage)
    s.addWatch(watch())
    const now = 10 * DAY
    s.addSample('w1', 1900, now)
    s.addSample('w1', 2100, now - 2 * DAY)
    s.addSample('w1', 2000, now - DAY)
    expect(s.samples('w1', now).map(x => x.value)).toEqual([2100, 2000, 1900])
  })

  it('样本按委托分开——机票的曲线不能混进汇率的', () => {
    const s = createTravelStore(storage)
    s.addWatch(watch())
    s.addWatch(watch({ id: 'w2', kind: 'fx' }))
    s.addSample('w1', 1868, 1000)
    s.addSample('w2', 19420, 1000)
    expect(s.samples('w1', 2000).map(x => x.value)).toEqual([1868])
    expect(s.samples('w2', 2000).map(x => x.value)).toEqual([19420])
  })
})

describe('跨上下电存续', () => {
  it('新开一个仓能读回上次的任务与委托——关窗口不等于丢数据', () => {
    const a = createTravelStore(storage)
    a.addTask(task())
    a.addWatch(watch({ threshold: 2000 }))
    a.addSample('w1', 1868, 1_200_000)

    const b = createTravelStore(storage)      // 模拟重新上电
    expect(b.tasks()[0].title).toBe('韩国行')
    expect(b.watches()[0].threshold).toBe(2000)
    expect(b.samples('w1', 1_300_000).map(x => x.value)).toEqual([1868])
  })

  it('存储里是坏数据时兜底成空仓，不炸', () => {
    storage.set('cockpit-sim:travel', '{{{ 不是 JSON')
    const s = createTravelStore(storage)
    expect(s.tasks()).toEqual([])
    expect(s.watches()).toEqual([])
  })
})
