import { describe, it, expect, beforeEach } from 'vitest'
import { createStore } from '../../src/core/store'
import { createRegistry } from '../../src/tools/registry'
import { createDesk } from '../../src/cards/desk'
import { SIGNALS } from '../../src/config/signals'
import { CONSTRAINTS } from '../../src/config/constraints'
import { TOOLS } from '../../src/config/tools'

/**
 * 天气的地名解析（2026-08-18 实拍：设置成都，天气卡标题「杭州市滨江区LOCATION天气」）。
 * 三个坑一起堵：
 * ① 模型把"当前位置"的引用退化成字面量（"LOCATION"/"vehicle.location"）当参数传——
 *    高德对垃圾词按请求 IP 城市兜底猜（实测命中代理节点所在的杭州滨江），
 *    响应完全"合法"（level=兴趣点）根本拦不住。在 handler 收这个退化，
 *    判据只看数据形状（值恰为参数引用字面量），同 {item} 展平先例。
 * ② geocode 不带 city 是全国匹配：实测「春熙路」命中云南昭通鲁甸县——
 *    「成都用户搜临平命中杭州」的同款病。但 city 是硬偏置（实测「北京」+city成都
 *    命中"彭州市北京村"），无脑加会毁掉查外地。判据用协议的 level 字段：
 *    全国查回来是粗粒度（国家/省/市/区县）直接用；细粒度（道路/兴趣点…）
 *    说明是本地小地名，带当前城市重查一次。
 */

const CHENGDU = '104.065861,30.657401'

let store: ReturnType<typeof createStore>
let desk: ReturnType<typeof createDesk>
let geocodeCalls: Array<{ address: string; city?: string }>
let areaOfCalls: string[]

beforeEach(() => {
  store = createStore(SIGNALS, CONSTRAINTS)
  store.setDirect('vehicle.location', CHENGDU)
  desk = createDesk()
  geocodeCalls = []
  areaOfCalls = []
})

const fakeAmap = {
  geocode: async (address: string, city?: string) => {
    geocodeCalls.push({ address, city })
    if (address === '春熙路' && !city)
      return { location: '103.55,27.19', adcode: '530621', formattedAddress: '云南省昭通市鲁甸县春熙路', level: '道路' }
    if (address === '春熙路' && city)
      return { location: '104.08,30.66', adcode: '510104', formattedAddress: '四川省成都市锦江区春熙路', level: '道路' }
    if (address === '北京')
      return { location: '116.40,39.90', adcode: '110000', formattedAddress: '北京市', level: '市' }
    return null
  },
  cityOf: async () => '成都市',
  areaOf: async (loc: string) => { areaOfCalls.push(loc); return { adcode: '510100', name: '成都市' } },
  weatherNow: async () => ({ weather: '晴', temperature: 30 }),
  weatherForecast: async () => [],
}

const mk = () => createRegistry(store, TOOLS, Date.now, { desk, amap: fakeAmap } as any)

describe('地名解析两段式（level 判据）', () => {
  it('本地小地名：全国命中细粒度 → 带当前城市重查，天气落在成都不落昭通', async () => {
    const r = await mk().invoke('weather.query', { location: '春熙路' })
    expect(r.status).toBe('ok')
    expect((r.data as any).city).toContain('成都')
    expect((r.data as any).city).not.toContain('鲁甸')
    expect(geocodeCalls).toHaveLength(2)
    expect(geocodeCalls[1].city).toBe('成都市')
  })

  it('城市级地名：全国命中粗粒度直接用，不重查——查外地天气不受偏置影响', async () => {
    const r = await mk().invoke('weather.query', { location: '北京' })
    expect(r.status).toBe('ok')
    expect((r.data as any).city).toContain('北京')
    expect(geocodeCalls).toHaveLength(1)
  })
})

describe('当前位置引用的字面量退化', () => {
  for (const junk of ['LOCATION', 'vehicle.location', '当前位置']) {
    it(`「${junk}」→ 直接用 vehicle.location 的坐标，不进 geocode`, async () => {
      const r = await mk().invoke('weather.query', { location: junk })
      expect(r.status).toBe('ok')
      expect((r.data as any).city).toContain('成都')
      expect(geocodeCalls).toHaveLength(0)
      expect(areaOfCalls[0]).toBe(CHENGDU)
    })
  }

  it('真实地名不受退化收口误伤', async () => {
    const r = await mk().invoke('weather.query', { location: '北京' })
    expect(r.status).toBe('ok')
    expect(geocodeCalls.length).toBeGreaterThan(0)
  })
})

/**
 * 导航中换目的地要说出来（2026-08-19 实拍：用户说"途径一个饺子店"，
 * 模型点选后调了裸 setDestination(poiId=饺子馆)——春熙路的导航被静默
 * 覆盖，模型自己都不知道，话术还说"导航还在跑春熙路"。
 * 覆盖是合法操作（用户真想换目的地），但**这个状态事实必须进返回**，
 * 模型看到才可能自纠为 waypoints——同"卡上已是全量"先例。
 */
describe('导航中换目的地：返回里带状态事实', () => {
  const navAmap = {
    ...fakeAmap,
    geocode: async (address: string) =>
      ({ location: '104.06,30.65', formattedAddress: address, adcode: '510104', level: '兴趣点' }),
    driving: async () => ({ duration: 600, distance: 2300, steps: [], polyline: '', tolls: 0 }),
    staticMapUrl: () => 'https://map/x.png',
  }
  const mkNav = () => createRegistry(store, TOOLS, Date.now, { desk, amap: navAmap } as any)

  it('无 waypoints 覆盖进行中的导航 → message 提醒"换掉了原目的地，顺路该用 waypoints"', async () => {
    store.setDirect('navigation.active', true)
    store.setDirect('navigation.destination', '春熙路')
    const r = await mkNav().invoke('navigation.setDestination', { address: '牛牛家饺子馆' })
    expect(r.status).toBe('ok')
    expect(String(r.message)).toContain('春熙路')
    expect(String(r.message)).toMatch(/换|覆盖/)
    expect(String(r.message)).toContain('waypoints')
  })

  it('带 waypoints 或首次设目的地：不打扰', async () => {
    const r = await mkNav().invoke('navigation.setDestination', { address: '牛牛家饺子馆' })
    expect(r.status).toBe('ok')
    expect(String(r.message ?? '')).not.toContain('waypoints')
  })
})
