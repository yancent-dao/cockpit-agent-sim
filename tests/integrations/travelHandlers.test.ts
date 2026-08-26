import { describe, it, expect, beforeEach } from 'vitest'
import { createTravelHandlers, createTravelEngine } from '../../src/integrations/travelHandlers'
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
const DAY = 86_400_000
/** NOW 后第 n 天的 YYYY-MM-DD */
const dstr = (n: number) => new Date(NOW + n * DAY).toISOString().slice(0, 10)
let store: ReturnType<typeof createTravelStore>
let desk: ReturnType<typeof createDesk>
let h: ReturnType<typeof createTravelHandlers>
let wxCalls: Array<{ city: string; days: number }>

beforeEach(() => {
  store = createTravelStore(mem())
  desk = createDesk()
  wxCalls = []
  h = createTravelHandlers({
    store: () => store,
    desk: () => desk,
    sources: () => ({ flight: mockSource(() => NOW), hotel: mockSource(() => NOW) }),
    clock: () => NOW,
    weather: () => async (city, days) => {
      wxCalls.push({ city, days })
      return Array.from({ length: 16 }, (_, i) => ({
        date: dstr(i), weather: i % 2 ? '小雨' : '晴', hi: 21 - i, lo: 9 - i }))
    },
  })
})

const ok = (r: ToolResult) => { expect(r.status).toBe('ok'); return r }

describe('travel.plan：攻略数据进仓，trip 卡上屏', () => {
  const DAYS = [
    { title: '大皇宫 · 卧佛寺 · 考山路', stay: '曼谷·考山路',
      stops: [{ time: '09:00', name: '大皇宫', note: '门票 500 泰铢' }] },
    { title: '去芭提雅', stay: '芭提雅·海滩', cityChange: true,
      stops: [{ time: '08:30', name: '大巴去芭提雅' }] },
  ]

  it('建 draft 任务存下日程与行前准备，trip 卡上屏', async () => {
    const r = ok(await h.travelPlan({ destination: '曼谷', days: DAYS, prep: ['落地签', '换泰铢'] }))
    expect((r.data as any).taskId).toBeTruthy()
    const t = store.tasks()[0]
    expect(t.status).toBe('draft')
    expect(t.days).toHaveLength(2)
    expect(t.prep).toEqual(['落地签', '换泰铢'])
    const c = desk.findByKey('travel-trip')!
    expect(c.template).toBe('trip')
    expect((c.data as any).days).toHaveLength(2)
  })

  it('同目的地再 plan 是更新不是新建——防重判据跟 create 同一条', async () => {
    ok(await h.travelPlan({ destination: '曼谷', days: DAYS }))
    ok(await h.travelPlan({ destination: '曼谷', days: [DAYS[0]] }))
    expect(store.tasks()).toHaveLength(1)
    expect(store.tasks()[0].days).toHaveLength(1)
  })

  it('没有日程就拒——攻略卡的身份就是 Day-by-day', async () => {
    const r = await h.travelPlan({ destination: '曼谷' })
    expect(r.status).toBe('rejected')
    expect(r.code).toBe('INVALID_PARAMS')
  })

  it('没有目的地就拒', async () => {
    const r = await h.travelPlan({ days: DAYS })
    expect(r.status).toBe('rejected')
  })
})

describe('travel.plan 的选线阶段（v3：目的地宽泛先收敛）', () => {
  const LINES = [
    { name: '滇西北 · 雪山古城线', route: '昆明 → 大理 → 丽江', days: '6–8 天', note: '经典走法' },
    { name: '滇南 · 雨林风情线', route: '昆明 → 西双版纳', days: '5–6 天', note: '冬天最舒服' },
  ]

  it('只交 lines 不交 days：draft 任务存线路，trip 卡渲染选线列表', async () => {
    const r = ok(await h.travelPlan({ destination: '云南', lines: LINES }))
    expect((r.data as any).taskId).toBeTruthy()
    expect(store.tasks()[0].lines).toHaveLength(2)
    const c = desk.findByKey('travel-trip')!
    expect((c.data as any).lines).toHaveLength(2)
    expect((c.data as any).days).toBeUndefined()
  })

  it('选定后交 days，lines 自动清——选择题答完就撤', async () => {
    ok(await h.travelPlan({ destination: '云南', lines: LINES }))
    ok(await h.travelPlan({ destination: '云南',
      days: [{ title: 'D1 昆明', stops: [{ name: '滇池' }] }] }))
    expect(store.tasks()).toHaveLength(1)
    expect(store.tasks()[0].lines).toBeUndefined()
    expect((desk.findByKey('travel-trip')!.data as any).lines).toBeUndefined()
  })

  it('lines 和 days 都没有才拒', async () => {
    const r = await h.travelPlan({ destination: '云南' })
    expect(r.status).toBe('rejected')
  })
})

