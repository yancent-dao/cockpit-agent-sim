import { describe, it, expect } from 'vitest'
import { createAmapClient, AmapError, thinPolyline, type Fetcher } from '../../src/integrations/amap'

/** 假 fetch：按 URL 里的路径返回预设的高德响应，不打真实网络 */
function fakeFetcher(routes: Record<string, any>): Fetcher {
  return async (url: string) => {
    const path = new URL(url).pathname
    const body = routes[path]
    if (!body) throw new Error(`没有为 ${path} 配置假响应`)
    return { ok: true, json: async () => body }
  }
}

const client = (routes: Record<string, any>) => createAmapClient(fakeFetcher(routes), { webKey: 'test-key' })

describe('placeSearch —— 关键字搜索 POI', () => {
  it('解析出名称/地址/坐标', async () => {
    const c = client({
      '/v5/place/text': {
        status: '1', info: 'OK', count: '1',
        pois: [{ id: 'B0FFG', name: '天安门广场', address: '东城区东长安街', location: '116.397,39.909' }],
      },
    })
    const pois = await c.placeSearch('天安门')
    expect(pois).toEqual([{ id: 'B0FFG', name: '天安门广场', address: '东城区东长安街', location: '116.397,39.909', distance: undefined }])
  })

  it('高德返回失败状态时抛 AmapError，不假装成功', async () => {
    const c = client({ '/v5/place/text': { status: '0', info: 'INVALID_USER_KEY', infocode: '10001' } })
    await expect(c.placeSearch('xx')).rejects.toThrow(AmapError)
  })
})

describe('placeDetail —— 按 id 查详情', () => {
  it('找到时返回单个 POI', async () => {
    const c = client({ '/v5/place/detail': { status: '1', pois: [{ id: 'B1', name: '故宫', address: '景山前街4号', location: '116.397,39.918' }] } })
    expect(await c.placeDetail('B1')).toEqual({ id: 'B1', name: '故宫', address: '景山前街4号', location: '116.397,39.918', distance: undefined })
  })

  it('查无此 id 返回 null 而不是抛错', async () => {
    const c = client({ '/v5/place/detail': { status: '1', pois: [] } })
    expect(await c.placeDetail('nope')).toBeNull()
  })
})

describe('geocode —— 地址转坐标', () => {
  it('解析出坐标与规整地址', async () => {
    const c = client({ '/v3/geocode/geo': { status: '1', geocodes: [{ location: '116.481,39.990', formatted_address: '北京市朝阳区望京' }] } })
    expect(await c.geocode('望京')).toEqual({ location: '116.481,39.990', formattedAddress: '北京市朝阳区望京' })
  })

  it('顺带解析出 adcode，供天气查询用', async () => {
    const c = client({ '/v3/geocode/geo': { status: '1', geocodes: [{ location: '116.4,39.9', formatted_address: '北京市', adcode: '110000' }] } })
    expect((await c.geocode('北京'))?.adcode).toBe('110000')
  })
})

