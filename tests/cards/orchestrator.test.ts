import { describe, it, expect, beforeEach } from 'vitest'
import { createStore } from '../../src/core/store'
import { createDesk } from '../../src/cards/desk'
import { createOrchestrator } from '../../src/cards/orchestrator'
import { CARD_RULES, DATA_BUILDERS } from '../../src/config/cardRules'
import { CARD_TEMPLATES } from '../../src/config/cards'
import { SIGNALS } from '../../src/config/signals'
import { CONSTRAINTS } from '../../src/config/constraints'
import { createAmapClient, type Fetcher } from '../../src/integrations/amap'

let now = 1000
let store: ReturnType<typeof createStore>
let desk: ReturnType<typeof createDesk>

const fakeAmap = () => createAmapClient((async () => ({ ok: true, json: async () => ({}) })) as Fetcher, { webKey: 'k' })

const boot = () => {
  const o = createOrchestrator({
    store, desk, rules: CARD_RULES, builders: DATA_BUILDERS,
    deps: { store, amap: fakeAmap() },
  })
  o.start()
  return o
}

beforeEach(() => {
  now = 1000
  store = createStore(SIGNALS, CONSTRAINTS)
  desk = createDesk(() => now)
})

/* ══════════════ 状态卡规则：导航 ══════════════ */
describe('导航状态卡：navigation.active 驱动，模型零参与', () => {
  it('导航激活 → 2/3 导航卡自动出现，数据来自信号', () => {
    boot()
    store.setDirect('navigation.destination', '春熙路')
    store.setDirect('navigation.eta', 13)
    store.setDirect('navigation.distanceRemaining', 2.3)
    store.setDirect('navigation.destinationLocation', '104.07,30.65')
    store.setDirect('navigation.active', true)
    const nav = desk.findByKey('nav')!
    expect(nav).toBeTruthy()
    expect(nav.size).toBe('stage')
    expect(nav.kind).toBe('rule')
    expect(nav.evictable).toBe(false)
    expect(nav.data.destination).toBe('春熙路')
    expect(nav.data.eta).toBe(13)
    expect(nav.data.mapUrl).toContain('/v3/staticmap?')
  })

  // 实测："先去充电站再去太古里"——话术说了，导航卡标题只有"去成都太古里"，
  // 看屏幕根本不知道要绕路
  it('有途经点时导航卡说得出经过哪儿', () => {
    boot()
    store.setDirect('navigation.destination', '成都太古里')
    store.setDirect('navigation.destinationLocation', '104.10,30.60')
    store.setDirect('navigation.waypointNames', '特来电中环广场')
    store.setDirect('navigation.active', true)
    expect(desk.findByKey('nav')!.data.via).toEqual(['特来电中环广场'])
  })

  it('没有途经点时 via 为空，不占位置', () => {
    boot()
    store.setDirect('navigation.destination', '春熙路')
    store.setDirect('navigation.destinationLocation', '104.07,30.65')
    store.setDirect('navigation.active', true)
    expect(desk.findByKey('nav')!.data.via).toEqual([])
  })

  // 规则不写 size 时用模板的 defaultSize——改默认尺寸只改一处
  it('规则没写尺寸就用模板的默认值', () => {
    // 用 confirm（默认 1/3）而不是 control（默认 1/6）——后者跟 render 的兜底值撞了，测不出区别
    const rules = [{ id: 'w', watch: ['cabin.window.driver.position'],
      card: { key: 'w', template: 'confirm', ttl: 30, data: 'windowCard' } }]
    createOrchestrator({ store, desk, rules: rules as any, builders: DATA_BUILDERS, deps: { store } }).start()
    store.setDirect('cabin.window.driver.position', 50)
    expect(desk.findByKey('w')!.size).toBe('wide')
    expect(CARD_TEMPLATES.find(t => t.id === 'confirm')!.defaultSize).toBe('wide')
  })

  it('导航卡带上画活地图需要的坐标：起点/终点/路线', () => {
    boot()
    store.setDirect('vehicle.location', '104.06,30.65')
    store.setDirect('navigation.destinationLocation', '104.10,30.60')
    store.setDirect('navigation.routePolyline', '104.06,30.65;104.08,30.62;104.10,30.60')
    store.setDirect('navigation.active', true)
    const d = desk.findByKey('nav')!.data
    expect(d.originLoc).toBe('104.06,30.65')
    expect(d.destLoc).toBe('104.10,30.60')
    expect(d.polyline).toContain('104.08,30.62')
    expect(d.mapUrl).toBeTruthy() // 静态图仍在，作为 JS 地图加载失败时的兜底
  })

  it('watch 的信号变化 → 卡片数据自动刷新，不新建', () => {
    boot()
    store.setDirect('navigation.active', true)
    const id = desk.findByKey('nav')!.id
    store.setDirect('navigation.eta', 8)
    const nav = desk.findByKey('nav')!
    expect(nav.id).toBe(id) // 同一张卡
    expect(nav.data.eta).toBe(8)
  })

  it('导航结束 → 卡片自动退场', () => {
    boot()
    store.setDirect('navigation.active', true)
    expect(desk.findByKey('nav')).toBeTruthy()
    store.setDirect('navigation.active', false)
    expect(desk.findByKey('nav')).toBeUndefined()
  })

  it('编排器启动时评估当前状态——导航已在进行也能出卡（刷新页面场景）', () => {
    store.setDirect('navigation.active', true)
    boot()
    expect(desk.findByKey('nav')).toBeTruthy()
  })

  it('没有 amap 依赖时降级：卡照出，只是没有 mapUrl', () => {
    const o = createOrchestrator({
      store, desk, rules: CARD_RULES, builders: DATA_BUILDERS, deps: { store },
    })
    o.start()
    store.setDirect('navigation.active', true)
    const nav = desk.findByKey('nav')!
    expect(nav).toBeTruthy()
    expect(nav.data.mapUrl).toBeUndefined()
  })
})