describe('行程天气（v3：确认后每天带天气，超窗不编造）', () => {
  const plan = () => h.travelPlan({ destination: '大理',
    days: [{ title: 'D1', stops: [{ name: '古城' }] },
           { title: 'D2', stops: [{ name: '洱海' }] }] })

  it('有出发日就拉 16 天预报，按行程日对齐存卡', async () => {
    ok(await plan())
    ok(await h.travelCreate({ destination: '大理', departDate: dstr(3) }))
    expect(wxCalls).toHaveLength(1)
    expect(wxCalls[0].city).toBe('大理')
    const wx = (desk.findByKey('travel-trip')!.data as any).wx
    expect(wx).toHaveLength(2)                       // 跟 days 对齐
    expect(wx[0].date).toBe(dstr(3))                 // D1 = 出发日
    expect(wx[0].hi).toBe(21 - 3)
  })

  it('出发日没定就不拉——没有日期哪来的天气', async () => {
    ok(await plan())
    expect(wxCalls).toHaveLength(0)
  })

  it('出发日超出 16 天预报窗：不拉不编造，卡上没有天气', async () => {
    ok(await plan())
    ok(await h.travelCreate({ destination: '大理', departDate: dstr(30) }))
    expect(wxCalls).toHaveLength(0)
    expect((desk.findByKey('travel-trip')!.data as any).wx).toBeUndefined()
  })

  it('改出发日重拉，天气跟着新日期走', async () => {
    ok(await plan())
    const t = (ok(await h.travelCreate({ destination: '大理', departDate: dstr(3) })).data as any).taskId
    ok(await h.travelUpdate({ taskId: t, departDate: dstr(5) }))
    expect(wxCalls).toHaveLength(2)
    expect((desk.findByKey('travel-trip')!.data as any).wx[0].date).toBe(dstr(5))
  })

  it('部分超窗：窗内的给，窗外的日子缺席——行程 5 天出发在第 14 天，只有前 2 天有天气', async () => {
    ok(await h.travelPlan({ destination: '大理',
      days: Array.from({ length: 5 }, (_, i) => ({ title: `D${i + 1}`, stops: [{ name: 'x' }] })) }))
    ok(await h.travelCreate({ destination: '大理', departDate: dstr(14) }))
    const wx = (desk.findByKey('travel-trip')!.data as any).wx
    expect(wx).toHaveLength(5)
    expect(wx[0]).toBeTruthy()      // D1 = 第14天,在窗内
    expect(wx[1]).toBeTruthy()      // D2 = 第15天,在窗内
    expect(wx[2]).toBeNull()        // D3 = 第16天,窗外
  })
})

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


  it('建了个没有行程内容的任务——message 提醒补 travel.plan（2026-08-25 实拍：模型把三天行程全念在嘴上、只调 create，屏上一张空卡）', async () => {
    const r = ok(await h.travelCreate({ destination: '首尔' }))
    expect(String(r.message)).toContain('travel.plan')
    // 有内容时不啰嗦
    ok(await h.travelPlan({ destination: '曼谷',
      days: [{ title: 'D1', stops: [{ name: '大皇宫' }] }] }))
    const r2 = ok(await h.travelCreate({ destination: '曼谷', departDate: dstr(3) }))
    expect(String(r2.message)).not.toContain('travel.plan')
  })

  it('startDate/endDate 是模型对参数名的常见退化——照收（同 {item} 展平先例）', async () => {
    ok(await h.travelCreate({ destination: '首尔',
      startDate: dstr(10), endDate: dstr(13) }))
    expect(store.tasks()[0].departDate).toBe(dstr(10))
    expect(store.tasks()[0].returnDate).toBe(dstr(13))
    expect(store.tasks()[0].status).toBe('active')
  })

  it('过去的日期是幻觉不是行程——不入仓，message 说明', async () => {
    const r = ok(await h.travelCreate({ destination: '首尔', departDate: '2023-07-15' }))
    expect(store.tasks()[0].departDate).toBeUndefined()
    expect(store.tasks()[0].status).toBe('draft')
    expect(String(r.message)).toMatch(/过去|已经过了/)
  })

  it('watch 项可带住宿段——多城市行程一段一条酒店监控，各盯各的价', async () => {
    const r = ok(await h.travelCreate({
      destination: '曼谷', departDate: '2026-09-06',
      watch: [
        { kind: 'flight' },
        { kind: 'hotel', stay: { city: '曼谷', dayFrom: 1, dayTo: 3 } },
        { kind: 'hotel', stay: { city: '芭提雅', dayFrom: 4, dayTo: 4 } },
      ],
    }))
    expect((r.data as any).watchIds).toHaveLength(3)
    const hotels = store.watches().filter(w => w.kind === 'hotel')
    expect(hotels.map(w => w.stay?.city)).toEqual(['曼谷', '芭提雅'])
    const card = desk.findByKey('travel-trip')!
    expect((card.data as any).stays).toHaveLength(2)
    expect((card.data as any).flight).toBeTruthy()   // 首采价直接进卡
  })

  it('先 plan 后 create：同一个任务原地生长，攻略数据不丢', async () => {
    ok(await h.travelPlan({ destination: '曼谷',
      days: [{ title: 'D1', stops: [{ name: '大皇宫' }] }] }))
    ok(await h.travelCreate({ destination: '曼谷', departDate: '2026-09-06',
      watch: [{ kind: 'flight' }] }))
    expect(store.tasks()).toHaveLength(1)
    expect(store.tasks()[0].days).toHaveLength(1)
    expect(store.tasks()[0].status).toBe('active')   // 确认即接管，draft 转正
    const card = desk.findByKey('travel-trip')!
    expect((card.data as any).days).toHaveLength(1)  // 攻略还在卡上
    expect((card.data as any).flight).toBeTruthy()   // 价格块长出来了
  })

  it('首采回填历史：源有 history 就一并入仓——不然刚建的监控 30 天后才有曲线（2026-08-25 实拍「监控项没有图」）', async () => {
    ok(await h.travelCreate({
      destination: '曼谷', departDate: '2026-09-06',
      watch: [{ kind: 'flight' }, { kind: 'hotel', stay: { city: '曼谷', dayFrom: 1, dayTo: 3 } }],
    }))
    for (const w of store.watches())
      expect(store.samples(w.id, NOW + 1000).length, '历史回填 + 首采').toBeGreaterThan(10)
    const card = desk.findByKey('travel-trip')!
    expect((card.data as any).flight.points.length).toBeGreaterThan(10)
    expect((card.data as any).stays[0].points.length).toBeGreaterThan(10)
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

  it('建完返回首采价——问价在 watch 这一步就闭环，不用再 refresh', async () => {
    const t = (ok(await h.travelCreate({ title: '韩国行', destination: '首尔' })).data as any).taskId
    const r = ok(await h.travelWatch({ taskId: t, kind: 'flight' }))
    expect((r.data as any).quote?.value).toBeGreaterThan(0)
    expect(String(r.message)).toContain('¥')
  })

  it('任务不存在就拒，不建孤儿委托', async () => {
    const r = await h.travelWatch({ taskId: '不存在', kind: 'flight' })
    expect(r.status).toBe('rejected')
  })

  it('travel.watch 单独建也回填历史并首采——跟 create 里配的一个待遇（lastAt 因此不再是空，调度器按节奏接着采）', async () => {
    const t = (ok(await h.travelCreate({ title: '韩国行', destination: '首尔' })).data as any).taskId
    ok(await h.travelWatch({ taskId: t, kind: 'flight' }))
    expect(store.samples(store.watches()[0].id, NOW + 1000).length).toBeGreaterThan(10)
    expect(store.watches()[0].lastAt).toBe(NOW)
  })

  it('源没接的 kind：watch 照建、lastAt 保持空——下一轮调度立刻采它', async () => {
    const t = (ok(await h.travelCreate({ title: '韩国行', destination: '首尔' })).data as any).taskId
    ok(await h.travelWatch({ taskId: t, kind: 'news' }))
    expect(store.watches()[0].lastAt).toBeUndefined()
  })
})