describe('driving —— 驾车路径规划', () => {
  it('解析距离/耗时/收费/分段指示', async () => {
    const c = client({
      '/v5/direction/driving': {
        status: '1', route: {
          paths: [{
            distance: '12000',
            cost: { duration: '1500', tolls: '5' },
            steps: [
              { instruction: '沿望京街行驶500米', step_distance: '500', polyline: '116.4,39.9;116.41,39.91' },
              { instruction: '右转进入阜通东大街', step_distance: '11500', polyline: '116.41,39.91;116.5,39.99' },
            ],
          }],
        },
      },
    })
    const r = await c.driving('116.4,39.9', '116.5,39.99')
    expect(r.distance).toBe(12000)
    expect(r.duration).toBe(1500)
    expect(r.tolls).toBe(5)
    expect(r.steps).toHaveLength(2)
    expect(r.steps[0].instruction).toContain('望京街')
    expect(r.polyline).toContain('116.4,39.9')
  })

  it('规划不出路线时抛 AmapError', async () => {
    const c = client({ '/v5/direction/driving': { status: '1', route: { paths: [] } } })
    await expect(c.driving('a', 'b')).rejects.toThrow(AmapError)
  })

  it('解析收费里程、限行、红绿灯数——市场车机都会告诉你这些', async () => {
    const c = client({
      '/v5/direction/driving': {
        status: '1',
        route: { paths: [{
          distance: '12000', restriction: '1', traffic_lights: '8',
          cost: { duration: '1500', tolls: '15', toll_distance: '8000' },
          steps: [{ instruction: '直行', step_distance: '12000' }],
        }] },
      },
    })
    const r = await c.driving('a', 'b')
    expect(r.tolls).toBe(15)
    expect(r.tollDistance).toBe(8)   // 米→公里
    expect(r.restricted).toBe(true)  // 有限行
    expect(r.trafficLights).toBe(8)
  })

  it('途经点按顺序拼进请求（最多 16 个，市场车机的核心能力）', async () => {
    let seen = ''
    const c = createAmapClient((async (url: string) => {
      seen = url
      return { ok: true, json: async () => ({ status: '1', route: { paths: [{ distance: '1', steps: [] }] } }) }
    }) as Fetcher, { webKey: 'k' })
    await c.driving('1,1', '3,3', { waypoints: ['2,2', '2.5,2.5'] })
    expect(decodeURIComponent(seen)).toContain('waypoints=2,2;2.5,2.5')
  })

  it('车牌与车型传给高德——限行规避与电车/油车差异靠它', async () => {
    let seen = ''
    const c = createAmapClient((async (url: string) => {
      seen = url
      return { ok: true, json: async () => ({ status: '1', route: { paths: [{ distance: '1', steps: [] }] } }) }
    }) as Fetcher, { webKey: 'k' })
    await c.driving('1,1', '2,2', { plate: '川A12345', carType: 'ev' })
    const url = decodeURIComponent(seen)
    expect(url).toContain('plate=川A12345')
    expect(url).toContain('cartype=1') // 1 = 纯电动
  })

  it('返回多条备选路线供对比', async () => {
    const c = client({
      '/v5/direction/driving': {
        status: '1',
        route: { paths: [
          { distance: '12000', cost: { duration: '1500', tolls: '15' }, steps: [] },
          { distance: '15000', cost: { duration: '1800', tolls: '0' }, steps: [] },
        ] },
      },
    })
    const rs = await c.drivingRoutes('a', 'b')
    expect(rs).toHaveLength(2)
    expect(rs[1].tolls).toBe(0)
  })
})

describe('districts —— 行政区域查询', () => {
  it('列出一个城市下辖的区县，带 adcode 与中心坐标', async () => {
    const c = client({
      '/v3/config/district': { status: '1', districts: [{
        name: '成都市', adcode: '510100', level: 'city', center: '104.06,30.65',
        districts: [
          { name: '双流区', adcode: '510116', level: 'district', center: '103.92,30.57' },
          { name: '都江堰市', adcode: '510181', level: 'district', center: '103.62,30.99' },
        ],
      }] },
    })
    const ds = await c.districts('成都')
    expect(ds).toEqual([
      { name: '双流区', adcode: '510116', center: '103.92,30.57' },
      { name: '都江堰市', adcode: '510181', center: '103.62,30.99' },
    ])
  })

  it('直辖市要穿透中间层——北京是 province 级，区县在"北京城区"下面一层', async () => {
    const c = client({
      '/v3/config/district': { status: '1', districts: [{
        name: '北京市', adcode: '110000', level: 'province', center: '116.4,39.9',
        districts: [{
          name: '北京城区', adcode: '110100', level: 'city', center: '116.4,39.9',
          districts: [
            { name: '密云区', adcode: '110118', level: 'district', center: '116.84,40.37' },
            { name: '怀柔区', adcode: '110116', level: 'district', center: '116.63,40.32' },
          ],
        }],
      }] },
    })
    const ds = await c.districts('北京')
    expect(ds.map(d => d.name)).toEqual(['密云区', '怀柔区'])
  })

  it('只收区县级，不把街道混进来', async () => {
    const c = client({
      '/v3/config/district': { status: '1', districts: [{
        name: '成都市', level: 'city',
        districts: [
          { name: '双流区', adcode: '510116', level: 'district', center: '103.92,30.57',
            districts: [{ name: '东升街道', adcode: '510116', level: 'street', center: '103.92,30.57' }] },
        ],
      }] },
    })
    expect((await c.districts('成都')).map(d => d.name)).toEqual(['双流区'])
  })

  it('查不到就给空数组，不炸', async () => {
    const c = client({ '/v3/config/district': { status: '1', districts: [] } })
    expect(await c.districts('火星')).toEqual([])
  })
})

