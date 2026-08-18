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
