import { describe, it, expect, beforeEach } from 'vitest'
import { sampleRound, fxSource, type PriceSource } from '../../src/integrations/travelSources'
import { createTravelStore, type TravelWatch } from '../../src/state/travel'
import type { DomainStorage } from '../../src/state/domain'

/**
 * 采样一轮（旅行助手，2026-08-20）。调度器说"这几个该采了"，这里负责
 * 真去取数、写样本、判阈值，把触发了的交回装配层去建卡播报。
 *
 * ## 为什么要可插拔的源
 *
 * 机票酒店的数据源还在选（Amadeus 国内覆盖差，RapidAPI 候选调研中）。
 * 源做成一张 kind → source 的表之后，这个决定就不阻塞任何进度：
 * **没接的 kind 直接跳过，接上就是往表里加一行**。这正是「加能力 = 加数据」——
 * 换 CP 不该改采样逻辑一行代码。
 */

const mem = (): DomainStorage => {
  const m = new Map<string, string>()
  return { get: k => m.get(k) ?? null, set: (k, v) => m.set(k, v) }
}

const watch = (over: Partial<TravelWatch> = {}): TravelWatch => ({
  id: 'w1', taskId: 't1', kind: 'flight', label: '成都→首尔',
  status: 'active', ...over,
})

/** 假源：想给什么值给什么值，也能装死 */
const stub = (value: number | Error): PriceSource => ({
  quote: async () => {
    if (value instanceof Error) throw value
    return { value, at: 2_000_000 }
  },
})

let store: ReturnType<typeof createTravelStore>
beforeEach(() => { store = createTravelStore(mem()) })

describe('采一轮：取数 → 写样本', () => {
  it('样本写进仓，委托的 lastAt 跟着更新', async () => {
    store.addWatch(watch())
    await sampleRound(store, ['w1'], { flight: stub(1868) })
    expect(store.samples('w1', 2_100_000).map(s => s.value)).toEqual([1868])
    expect(store.watches()[0].lastAt).toBe(2_000_000)
  })

  it('只采点名的那些，没点名的一个不动', async () => {
    store.addWatch(watch())
    store.addWatch(watch({ id: 'w2' }))
    await sampleRound(store, ['w1'], { flight: stub(1868) })
    expect(store.samples('w2', 2_100_000)).toEqual([])
  })

  it('多个一起采是并发的，不是排队——15 个区县天气那次的教训', async () => {
    for (let i = 1; i <= 5; i++) store.addWatch(watch({ id: `w${i}` }))
    let peak = 0, live = 0
    const slow: PriceSource = {
      quote: async () => {
        live++; peak = Math.max(peak, live)
        await new Promise(r => setTimeout(r, 5))
        live--
        return { value: 1868, at: 2_000_000 }
      },
    }
    await sampleRound(store, ['w1', 'w2', 'w3', 'w4', 'w5'], { flight: slow })
    expect(peak).toBeGreaterThan(1)
  })
})

describe('阈值判定：边沿触发，只响一次', () => {
  it('跌破阈值 → 触发，仓里状态变 fired', async () => {
    store.addWatch(watch({ threshold: 2000, direction: 'below' }))
    const fired = await sampleRound(store, ['w1'], { flight: stub(1868) })
    expect(fired.map(f => f.watch.id)).toEqual(['w1'])
    expect(fired[0].value).toBe(1868)
    expect(store.watches()[0].status).toBe('fired')
  })

  it('没跌破 → 不触发，状态还是 active', async () => {
    store.addWatch(watch({ threshold: 2000, direction: 'below' }))
    expect(await sampleRound(store, ['w1'], { flight: stub(2150) })).toEqual([])
    expect(store.watches()[0].status).toBe('active')
  })

  it('已经触发过的不再触发——边沿，不是持续满足就一直响', async () => {
    store.addWatch(watch({ threshold: 2000, direction: 'below' }))
    await sampleRound(store, ['w1'], { flight: stub(1868) })
    const again = await sampleRound(store, ['w1'], { flight: stub(1850) })
    expect(again).toEqual([])
  })

  it('没设阈值的只采样不触发——趋势用的监控项不该弹提醒', async () => {
    store.addWatch(watch({ threshold: undefined }))
    expect(await sampleRound(store, ['w1'], { flight: stub(1868) })).toEqual([])
    expect(store.samples('w1', 2_100_000)).toHaveLength(1)
  })

  it('direction: above 反过来判——汇率盯的是「涨到多少」', async () => {
    store.addWatch(watch({ kind: 'fx', threshold: 21000, direction: 'above' }))
    const fired = await sampleRound(store, ['w1'], { fx: stub(21200) })
    expect(fired).toHaveLength(1)
  })
})

describe('降级：一项坏了不许拖垮一轮', () => {
  it('源抛错时那一项跳过，别的照采——PRD 5.6 数据拉取失败不静默也不炸', async () => {
    store.addWatch(watch({ id: 'bad' }))
    store.addWatch(watch({ id: 'good', kind: 'fx' }))
    const fired = await sampleRound(store, ['bad', 'good'], {
      flight: stub(new Error('上游 503')),
      fx: stub(20768),
    })
    expect(store.samples('bad', 2_100_000)).toEqual([])
    expect(store.samples('good', 2_100_000).map(s => s.value)).toEqual([20768])
    expect(fired).toEqual([])
  })

  it('这个 kind 还没接源 → 静默跳过，不炸——机酒选型未定时整条链路照跑', async () => {
    store.addWatch(watch({ kind: 'hotel' }))
    await expect(sampleRound(store, ['w1'], { fx: stub(20768) })).resolves.toEqual([])
    expect(store.samples('w1', 2_100_000)).toEqual([])
  })

  it('id 在仓里找不到 → 跳过，不炸', async () => {
    await expect(sampleRound(store, ['幽灵'], { flight: stub(1868) })).resolves.toEqual([])
  })
})

describe('fxSource：把汇率客户端包成一个源', () => {
  const fakeFx = {
    latest: async () => ({ date: '2026-08-20', rate: 207.68, per100: 20768 }),
    series: async () => [
      { date: '2026-08-18', rate: 206, per100: 20600 },
      { date: '2026-08-19', rate: 207, per100: 20700 },
    ],
  }

  it('报的是 per100——跟卡上、跟人说的口径一致', async () => {
    const s = fxSource(fakeFx as any, () => 2_000_000)
    const q = await s.quote(watch({ kind: 'fx', label: 'CNY→KRW' }))
    expect(q.value).toBe(20768)
  })

  it('历史直接从上游拿，不用自己攒——这是选 frankfurter 的主要理由', async () => {
    const s = fxSource(fakeFx as any, () => 2_000_000)
    const h = await s.history!(watch({ kind: 'fx', label: 'CNY→KRW' }), 30)
    expect(h.map(p => p.value)).toEqual([20600, 20700])
  })

  it('label 里没有币种对时用默认 CNY→KRW，不抛——待定态任务的 label 可能还很粗', async () => {
    const s = fxSource(fakeFx as any, () => 2_000_000)
    await expect(s.quote(watch({ kind: 'fx', label: '换汇' }))).resolves.toBeTruthy()
  })
})
