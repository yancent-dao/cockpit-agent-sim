import { describe, it, expect, beforeEach } from 'vitest'
import { createStore } from '../../src/core/store'
import { createRegistry } from '../../src/tools/registry'
import { SIGNALS } from '../../src/config/signals'
import { CONSTRAINTS } from '../../src/config/constraints'
import { TOOLS } from '../../src/config/tools'

/**
 * 高德已有 Key 白捡（接入清单梯队 01）：图层/模拟行驶进 map.control、
 * 交通态势工具化、搜空时 inputtips 兜底。
 * 全部是"接口早就有/一行图层代码的事"，接上才算数。
 */

let store: ReturnType<typeof createStore>
beforeEach(() => { store = createStore(SIGNALS, CONSTRAINTS) })

describe('map.control 扩展：图层与模拟行驶', () => {
  const mk = () => createRegistry(store, TOOLS, Date.now, {} as any)
  it('卫星底图是一种 style', async () => {
    const r = await mk().invoke('map.control', { style: 'satellite' })
    expect(r.status).toBe('ok')
    expect(store.get('navigation.mapStyle')).toBe('satellite')
  })
  it('路况图层是开关信号', async () => {
    const r = await mk().invoke('map.control', { traffic: true })
    expect(r.status).toBe('ok')
    expect(store.get('navigation.mapTraffic')).toBe(true)
  })
  it('模拟行驶 start/stop 落成布尔信号，车机屏照着放动画', async () => {
    store.set('navigation.active', true)
    await mk().invoke('map.control', { cruise: 'start' })
    expect(store.get('navigation.cruise')).toBe(true)
    await mk().invoke('map.control', { cruise: 'stop' })
    expect(store.get('navigation.cruise')).toBe(false)
  })
  it('没在导航时拒绝模拟行驶——没有路线跑什么', async () => {
    const r = await mk().invoke('map.control', { cruise: 'start' })
    expect(r.status).toBe('rejected')
    expect(r.message).toContain('没在导航')
  })
})

describe('traffic.status 交通态势', () => {
  const amap = {
    geocode: async () => ({ location: '104.07,30.65', adcode: '510100', formattedAddress: '春熙路' }),
    trafficAround: async () => ({ status: 'slow', expedite: 61, congested: 24, blocked: 3 }),
  }
  const mk = () => createRegistry(store, TOOLS, Date.now, { amap } as any)
  it('不传地点按车辆位置查，message 是人话不是百分比堆', async () => {
    const r = await mk().invoke('traffic.status', {})
    expect(r.status).toBe('ok')
    expect(r.message).toContain('缓行')
    expect(r.message).toMatch(/61|畅通/)
  })
  it('传了地点先 geocode 再查', async () => {
    const r = await mk().invoke('traffic.status', { location: '春熙路' })
    expect(r.status).toBe('ok')
    expect(r.message).toContain('春熙路')
  })
})

describe('navigation.search 搜空时 inputtips 兜底', () => {
  it('POI 搜空 → 提示里带 district，让用户知道要找的地方在哪个城市', async () => {
    const amap = {
      cityOf: async () => '成都',
      placeSearch: async () => [],
      inputtips: async () => [
        { name: '临平区', district: '浙江省杭州市临平区', adcode: '330113', location: '120.29,30.41' },
      ],
    }
    const r = createRegistry(store, TOOLS, Date.now, { amap } as any)
    const res = await r.invoke('navigation.search', { query: '临平' })
    expect(res.status).toBe('unavailable')
    expect(res.message).toContain('杭州')
    expect(res.message).toContain('临平区')
  })
})

/**
 * defrost.set（2026-08-18，做雨天章法时发现的缺口）：车控 18 件里竟然
 * 没有除雾——雨天联动的第一反应就是它。声明式 writes，零 handler 代码。
 */
describe('defrost.set 除雾', () => {
  const mk = () => createRegistry(store, TOOLS, Date.now, {} as any)
  it('前后风挡分开控，写进信号', async () => {
    const r = await mk().invoke('defrost.set', { target: 'front', on: true })
    expect(r.status).toBe('ok')
    expect(store.get('cabin.defrost.front.isOn')).toBe(true)
    await mk().invoke('defrost.set', { target: 'rear', on: true })
    expect(store.get('cabin.defrost.rear.isOn')).toBe(true)
  })
  it('both 一次开双侧', async () => {
    const r = await mk().invoke('defrost.set', { target: 'both', on: true })
    expect(r.status).toBe('ok')
    expect(store.get('cabin.defrost.front.isOn')).toBe(true)
    expect(store.get('cabin.defrost.rear.isOn')).toBe(true)
  })
})

/**
 * navigation.modifyRoute（2026-08-25 实拍「加途经点老被改成终点」）。
 *
 * 根因是结构性的：加途经点没有自己的动词——模型要搜坐标、找回原目的地、
 * 重调 setDestination 全量重传，三步错任何一步终点就没了。这个工具
 * **根本没有 destination 参数**：终点保持是机制保证，模型想改都改不了。
 * 市场对齐：高德/百度车机的「途经 XX」「删除途经点」「躲避拥堵」都是
 * 导航中的一句话动作，不是重设目的地。
 */