describe('多出行方式：步行 / 骑行 / 公交', () => {
  it('步行路线走 walking 接口', async () => {
    const c = client({ '/v5/direction/walking': { status: '1', route: { paths: [{ distance: '800', cost: { duration: '600' }, steps: [{ instruction: '直行', step_distance: '800' }] }] } } })
    const r = await c.routeBy('walking', '1,1', '2,2')
    expect(r.distance).toBe(800)
    expect(r.duration).toBe(600)
  })

  it('骑行路线走 bicycling 接口', async () => {
    const c = client({ '/v5/direction/bicycling': { status: '1', route: { paths: [{ distance: '3000', cost: { duration: '900' }, steps: [] }] } } })
    expect((await c.routeBy('bicycling', '1,1', '2,2')).distance).toBe(3000)
  })

  it('公交路线走 transit/integrated，需要城市参数', async () => {
    const c = client({ '/v5/direction/transit/integrated': { status: '1', route: { transits: [{ distance: '12000', cost: { duration: '2400', transit_fee: '4' }, segments: [] }] } } })
    const r = await c.transitRoute('1,1', '2,2', '成都')
    expect(r.distance).toBe(12000)
    expect(r.fee).toBe(4)
  })
})

describe('weatherNow / weatherForecast', () => {
  it('实况天气解析', async () => {
    const c = client({
      '/v3/weather/weatherInfo': {
        status: '1', lives: [{ city: '北京市', weather: '晴', temperature: '25', winddirection: '北', windpower: '3', humidity: '40', reporttime: '2026-08-10 12:00:00' }],
      },
    })
    const w = await c.weatherNow('110000')
    expect(w).toEqual({ city: '北京市', weather: '晴', temperature: 25, wind: '北风 3级', humidity: 40, reportTime: '2026-08-10 12:00:00' })
  })

  it('预报天气解析成数组', async () => {
    const c = client({
      '/v3/weather/weatherInfo': {
        status: '1', forecasts: [{ casts: [{ date: '2026-08-11', dayweather: '多云', nightweather: '晴', daytemp: '30', nighttemp: '20' }] }],
      },
    })
    const casts = await c.weatherForecast('110000')
    expect(casts).toEqual([{ date: '2026-08-11', dayWeather: '多云', nightWeather: '晴', dayTemp: 30, nightTemp: 20 }])
  })
})

describe('trafficAround —— 交通态势', () => {
  it('状态码翻译成可读枚举', async () => {
    const c = client({ '/v3/traffic/status/circle': { status: '1', trafficinfo: { status: '3', expedite: '10', congested: '20', blocked: '70' } } })
    expect(await c.trafficAround('116.4,39.9')).toEqual({ status: 'congested', expedite: 10, congested: 20, blocked: 70 })
  })
})

describe('busSearch —— 公交路线关键字查询', () => {
  it('解析线路名称与首末站', async () => {
    const c = client({
      '/v3/bus/linename': { status: '1', buslines: [{ id: 'L1', type: '地铁线路', name: '10号线', start_stop: '角门西', end_stop: '首都机场' }] },
    })
    expect(await c.busSearch('10号线', '北京')).toEqual([{ id: 'L1', type: '地铁线路', name: '10号线', startStop: '角门西', endStop: '首都机场' }])
  })
})

describe('coordConvert —— 坐标转换', () => {
  it('解析转换后坐标（分号分隔多个）', async () => {
    const c = client({ '/v3/assistant/coordinate/convert': { status: '1', locations: '116.4,39.9;116.5,40.0' } })
    expect(await c.coordConvert(['116.399,39.899', '116.499,39.999'])).toEqual(['116.4,39.9', '116.5,40.0'])
  })
})