/* ══════════════ 事件卡规则：全量车控反馈 ══════════════ */
describe('车控事件卡：调什么显示什么，全部规则驱动', () => {
  it('空调调温 → 空调卡出现，含开关/温度/风量', () => {
    boot()
    store.setDirect('cabin.climate.targetTemp', 26)
    const c = desk.findByKey('climate')!
    expect(c).toBeTruthy()
    expect(c.data.items.find((i: any) => i.label === '温度').value).toBe(26)
  })

  it('座椅加热 → 座椅卡出现，只显示非零项', () => {
    boot()
    store.setDirect('seat.driver.heating', 2)
    const c = desk.findByKey('seats')!
    expect(c).toBeTruthy()
    const labels = c.data.items.map((i: any) => i.label)
    expect(labels).toContain('主驾加热')
    expect(labels).not.toContain('副驾加热') // 副驾是 0，不显示
  })

  it('氛围灯换色 → 氛围灯卡出现，颜色显示中文', () => {
    boot()
    store.setDirect('cabin.ambientLight.color', 'blue')
    const c = desk.findByKey('ambient')!
    expect(c).toBeTruthy()
    expect(c.data.items.find((i: any) => i.label === '颜色').value).toBe('蓝色')
  })

  it('驾驶模式切换 → 驾驶设置卡出现', () => {
    boot()
    store.setDirect('vehicle.driveMode', 'sport')
    const c = desk.findByKey('drive')!
    expect(c).toBeTruthy()
    expect(c.data.items.find((i: any) => i.label === '驾驶模式').value).toBe('运动')
  })

  it('开车门 → 门/舱盖卡出现，显示开着的那扇', () => {
    boot()
    store.setDirect('cabin.door.driver.isOpen', true)
    const c = desk.findByKey('openings')!
    expect(c).toBeTruthy()
    expect(c.data.items.map((i: any) => i.label)).toContain('主驾车门')
  })
})