describe('travel.refresh：立即采一轮', () => {
  const setup = async (threshold?: number) => {
    const t = (ok(await h.travelCreate({ title: '韩国行', destination: '首尔' })).data as any).taskId
    ok(await h.travelWatch({ taskId: t, kind: 'flight', threshold, direction: 'below' }))
    return t
  }

  it('采完样本进仓，返回每项的最新值（建 watch 时已回填 30 天+首采，refresh 再 +1）', async () => {
    await setup()
    const before = store.samples(store.watches()[0].id, NOW + 1000).length
    const r = ok(await h.travelRefresh({}))
    expect((r.data as any).sampled).toBe(1)
    expect(store.samples(store.watches()[0].id, NOW + 1000)).toHaveLength(before + 1)
  })

  it('返回带每项最新价——2026-08-25 pilot 实拍：模型问价拿不到数，换着 label 连调 6 次 refresh 打转', async () => {
    await setup()
    const r = ok(await h.travelRefresh({}))
    const latest = (r.data as any).latest
    expect(latest).toHaveLength(1)
    expect(latest[0].kind).toBe('flight')
    expect(latest[0].value).toBeGreaterThan(0)
    expect(latest[0].text).toContain('¥')
    expect(String(r.message)).toContain('直接报')
  })

  it('跌破阈值 → 触发：trip 卡原地出决策条，不弹新卡', async () => {
    await setup(9999)                        // 必然跌破
    const r = ok(await h.travelRefresh({}))
    expect((r.data as any).fired).toHaveLength(1)
    expect(desk.findByKey(`travel-trend:${store.watches()[0].id}`)).toBeUndefined()
    expect((desk.findByKey('travel-trip')!.data as any).decide).toBeTruthy()
  })

  it('没触发就没有决策条——「无更新不开口」的卡片版', async () => {
    await setup(1)                           // 永远够不到
    ok(await h.travelRefresh({}))
    expect((desk.findByKey('travel-trip')!.data as any).decide).toBeUndefined()
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

  it('返回不回传 days/wx 全文——模型自己刚交的内容别再喂回去吃上下文（官方 token 效率）', async () => {
    ok(await h.travelPlan({ destination: '曼谷',
      days: [{ title: 'D1', stops: [{ name: '大皇宫', note: '很长的介绍'.repeat(10) }] }],
      prep: ['a', 'b'] }))
    const d = ok(await h.travelList({})).data as any
    expect(d.tasks[0].days).toBeUndefined()
    expect(d.tasks[0].wx).toBeUndefined()
    expect(d.tasks[0].dayCount).toBe(1)
  })

  it('行程单卡上屏', async () => {
    ok(await h.travelCreate({ title: '韩国行', destination: '首尔' }))
    ok(await h.travelList({}))
    expect(desk.findByKey('travel-trip')).toBeTruthy()
  })


  it('有 draft 任务时 message 把"确认即接管"的路摆出来——2026-08-25 pilot 实拍：确认后模型去 web.search 查价，create 从没被调', async () => {
    ok(await h.travelPlan({ destination: '曼谷',
      days: [{ title: 'D1', stops: [{ name: '大皇宫' }] }] }))
    const r = ok(await h.travelList({}))
    expect(String(r.message)).toContain('travel.create')
    expect(String(r.message)).toContain('quotes')
  })

  it('showTrend 点名一条委托 → 趋势卡上屏（钻取视图，点价格块的落点）', async () => {
    const t = (ok(await h.travelCreate({ title: '韩国行', destination: '首尔' })).data as any).taskId
    const w = (ok(await h.travelWatch({ taskId: t, kind: 'flight' })).data as any).watchId
    ok(await h.travelRefresh({}))
    ok(await h.travelList({ showTrend: w }))
    expect(desk.findByKey(`travel-trend:${w}`)).toBeTruthy()
  })

  it('一个任务都没有时说清楚，不上空卡', async () => {
    const r = ok(await h.travelList({}))
    expect((r.data as any).tasks).toEqual([])
    expect(desk.findByKey('travel-trip')).toBeUndefined()
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


  it('目的地变了要提醒模型：攻略/标题还是旧的、不需要的监控用 unwatch 真停（2026-08-25 实拍：改海口后卡片还是三亚攻略，模型嘴上说停掉监控却没调）', async () => {
    ok(await h.travelPlan({ destination: '三亚',
      days: [{ title: 'D1', stops: [{ name: '亚龙湾' }] }] }))
    const t = store.tasks()[0].id
    ok(await h.travelWatch({ taskId: t, kind: 'hotel' }))
    const r = ok(await h.travelUpdate({ taskId: t, destination: '海口' }))
    expect(String(r.message)).toContain('travel.plan')
    expect(String(r.message)).toContain('travel.unwatch')
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
    expect(desk.findByKey('travel-trip')).toBeTruthy()
    ok(await h.travelDelete({ taskId: t }))
    expect(desk.findByKey('travel-trip')).toBeUndefined()
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
    expect(store.samples(w, NOW + 1000).length, '样本留着，曲线还能看').toBeGreaterThan(0)
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

/* ══════════ 装配层用的采样引擎 ══════════ */

describe('createTravelEngine：定时采样的那一半', () => {
  const mkEngine = () => createTravelEngine({
    store: () => store, desk: () => desk,
    sources: () => ({ flight: mockSource(() => NOW), hotel: mockSource(() => NOW) }),
    clock: () => NOW,
  })

  it('items() 把生效中的委托和各自的采样节奏喂给调度器', async () => {
    const t = (ok(await h.travelCreate({ title: '韩国行', destination: '首尔' })).data as any).taskId
    ok(await h.travelWatch({ taskId: t, kind: 'flight' }))
    const items = mkEngine().items()
    expect(items).toHaveLength(1)
    expect(items[0].everyMs).toBe(3_600_000)   // 机票每小时
    expect(items[0].onBoot).toBe(true)
    expect(items[0].lastAt).toBe(NOW)          // 建完即回填+首采，调度器按节奏接着采
  })

  it('撤销的委托不再进调度——停了就是真停', async () => {
    const t = (ok(await h.travelCreate({ title: '韩国行', destination: '首尔' })).data as any).taskId
    const w = (ok(await h.travelWatch({ taskId: t, kind: 'flight' })).data as any).watchId
    ok(await h.travelUnwatch({ watchId: w }))
    expect(mkEngine().items()).toEqual([])
  })

  it('只采点名的那几项——机酒免费额度小，多采一次少一次', async () => {
    const t = (ok(await h.travelCreate({ title: '韩国行', destination: '首尔' })).data as any).taskId
    const a = (ok(await h.travelWatch({ taskId: t, kind: 'flight' })).data as any).watchId
    const b = (ok(await h.travelWatch({ taskId: t, kind: 'hotel' })).data as any).watchId
    const beforeA = store.samples(a, NOW + 1000).length
    const beforeB = store.samples(b, NOW + 1000).length
    await mkEngine().sampleDue([a])
    expect(store.samples(a, NOW + 1000)).toHaveLength(beforeA + 1)
    expect(store.samples(b, NOW + 1000)).toHaveLength(beforeB)
  })

  it('触发的在 trip 卡上出决策条并交回装配层，没触发的一个字不说', async () => {
    const t = (ok(await h.travelCreate({ title: '韩国行', destination: '首尔' })).data as any).taskId
    const hit = (ok(await h.travelWatch({ taskId: t, kind: 'flight', threshold: 9999 })).data as any).watchId
    const miss = (ok(await h.travelWatch({ taskId: t, kind: 'hotel', threshold: 1 })).data as any).watchId
    const fired = await mkEngine().sampleDue([hit, miss])
    expect(fired.map(f => f.watchId)).toEqual([hit])
    expect(desk.findByKey(`travel-trend:${hit}`)).toBeUndefined()  // 不弹新卡
    expect((desk.findByKey('travel-trip')!.data as any).decide).toBeTruthy()
  })

  it('交回的素材带趋势事实和示例标记，装配层照着叫醒模型', async () => {
    const t = (ok(await h.travelCreate({ title: '韩国行', destination: '首尔' })).data as any).taskId
    const w = (ok(await h.travelWatch({ taskId: t, kind: 'flight', threshold: 9999 })).data as any).watchId
    const fired = await mkEngine().sampleDue([w])
    expect(fired[0].trend).toBeTruthy()
    expect(fired[0].note).toContain('示例数据')
    expect(fired[0].label).toBeTruthy()
  })
})

describe('没装配时的降级：人话，不是 TypeError', () => {
  /**
   * 实拍（2026-08-25 pilot real-travel）：pilot 的 registry 没接 travel 仓，
   * 模型调 travel.list/refresh 直接炸 HANDLER_ERROR: Cannot read properties
   * of undefined——裸 TypeError 进了模型上下文，它只能瞎编一句"后台抽风"。
   * 拒绝必须携带机器可读原因 + 人话（核心原则第 4 条），没装配也一样。
   */
  it('仓没接时七个工具全部返回 unavailable + 人话，不抛', async () => {
    const bare = createTravelHandlers({
      store: () => undefined as any, desk: () => undefined,
      sources: () => ({}), clock: () => NOW,
    })
    for (const [name, args] of [
      ['travelCreate', { destination: '首尔' }], ['travelWatch', { taskId: 'x', kind: 'flight' }],
      ['travelUnwatch', { watchId: 'x' }], ['travelList', {}], ['travelRefresh', {}],
      ['travelUpdate', { taskId: 'x' }], ['travelDelete', { taskId: 'x' }],
    ] as const) {
      const r = await (bare as any)[name](args)
      expect(r.status, name).toBe('unavailable')
      expect(r.code, name).toBe('NOT_WIRED')
      expect(String(r.message)).not.toMatch(/undefined|TypeError/)
    }
  })
})

describe('create 的两刀（2026-08-25 pilot 三连跑）', () => {
  /**
   * 防重：T4 屏上冒出"2 个行程"——后台子代理查机票时自己又 create 了
   * 一个曼谷任务。判据是数据形状（同目的地 + 非归档已存在），不是猜意图：
   * 复用返回已有任务，不新建。
   */
  it('同目的地已有活跃任务 → 复用它，不建第二个', async () => {
    const a = ok(await h.travelCreate({ destination: '曼谷' }))
    const b = ok(await h.travelCreate({ destination: '曼谷', watch: [{ kind: 'flight' }] }))
    expect((b.data as any).taskId).toBe((a.data as any).taskId)
    expect(store.tasks()).toHaveLength(1)
    expect(String(b.message)).toContain('已经有')
  })

  it('复用时新的 watch 照样加上——不因复用丢掉这次要盯的项', async () => {
    ok(await h.travelCreate({ destination: '曼谷' }))
    ok(await h.travelCreate({ destination: '曼谷', watch: [{ kind: 'flight' }] }))
    expect(store.watches()).toHaveLength(1)
  })

  it('已归档的不算重——去过曼谷还能再去', async () => {
    const a = ok(await h.travelCreate({ destination: '曼谷' }))
    store.updateTask((a.data as any).taskId, { status: 'archived' })
    const b = ok(await h.travelCreate({ destination: '曼谷' }))
    expect((b.data as any).taskId).not.toBe((a.data as any).taskId)
  })

  /**
   * 首采价：实拍模型建完任务手里没数，宁可 delegate 后台查价，用户催了
   * 三轮才拿到参考价。create 建完 watch 立即采一轮，价直接带在返回里——
   * "机票现在多少钱"在建任务这一步就闭环，模型没有理由再去别处查。
   */
  it('create 带 watch 时返回里直接有首采价（含示例标记）', async () => {
    const r = ok(await h.travelCreate({
      destination: '曼谷', watch: [{ kind: 'flight' }, { kind: 'hotel' }],
    }))
    const q = (r.data as any).quotes
    expect(q).toHaveLength(2)
    expect(q[0].value).toBeGreaterThan(0)
    expect(q[0].label).toBeTruthy()
    expect(JSON.stringify(q)).toContain('示例数据')
    expect(String(r.message)).toContain('参考价')
  })

  it('没配 watch 就没有 quotes，不硬凑', async () => {
    const r = ok(await h.travelCreate({ destination: '曼谷' }))
    expect((r.data as any).quotes).toEqual([])
  })

  it('源没接的 kind 采不到就跳过，create 本身照样成功', async () => {
    const r = ok(await h.travelCreate({ destination: '曼谷', watch: [{ kind: 'news' }] }))
    expect(r.status).toBe('ok')
    expect((r.data as any).quotes).toEqual([])
  })
})