describe('staticMapUrl —— 纯拼接，不发请求', () => {
  it('生成包含 key/location/zoom 的图片 URL', () => {
    const c = client({})
    const url = c.staticMapUrl({ location: '116.4,39.9', zoom: 12 })
    expect(url).toContain('key=test-key')
    expect(url).toContain('location=116.4%2C39.9')
    expect(url).toContain('zoom=12')
  })

  it('传 path 时画出路线折线（导航卡的"算路"就靠它）', () => {
    const c = client({})
    const url = c.staticMapUrl({ path: '116.4,39.9;116.5,40.0' })
    expect(decodeURIComponent(url)).toContain('paths=')
    expect(decodeURIComponent(url)).toContain('116.4,39.9;116.5,40.0')
  })

  it('有覆盖物时不写死 location/zoom，交给高德自动算视野——起终点才不会被裁出画面', () => {
    const c = client({})
    const url = c.staticMapUrl({ path: '116.4,39.9;116.5,40.0', markers: 'mid,,A:116.4,39.9' })
    expect(url).not.toContain('zoom=')
    expect(url).not.toContain('location=')
  })

  it('没有覆盖物时必须给 location/zoom，否则高德不认', () => {
    const c = client({})
    const url = c.staticMapUrl({ location: '116.4,39.9' })
    expect(url).toContain('zoom=')
  })
})

describe('QPS 限流 —— Agent 并行调用是我们鼓励的，得让适配层扛住', () => {
  it('撞上 QPS 上限会自动退避重试，最终成功', async () => {
    let calls = 0
    const c = createAmapClient((async () => {
      calls++
      // 前两次返回高德的 QPS 超限错误，第三次成功
      const body = calls <= 2
        ? { status: '0', info: 'CUQPS_HAS_EXCEEDED_THE_LIMIT', infocode: '10021' }
        : { status: '1', lives: [{ city: '成都市', weather: '晴', temperature: '25', winddirection: '北', windpower: '3', humidity: '40', reporttime: 't' }] }
      return { ok: true, json: async () => body }
    }) as Fetcher, { webKey: 'k', retryDelayMs: 1 })
    const w = await c.weatherNow('510100')
    expect(w.weather).toBe('晴')
    expect(calls).toBe(3)
  })

  it('一直超限则如实报错，不无限重试', async () => {
    let calls = 0
    const c = createAmapClient((async () => {
      calls++
      return { ok: true, json: async () => ({ status: '0', info: 'CUQPS_HAS_EXCEEDED_THE_LIMIT', infocode: '10021' }) }
    }) as Fetcher, { webKey: 'k', retryDelayMs: 1 })
    await expect(c.weatherNow('510100')).rejects.toThrow(AmapError)
    expect(calls).toBeLessThanOrEqual(5) // 有上限
  })

  it('非限流类错误立即返回，不做无谓重试', async () => {
    let calls = 0
    const c = createAmapClient((async () => {
      calls++
      return { ok: true, json: async () => ({ status: '0', info: 'INVALID_USER_KEY', infocode: '10001' }) }
    }) as Fetcher, { webKey: 'k', retryDelayMs: 1 })
    await expect(c.weatherNow('510100')).rejects.toThrow(AmapError)
    expect(calls).toBe(1)
  })
})

describe('thinPolyline —— 路线点抽稀', () => {
  it('点数少时原样返回', () => {
    expect(thinPolyline('1,1;2,2;3,3', 10)).toBe('1,1;2,2;3,3')
  })

  it('点数超限时均匀抽稀，且必定保留首尾——URL 有长度上限，但路线不能断头', () => {
    const pts = Array.from({ length: 100 }, (_, i) => `${i},${i}`).join(';')
    const out = thinPolyline(pts, 10).split(';')
    expect(out.length).toBeLessThanOrEqual(10)
    expect(out[0]).toBe('0,0')
    expect(out.at(-1)).toBe('99,99')
  })

  it('空串不炸', () => {
    expect(thinPolyline('', 10)).toBe('')
  })
})