/* ══════════════ 事件卡规则：车窗反馈 ══════════════ */
describe('车窗事件卡：位置一动就出现，之后一直留着', () => {
  it('车窗位置变化 → 车控卡出现', () => {
    boot()
    store.setDirect('cabin.window.driver.position', 60)
    const w = desk.findByKey('windows')!
    expect(w).toBeTruthy()
    expect(w.template).toBe('control')
    expect(w.data.items.find((i: any) => i.key === 'driver').value).toBe(60)
  })

  /**
   * 2026-08-12 改：车控反馈卡不再 30 秒定时退场。
   * 演示时最常见的抱怨是「我还没讲到它就没了」，而 30 这个数字本来就是拍的 ——
   * 瞟一眼车窗开度要 3 秒，讲解一段要 2 分钟，同一个数字伺候不了两种场合。
   * 桌面满了自然会挤（七档缩放 + LRU），让空间竞争决定谁退场。
   */
  it('放着不管也不会自己消失', () => {
    boot()
    store.setDirect('cabin.window.driver.position', 60)
    now += 10 * 60_000; desk.tick()
    expect(desk.findByKey('windows'), '十分钟后还在').toBeTruthy()
  })

  /** refreshTtl 机制本身还在，只是暂时没有规则用它 —— 留着给真会过期的卡 */
  it('机制还在：给了秒数的卡活动期间刷新寿命，停下才过期', () => {
    boot()
    const push = (v: number) => desk.render({
      key: 'q', template: 'confirm', size: 'wide', ttl: 30, refreshTtl: true,
      data: { title: '要哪个', question: 'q' + v },
    })
    push(1)
    now += 25_000
    push(2)                    // 再动一下 → 刷新寿命
    now += 25_000; desk.tick()
    expect(desk.findByKey('q'), '距上次活动才 25s').toBeTruthy()
    now += 10_000; desk.tick()
    expect(desk.findByKey('q'), '35s > 30s').toBeUndefined()
  })
})

/**
 * 播放是持续态，跟车控卡"30 秒后退场"是两种生命周期，
 * 但跟导航卡完全一样——写一条规则就行，模型零参与。
 */
describe('播放器卡：media.playing 驱动', () => {
  const play = (over: Record<string, any> = {}) => {
    boot()
    store.setDirect('media.source', 'music')
    store.setDirect('media.track', '晴天')
    store.setDirect('media.artist', '周杰伦')
    for (const [k, v] of Object.entries(over)) store.setDirect(k, v)
    store.setDirect('media.playing', true)
  }

  it('开始播放 → 播放器卡自动出现，数据来自信号', () => {
    play()
    const c = desk.findByKey('player')!
    expect(c).toBeTruthy()
    expect(c.kind).toBe('rule')
    expect(c.data.track).toBe('晴天')
    expect(c.data.artist).toBe('周杰伦')
    expect(c.data.source).toBe('music')
  })

  // 2026-08-13 语义修正（用户实拍 bug）：暂停是状态不是退场理由。
  // 有内容加载着卡就在场（显示 ▶ 等继续），stop 清掉内容才退场
  it('暂停 → 卡片留着；stop（source=none）→ 退场', () => {
    play()
    expect(desk.findByKey('player')).toBeTruthy()
    store.setDirect('media.playing', false)
    expect(desk.findByKey('player'), '暂停不退卡').toBeTruthy()
    store.setDirect('media.source', 'none')
    expect(desk.findByKey('player')).toBeUndefined()
  })

  it('换曲只更新数据，不重建卡片——重建会打断播放器 DOM', () => {
    play()
    const id = desk.findByKey('player')!.id
    store.setDirect('media.track', '稻香')
    expect(desk.findByKey('player')!.id).toBe(id)
    expect(desk.findByKey('player')!.data.track).toBe('稻香')
  })

  /**
   * hall 的宽高比是 1.63，跟 16:9 只差 8% —— 1208 宽的画面 680 高，
   * 底下正好留一条 61px 的标题栏，几乎没有黑边。视频规则**显式钉住**它，
   * 不跟着模板默认档漂：默认档将来若改成 court(1.21)，视频就会上下各空一块。
   */
  it('视频规则把尺寸显式钉在 16:9 友好的 hall 上，不跟默认档漂', () => {
    const rule = CARD_RULES.find(r => r.id === 'media-playing-video')!
    expect((rule.card as any).size, '视频尺寸必须写死在规则里').toBe('hall')
    play({ 'media.source': 'video' })
    expect(desk.findByKey('player-video')!.size).toBe('hall')
  })

  // 两条规则 when 互斥，切来源时不能两张并存
  it('音乐切视频，屏上始终只有一张播放器卡', () => {
    play()
    play({ 'media.source': 'video' })
    const players = desk.layout().cards.filter(c => c.template === 'media')
    expect(players).toHaveLength(1)
    expect(players[0].data.source).toBe('video')
  })

  // 进度是遥测不是状态：每秒变好几次，进了 store 就是每秒重评规则、重刷卡片
  it('信号里没有播放进度', () => {
    // 只查 media.*——车窗位置也叫 position
    expect(SIGNALS.find(s => s.alias.startsWith('media.')
      && /position|progress|elapsed|duration/i.test(s.alias))).toBeUndefined()
  })
})
