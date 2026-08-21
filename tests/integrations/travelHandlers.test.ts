import { describe, it, expect, beforeEach } from 'vitest'
import { createTravelHandlers } from '../../src/integrations/travelHandlers'
import { createTravelStore } from '../../src/state/travel'
import { createDesk } from '../../src/cards/desk'
import { mockSource } from '../../src/integrations/travelMock'
import type { DomainStorage } from '../../src/state/domain'
import type { ToolResult } from '../../src/tools/registry'

/**
 * 旅行助手七工具的 handlers（2026-08-20）。
 *
 * 机制归这里：校验 → 写仓 → 采样 → 上卡 → 人话回执。
 * **决策归模型**：建不建任务、盯什么、要不要提醒用户现在下手，一个都不在这。
 * 这里连一个 `if (用户说了什么)` 都没有。
 */

const mem = (): DomainStorage => {
  const m = new Map<string, string>()
  return { get: k => m.get(k) ?? null, set: (k, v) => m.set(k, v) }
}

const NOW = 1_756_000_000_000
let store: ReturnType<typeof createTravelStore>
let desk: ReturnType<typeof createDesk>
let h: ReturnType<typeof createTravelHandlers>

beforeEach(() => {
  store = createTravelStore(mem())
  desk = createDesk()
  h = createTravelHandlers({
    store: () => store,
    desk: () => desk,
    sources: () => ({ flight: mockSource(() => NOW), hotel: mockSource(() => NOW) }),
    clock: () => NOW,
  })
})

const ok = (r: ToolResult) => { expect(r.status).toBe('ok'); return r }

describe('travel.create：信息不全也照建', () => {
  it('只给目的地就能建——待定态，缺什么在返回里说清楚', async () => {
    const r = ok(await h.travelCreate({ title: '韩国行', destination: '首尔' }))
    const d = r.data as any
    expect(d.taskId).toBeTruthy()
    expect(d.pending).toContain('departDate')
    expect(store.tasks()[0].status).toBe('draft')
  })

  it('日期补齐了就是 active，不再待定', async () => {
    ok(await h.travelCreate({ title: '韩国行', destination: '首尔', departDate: '2026-09-02' }))
    expect(store.tasks()[0].status).toBe('active')
  })

  it('可以一次调用把监控项一起配上——PRD 要求建任务 ≤2 轮对话', async () => {
    const r = ok(await h.travelCreate({
      title: '韩国行', destination: '首尔', departDate: '2026-09-02',
      watch: [{ kind: 'flight', threshold: 2000 }, { kind: 'hotel' }],
    }))
    expect((r.data as any).watchIds).toHaveLength(2)
    expect(store.watches()).toHaveLength(2)
  })

  it('没有目的地就拒——这是任务的身份，没有它盯什么都不知道', async () => {
    const r = await h.travelCreate({ title: '出去玩' })
    expect(r.status).toBe('rejected')
    expect(r.code).toBe('INVALID_PARAMS')
  })
})

describe('travel.watch：建委托', () => {
  it('返回复述素材，话怎么说归模型', async () => {
    const t = (ok(await h.travelCreate({ title: '韩国行', destination: '首尔' })).data as any).taskId
    const r = ok(await h.travelWatch({ taskId: t, kind: 'flight', threshold: 2000, direction: 'below' }))
    expect((r.data as any).watchId).toBeTruthy()
    expect(String(r.message)).toContain('2000')
  })

  it('任务不存在就拒，不建孤儿委托', async () => {
    const r = await h.travelWatch({ taskId: '不存在', kind: 'flight' })
    expect(r.status).toBe('rejected')
  })

  it('新建的委托 lastAt 是空的——下一轮调度立刻采它（建完就有数）', async () => {
    const t = (ok(await h.travelCreate({ title: '韩国行', destination: '首尔' })).data as any).taskId
    ok(await h.travelWatch({ taskId: t, kind: 'flight' }))
    expect(store.watches()[0].lastAt).toBeUndefined()
  })
})

describe('travel.refresh：立即采一轮', () => {
  const setup = async (threshold?: number) => {
    const t = (ok(await h.travelCreate({ title: '韩国行', destination: '首尔' })).data as any).taskId
    ok(await h.travelWatch({ taskId: t, kind: 'flight', threshold, direction: 'below' }))
    return t
  }

  it('采完样本进仓，返回每项的最新值', async () => {
    await setup()
    const r = ok(await h.travelRefresh({}))
    expect((r.data as any).sampled).toBe(1)
    expect(store.samples(store.watches()[0].id, NOW + 1000)).toHaveLength(1)
  })

  it('跌破阈值 → 触发，趋势卡上屏', async () => {
    await setup(9999)                        // 必然跌破
    const r = ok(await h.travelRefresh({}))
    expect((r.data as any).fired).toHaveLength(1)
    expect(desk.findByKey(`travel-trend:${store.watches()[0].id}`)).toBeTruthy()
  })

  it('没触发就不建卡——「无更新不开口」的卡片版', async () => {
    await setup(1)                           // 永远够不到
    ok(await h.travelRefresh({}))
    expect(desk.findByKey(`travel-trend:${store.watches()[0].id}`)).toBeUndefined()
  })

  it('示例数据的标记原样带进返回——模型看得见才不会说成实时价', async () => {
    await setup(9999)
    const r = ok(await h.travelRefresh({}))
    expect(JSON.stringify(r.data)).toContain('示例数据')
  })
})

