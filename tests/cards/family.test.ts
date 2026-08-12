import { describe, it, expect } from 'vitest'
import { createDesk } from '../../src/cards/desk'
import { createStore } from '../../src/core/store'
import { createNavHandlers } from '../../src/integrations/navHandlers'
import { SIGNALS } from '../../src/config/signals'
import { CONSTRAINTS } from '../../src/config/constraints'

/**
 * 卡片家族：同名实体的身份策略。
 *
 * 实测取证：天气 key 是 weather:${adcode}，为"周边哪个县最凉快"的**并行对比**
 * 特意设计（真实 pilot 场景）；但顺序单查（成都→北京）就成了堆卡。
 * 两个诉求同时满足：批 = runtime 调用轮次——同一轮并行共存，新一轮替换旧批。
 * 不用时间窗魔数：轮次是真实边界（同一轮 = 同一个意图的并行展开）。
 */

const wx = (city: string, round?: number) => ({
  key: `weather:${city}`, family: 'weather', round,
  template: 'weather' as const, size: '1/6' as const, ttl: 'untilDismissed' as const,
  data: { title: `${city}天气`, now: { temperature: 30, weather: '晴' } },
})

describe('desk 层：同轮并存，新轮替换', () => {
  it('同一轮并行查五个县 → 五张并存', () => {
    const d = createDesk()
    for (const c of ['延庆', '密云', '怀柔', '平谷', '昌平']) d.render(wx(c, 7) as any)
    expect(d.layout().cards).toHaveLength(5)
  })

  it('新一轮单查北京 → 旧批全部退场，只剩北京', () => {
    const d = createDesk()
    d.render(wx('成都', 1) as any)
    d.render(wx('北京', 2) as any)
    const titles = d.layout().cards.map(c => c.data.title)
    expect(titles).toEqual(['北京天气'])
  })

  it('别的家族不受波及', () => {
    const d = createDesk()
    d.show({ template: 'feedback', size: '1/6', ttl: 'untilDismissed', data: { title: '车窗好了', text: 'x' } })
    d.render(wx('成都', 1) as any)
    d.render(wx('北京', 2) as any)
    expect(d.layout().cards.map(c => c.data.title)).toContain('车窗好了')
  })

  it('没给 round 的家族卡：每次都是新批（顺序替换语义）', () => {
    const d = createDesk()
    d.render(wx('成都') as any)
    d.render(wx('北京') as any)
    expect(d.layout().cards.map(c => c.data.title)).toEqual(['北京天气'])
  })

  it('同 key 刷新（同城再查）不自杀：成都刷成都还是一张', () => {
    const d = createDesk()
    d.render(wx('成都', 1) as any)
    d.render(wx('成都', 2) as any)
    expect(d.layout().cards).toHaveLength(1)
  })
})

describe('家族清扫也算空间释放', () => {
  it('五张换一张腾出的空间，2 秒后让被压的卡回落', () => {
    let now = 0
    const d = createDesk(() => now)
    d.show({ template: 'list', size: '1/2', ttl: 'untilDismissed',
      data: { title: '候选', items: Array.from({ length: 8 }, (_, i) => ({ label: 'x' + i })) } })
    // 同轮五张县城天气把候选压小
    for (const c of ['a', 'b', 'c', 'd', 'e']) { now += 10; d.render(wx(c, 1) as any) }
    const pressed = d.layout().cards.find(c => c.data.title === '候选')!.size
    expect(d.cellsOf(pressed)).toBeLessThan(d.cellsOf('1/2'))
    // 新一轮只剩一张 → 清扫腾位 → 2 秒后回落
    now += 10; d.render(wx('北京', 2) as any)
    now += 2500; d.tick()
    expect(d.layout().cards.find(c => c.data.title === '候选')!.size).toBe('1/2')
  })
})

describe('handler 层：weatherQuery 带上家族与轮次，ttl 不再定时蒸发', () => {
  const fakeAmap = {
    geocode: async (q: string) => ({ adcode: q === '成都' ? '510100' : '110000', formattedAddress: q, location: '1,1' }),
    weatherNow: async () => ({ temperature: 30, weather: '晴', wind: '北风3级', humidity: 40 }),
    weatherForecast: async () => [],
  } as any

  const boot = () => {
    let now = 0
    const store = createStore(SIGNALS, CONSTRAINTS)
    const desk = createDesk(() => now)
    let round = 0
    const h = createNavHandlers(store, () => fakeAmap, () => desk, () => round)
    return { h, desk, setRound: (r: number) => { round = r }, tickHours: (n: number) => { now += n * 3600_000; desk.tick() } }
  }

  it('顺序两次查询（两轮）→ 一张卡，显示后一城', async () => {
    const { h, desk, setRound } = boot()
    setRound(1); await h.weatherQuery({ location: '成都' })
    setRound(2); await h.weatherQuery({ location: '北京' })
    const cards = desk.layout().cards
    expect(cards).toHaveLength(1)
    expect(cards[0].data.title).toContain('北京')
  })

  it('同轮并行查两城 → 两张并存（对比场景不回退）', async () => {
    const { h, desk, setRound } = boot()
    setRound(5)
    await Promise.all([h.weatherQuery({ location: '成都' }), h.weatherQuery({ location: '北京' })])
    expect(desk.layout().cards).toHaveLength(2)
  })

  it('天气卡是内容不是问题：放三小时也不自动消失（用户点名要求）', async () => {
    const { h, desk, setRound, tickHours } = boot()
    setRound(1); await h.weatherQuery({ location: '成都' })
    tickHours(3)
    expect(desk.layout().cards, '不许 120 秒蒸发').toHaveLength(1)
  })
})