describe('navigation.modifyRoute：改路不动终点', () => {
  const amap = {
    geocode: async (addr: string) => ({ location: '104.10,30.70', formattedAddress: addr }),
    placeSearch: async (q: string) => [{ id: 'p1', name: q, location: '104.08,30.66', address: 'x' }],
    driving: async (_o: string, dest: string, opts: any) => ({
      distance: 8200, duration: (18 + (opts?.waypoints?.length ?? 0) * 5) * 60,
      steps: [{ instruction: '直行' }], polyline: '1,1;2,2', dest,
    }),
  }
  const nav = () => {
    store.set('vehicle.location', '104.06,30.54')
    store.set('navigation.active', true)
    store.set('navigation.destination', '春熙路')
    store.set('navigation.destinationLocation', '104.07,30.65')
    store.set('navigation.eta', 18)
    store.set('navigation.waypoints', '')
    store.set('navigation.waypointNames', '')
  }
  const mk = () => createRegistry(store, TOOLS, Date.now, { amap } as any)

  it('按名字加途经点：终点纹丝不动，途经点落信号，返回带绕路代价', async () => {
    nav()
    const r = await mk().invoke('navigation.modifyRoute', { addWaypoint: '特来电充电站' })
    expect(r.status).toBe('ok')
    expect(store.get('navigation.destination'), '终点是机制锁死的').toBe('春熙路')
    expect(String(store.get('navigation.waypointNames'))).toContain('特来电充电站')
    expect(JSON.stringify(r.data)).toMatch(/detour|绕路|deltaEta/)
  })

  it('按坐标加途经点（来自 searchAlong 的 location）不再搜一遍', async () => {
    nav()
    const r = await mk().invoke('navigation.modifyRoute',
      { addWaypoint: '104.09,30.60', addWaypointName: '服务区' })
    expect(r.status).toBe('ok')
    expect(String(store.get('navigation.waypoints'))).toContain('104.09,30.60')
    expect(String(store.get('navigation.waypointNames'))).toContain('服务区')
  })

  it('删途经点按名字：其余保留', async () => {
    nav()
    store.set('navigation.waypoints', '104.09,30.60;104.10,30.61')
    store.set('navigation.waypointNames', '服务区;充电站')
    const r = await mk().invoke('navigation.modifyRoute', { removeWaypoint: '服务区' })
    expect(r.status).toBe('ok')
    expect(String(store.get('navigation.waypointNames'))).toBe('充电站')
    expect(String(store.get('navigation.waypoints'))).toBe('104.10,30.61')
  })

  it('导航中改路线偏好（躲避拥堵）就地重规划，不用重设目的地', async () => {
    nav()
    const r = await mk().invoke('navigation.modifyRoute', { preference: 'avoidCongestion' })
    expect(r.status).toBe('ok')
    expect(store.get('navigation.destination')).toBe('春熙路')
  })

  it('没在导航时拒——没有路可改', async () => {
    const r = await mk().invoke('navigation.modifyRoute', { addWaypoint: 'x' })
    expect(r.status).toBe('rejected')
    expect(String(r.message)).toContain('导航')
  })

  it('删一个不存在的途经点如实说，不假装删了', async () => {
    nav()
    const r = await mk().invoke('navigation.modifyRoute', { removeWaypoint: '不存在' })
    expect(r.status).toBe('rejected')
    expect(String(r.message)).toContain('不存在')
  })
})

/**
 * 全链路：modifyRoute 改完信号，导航卡的 data 要跟着长出途经点
 * （2026-08-25 实拍：改路成功、话术都对，桌面地图卡上却没有途经点）。
 */
describe('modifyRoute → 导航卡数据跟上', () => {
  it('卡 data.via 出现途经点名、waypoints 坐标进活地图参数', async () => {
    const { createDesk } = await import('../../src/cards/desk')
    const { createOrchestrator } = await import('../../src/cards/orchestrator')
    const { CARD_RULES, DATA_BUILDERS } = await import('../../src/config/cardRules')
    const amap = {
      geocode: async (addr: string) => ({ location: '104.10,30.70', formattedAddress: addr }),
      placeSearch: async (q: string) => [{ id: 'p1', name: q, location: '104.08,30.66', address: 'x' }],
      placeDetail: async () => ({ name: '黄山风景区', location: '118.17,30.13' }),
      driving: async (_o: string, _d: string, opts: any) => ({
        distance: 8200, duration: 23 * 60, steps: [{ instruction: '直行' }],
        polyline: '1,1;2,2' + (opts?.waypoints?.length ? ';3,3' : ''),
      }),
      staticMapUrl: () => 'http://x/map.png',
    }
    const desk = createDesk()
    createOrchestrator({ store, desk, rules: CARD_RULES, builders: DATA_BUILDERS,
      deps: { store, amap } as any }).start()
    const reg2 = createRegistry(store, TOOLS, Date.now, { amap, desk } as any)
    store.set('vehicle.location', '104.06,30.54')
    ok(await reg2.invoke('navigation.setDestination', { poiId: 'B01' }))
    const before = desk.layout().cards.find(c => c.key === 'nav')!
    expect((before.data as any).via ?? []).toHaveLength(0)

    ok(await reg2.invoke('navigation.modifyRoute', { addWaypoint: '合肥' }))
    const after = desk.layout().cards.find(c => c.key === 'nav')!
    expect((after.data as any).via, '途经点名要进卡').toContain('合肥')
    expect(String((after.data as any).waypoints), '坐标要进活地图参数').toContain('104.08,30.66')
  })
})

function ok(r: any) { if (r.status !== 'ok') throw new Error('调用失败: ' + JSON.stringify(r).slice(0, 200)); return r }