describe('travel.list：问答的数据底座', () => {
  it('给出任务、委托和每项的趋势事实——但不给推荐', async () => {
    const t = (ok(await h.travelCreate({ title: '韩国行', destination: '首尔' })).data as any).taskId
    ok(await h.travelWatch({ taskId: t, kind: 'flight', threshold: 2000 }))
    ok(await h.travelRefresh({}))
    const d = ok(await h.travelList({})).data as any
    expect(d.tasks).toHaveLength(1)
    expect(d.watches[0].trend).toBeTruthy()
    expect(d.watches[0].trend.band).toBeTruthy()
    // 事实齐全，但没有任何"该不该买"的字段——那是模型的活
    expect(d.watches[0].verdict).toBeUndefined()
  })

  it('行程单卡上屏', async () => {
    ok(await h.travelCreate({ title: '韩国行', destination: '首尔' }))
    ok(await h.travelList({}))
    expect(desk.findByKey('travel-plan')).toBeTruthy()
  })

  it('一个任务都没有时说清楚，不上空卡', async () => {
    const r = ok(await h.travelList({}))
    expect((r.data as any).tasks).toEqual([])
    expect(desk.findByKey('travel-plan')).toBeUndefined()
  })
})

describe('travel.update：改了什么、影响哪几项', () => {
  it('返回新旧对照——影响摘要三要素的数据由这里给，话由模型组织', async () => {
    const t = (ok(await h.travelCreate({
      title: '韩国行', destination: '首尔', departDate: '2026-09-02',
    })).data as any).taskId
    ok(await h.travelWatch({ taskId: t, kind: 'flight' }))
    const r = ok(await h.travelUpdate({ taskId: t, departDate: '2026-09-03' }))
    const d = r.data as any
    expect(d.changed).toEqual([{ field: 'departDate', from: '2026-09-02', to: '2026-09-03' }])
    expect(d.affected).toHaveLength(1)
  })

  it('什么都没改时如实说没变，不编影响', async () => {
    const t = (ok(await h.travelCreate({
      title: '韩国行', destination: '首尔', departDate: '2026-09-02',
    })).data as any).taskId
    const r = ok(await h.travelUpdate({ taskId: t, departDate: '2026-09-02' }))
    expect((r.data as any).changed).toEqual([])
  })
})

describe('travel.delete：删了要说停了哪些', () => {
  it('返回被停掉的监控项清单——收场话术要念出来', async () => {
    const t = (ok(await h.travelCreate({ title: '韩国行', destination: '首尔' })).data as any).taskId
    ok(await h.travelWatch({ taskId: t, kind: 'flight' }))
    ok(await h.travelWatch({ taskId: t, kind: 'hotel' }))
    const r = ok(await h.travelDelete({ taskId: t }))
    expect((r.data as any).stopped).toHaveLength(2)
    expect(store.tasks()).toHaveLength(0)
  })

  it('删完桌面上跟它相关的卡也撤掉——留着就是在显示一个不存在的行程', async () => {
    const t = (ok(await h.travelCreate({ title: '韩国行', destination: '首尔' })).data as any).taskId
    ok(await h.travelList({}))
    expect(desk.findByKey('travel-plan')).toBeTruthy()
    ok(await h.travelDelete({ taskId: t }))
    expect(desk.findByKey('travel-plan')).toBeUndefined()
  })

  it('删不存在的任务如实说没有，不假装删成功', async () => {
    const r = await h.travelDelete({ taskId: '不存在' })
    expect(r.status).toBe('rejected')
  })
})

describe('travel.unwatch：不用盯了', () => {
  it('撤销后不再生效，但样本留着——曲线还能看', async () => {
    const t = (ok(await h.travelCreate({ title: '韩国行', destination: '首尔' })).data as any).taskId
    const w = (ok(await h.travelWatch({ taskId: t, kind: 'flight' })).data as any).watchId
    ok(await h.travelRefresh({}))
    ok(await h.travelUnwatch({ watchId: w }))
    expect(store.activeWatches(NOW)).toHaveLength(0)
    expect(store.samples(w, NOW + 1000)).toHaveLength(1)
  })
})

describe('机制/策略的界线', () => {
  it('handler 里没有任何一句在解析用户说了什么', async () => {
    const src = await import('node:fs').then(fs =>
      fs.readFileSync('src/integrations/travelHandlers.ts', 'utf8'))
    expect(src).not.toMatch(/includes\(['"`](想|要|帮我|盯|买)/)
    expect(src).not.toMatch(/intent\s*===/)
  })
})
