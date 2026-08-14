/**
 * 高德地图适配层 —— 把高德的原始 REST 响应翻译成我们自己的 Tool 契约。
 * Tool 定义（tools.ts）和 Agent 侧只认这个文件导出的形状，不直接碰高德字段名；
 * 以后高德字段变了、或者要换供应商，只改这一个文件。
 *
 * fetch 作为依赖注入，方便测试用假 fetch，不打真实网络。
 */

const BASE = 'https://restapi.amap.com'

export class AmapError extends Error {
  constructor(message: string, public code?: string) {
    super(message)
  }
}

export interface AmapKeys {
  /** Web 服务 Key，本文件里所有 REST 调用都用它 */
  webKey: string
  /** 限流退避的基准间隔，测试里调小以免拖慢 */
  retryDelayMs?: number
}

export interface AmapPoi {
  id: string
  name: string
  address: string
  /** "经度,纬度" */
  location: string
  /** 米，仅周边搜索/输入提示有意义时才有值 */
  distance?: number
}

export interface AmapRouteStep {
  instruction: string
  distance: number
}

export interface AmapRoute {
  distance: number
  duration?: number
  /** 过路费（元） */
  tolls?: number
  /** 收费路段里程（公里） */
  tollDistance?: number
  /** 本路线是否撞限行（传了 plate 才有意义） */
  restricted?: boolean
  /** 红绿灯个数 */
  trafficLights?: number
  polyline?: string
  steps: AmapRouteStep[]
}

/** 车型 → 高德 cartype。影响限行判定与推荐（电车推充电站、油车推加油站） */
export type CarType = 'fuel' | 'ev' | 'phev'
const CAR_TYPE: Record<CarType, number> = { fuel: 0, ev: 1, phev: 2 }

export interface DrivingOpts {
  preference?: string
  /** 途经点，按顺序，最多 16 个 */
  waypoints?: string[]
  /** 车牌，用于限行规避 */
  plate?: string
  carType?: CarType
}

export interface AmapWeatherNow {
  city: string
  weather: string
  temperature: number
  wind: string
  humidity: number
  reportTime: string
}

export interface AmapWeatherCast {
  date: string
  dayWeather: string
  nightWeather: string
  dayTemp: number
  nightTemp: number
}

export interface AmapTraffic {
  status: 'unknown' | 'clear' | 'slow' | 'congested'
  expedite: number
  congested: number
  blocked: number
}

export interface AmapDistrict {
  name: string
  adcode: string
  /** "经度,纬度" */
  center: string
}

export interface AmapBusLine {
  id: string
  type: string
  name: string
  startStop: string
  endStop: string
}

/** 驾车路线偏好 → 高德 strategy 数值，只收录官方文档确认过的，不瞎猜 */
const STRATEGY: Record<string, number> = {
  default: 32,          // 高德推荐（同 APP 默认）
  fastest: 38,          // 速度最快
  avoidHighway: 35,     // 不走高速
  avoidCongestion: 33,  // 躲避拥堵
  avoidToll: 36,        // 少收费
}

const TRAFFIC_STATUS = ['unknown', 'clear', 'slow', 'congested'] as const

/** init 是可选的：高德用不上，Pexels 要靠它传 Authorization 头 */
/**
 * 所有协议客户端共用的取数契约。窄到只剩 `ok` 和 `json()` 是刻意的 ——
 * 测试传一个十行的假实现就够，不用 mock 整个 `fetch`。
 *
 * 2026-08-14 放宽了 init：图像 API 是 POST + JSON body（`orimage.ts`）。
 * 这几个字段都是 `fetch` 本来就有的，浏览器那边传的就是 `fetch` 本身。
 */
export type Fetcher = (url: string, init?: {
  method?: string
  headers?: Record<string, string>
  body?: string
}) => Promise<{ ok: boolean; json: () => Promise<any> }>

/**
 * 路线点抽稀。一条几十公里的路线有几百个坐标点，全塞进 URL 会超长被高德拒绝；
 * 均匀取样即可，首尾必须保留——否则路线画出来会断头断尾。
 */
export function thinPolyline(polyline: string, max = 80): string {
  const pts = polyline.split(';').filter(Boolean)
  if (pts.length <= max) return pts.join(';')
  const step = (pts.length - 1) / (max - 1)
  const out: string[] = []
  for (let i = 0; i < max - 1; i++) out.push(pts[Math.round(i * step)])
  out.push(pts[pts.length - 1])
  return out.join(';')
}

/** 高德的限流类错误码/信息——遇到这些重试有意义，其它错误重试只是浪费 */
const isRateLimited = (json: any) =>
  /CUQPS|QPS|TOO_FREQUENT|DAILY_QUERY_OVER_LIMIT/i.test(String(json?.info ?? '')) ||
  ['10021', '10014', '10019', '10020'].includes(String(json?.infocode ?? ''))

const sleep = (ms: number) => new Promise(r => setTimeout(r, ms))

export function createAmapClient(fetcher: Fetcher, keys: AmapKeys) {
  const baseDelay = keys.retryDelayMs ?? 350
  const MAX_ATTEMPTS = 4

  /**
   * 所有请求的统一入口。
   * 我们鼓励 Agent 并行调用（"一次意图要多个工具就一起调"），但高德个人 Key 的 QPS 很低，
   * 六个天气查询齐发必然撞限流。让适配层退避重试扛住，而不是反过来要求 Agent 少调。
   */
  async function get(path: string, params: Record<string, string | number | boolean | undefined>) {
    const qs = new URLSearchParams({ key: keys.webKey })
    for (const [k, v] of Object.entries(params)) if (v !== undefined) qs.set(k, String(v))
    const url = `${BASE}${path}?${qs.toString()}`

    for (let attempt = 1; ; attempt++) {
      const res = await fetcher(url)
      if (!res.ok) throw new AmapError(`高德服务网络异常 ${JSON.stringify(res)}`, 'NETWORK_ERROR')
      const json = await res.json()
      if (json.status === '1') return json
      if (isRateLimited(json) && attempt < MAX_ATTEMPTS) {
        await sleep(baseDelay * attempt) // 线性退避：并发越挤，错开得越远
        continue
      }
      throw new AmapError(json.info ?? '高德服务返回失败', json.infocode)
    }
  }

  const toPoi = (p: any): AmapPoi => ({
    id: p.id, name: p.name, address: p.address ?? p.district ?? '',
    location: p.location, distance: p.distance !== undefined ? Number(p.distance) : undefined,
  })

  return {
    /** 关键字搜索 POI（v5/place/text） */
    async placeSearch(keywords: string, region?: string): Promise<AmapPoi[]> {
      const json = await get('/v5/place/text', { keywords, region, page_size: 10 })
      return (json.pois ?? []).map(toPoi)
    },

    /** 周边搜索（v5/place/around）—— 沿途找充电站/加油站/服务区都靠它 */
    async placeAround(center: string, keywords: string, radius?: number): Promise<AmapPoi[]> {
      radius ??= 5000
      const json = await get('/v5/place/around', { location: center, keywords, radius, sortrule: 'distance', page_size: 10 })
      return (json.pois ?? []).map(toPoi)
    },

    /** 按 id 查单个 POI 详情（v5/place/detail）—— 用于 setDestination 传 poiId 时回查坐标 */
    async placeDetail(id: string): Promise<AmapPoi | null> {
      const json = await get('/v5/place/detail', { id })
      const p = (json.pois ?? [])[0]
      return p ? toPoi(p) : null
    },

    /** 地理编码：地址 → 坐标（v3/geocode/geo）—— 用于 setDestination 传 address、weather.query 转 adcode */
    async geocode(address: string, city?: string): Promise<{ location: string; formattedAddress: string; adcode?: string } | null> {
      const json = await get('/v3/geocode/geo', { address, city })
      const g = (json.geocodes ?? [])[0]
      return g ? { location: g.location, formattedAddress: g.formatted_address, adcode: g.adcode } : null
    },

    /** 驾车路径规划 2.0（v5/direction/driving） */
    /** 单条最优路线 */
    async driving(origin: string, destination: string, opts: DrivingOpts = {}): Promise<AmapRoute> {
      const rs = await this.drivingRoutes(origin, destination, opts)
      if (!rs.length) throw new AmapError('规划不出路线', 'NO_ROUTE')
      return rs[0]
    },

    /** 全部备选路线——供"快一点还是省一点"这类方案对比 */
    async drivingRoutes(origin: string, destination: string, opts: DrivingOpts = {}): Promise<AmapRoute[]> {
      const json = await get('/v5/direction/driving', {
        origin, destination,
        waypoints: opts.waypoints?.length ? opts.waypoints.join(';') : undefined,
        plate: opts.plate,
        cartype: opts.carType ? CAR_TYPE[opts.carType] : undefined,
        strategy: STRATEGY[opts.preference ?? 'default'] ?? STRATEGY.default,
        show_fields: 'cost,polyline,tmcs',
      })
      const paths = json.route?.paths ?? []
      if (!paths.length) throw new AmapError('规划不出路线', 'NO_ROUTE')
      const num = (v: unknown) => (v !== undefined && v !== null && v !== '' ? Number(v) : undefined)
      return paths.map((path: any) => ({
        distance: Number(path.distance),
        duration: num(path.cost?.duration),
        tolls: num(path.cost?.tolls),
        tollDistance: path.cost?.toll_distance !== undefined
          ? Math.round(Number(path.cost.toll_distance) / 100) / 10 : undefined,
        restricted: path.restriction !== undefined ? path.restriction === '1' : undefined,
        trafficLights: num(path.traffic_lights),
        polyline: path.steps?.map((s: any) => s.polyline).filter(Boolean).join(';'),
        steps: (path.steps ?? []).map((s: any) => ({
          instruction: s.instruction, distance: Number(s.step_distance ?? s.distance ?? 0),
        })),
      }))
    },

    /** 逆地理编码（v3/geocode/regeo）：坐标 → 所在城市，用户说"附近"时不用他报地名 */
    async cityOf(location: string): Promise<string | null> {
      const json = await get('/v3/geocode/regeo', { location })
      const c = json.regeocode?.addressComponent
      const city = c?.city || c?.province
      return typeof city === 'string' && city ? city : null
    },

    /** 坐标 → 天气用的 adcode + 可读地名。查"我这儿的天气"要用这个而不是 geocode */
    async areaOf(location: string): Promise<{ adcode: string; name: string } | null> {
      const json = await get('/v3/geocode/regeo', { location })
      const c = json.regeocode?.addressComponent
      if (!c?.adcode) return null
      const name = [c.province, c.city, c.district].filter(Boolean)
        .filter((v: any, i: number, a: any[]) => a.indexOf(v) === i).join('')
      return { adcode: String(c.adcode), name: name || String(c.city ?? c.province ?? '') }
    },

    /**
     * 行政区域查询（v3/config/district）—— 列出某地下辖的区县。
     * "附近哪个县在下雨"这类需求，第一步就是先知道附近有哪些县。
     */
    async districts(keywords: string): Promise<AmapDistrict[]> {
      // subdistrict=2：直辖市是 province 级（北京 → "北京城区" → 密云区），
      // 只取一级会卡在中间层什么区县都拿不到。普通地级市取两级也无妨，多出来的街道会被过滤掉。
      const json = await get('/v3/config/district', { keywords, subdistrict: 2, extensions: 'base' })
      const out: AmapDistrict[] = []
      const walk = (nodes: any[]) => {
        for (const d of nodes ?? []) {
          if (d.level === 'district') out.push({ name: d.name, adcode: d.adcode, center: d.center })
          else walk(d.districts) // province / city 这类中间层继续往下找
        }
      }
      walk(json.districts?.[0]?.districts)
      return out
    },

    /** 步行 / 骑行 / 电动车路线——"最后一公里"与短途场景 */
    async routeBy(mode: 'walking' | 'bicycling' | 'electrobike', origin: string, destination: string): Promise<AmapRoute> {
      const json = await get(`/v5/direction/${mode}`, { origin, destination, show_fields: 'cost,polyline' })
      const path = json.route?.paths?.[0]
      if (!path) throw new AmapError('规划不出路线', 'NO_ROUTE')
      return {
        distance: Number(path.distance),
        duration: path.cost?.duration !== undefined ? Number(path.cost.duration) : undefined,
        polyline: path.steps?.map((s: any) => s.polyline).filter(Boolean).join(';'),
        steps: (path.steps ?? []).map((s: any) => ({
          instruction: s.instruction, distance: Number(s.step_distance ?? s.distance ?? 0),
        })),
      }
    },

    /** 公交路线（v5/direction/transit/integrated）—— 返回结构与驾车不同，单独一个方法 */
    async transitRoute(origin: string, destination: string, city: string): Promise<AmapRoute & { fee?: number }> {
      const json = await get('/v5/direction/transit/integrated', { origin, destination, city1: city, city2: city, show_fields: 'cost' })
      const t = json.route?.transits?.[0]
      if (!t) throw new AmapError('规划不出公交路线', 'NO_ROUTE')
      return {
        distance: Number(t.distance),
        duration: t.cost?.duration !== undefined ? Number(t.cost.duration) : undefined,
        fee: t.cost?.transit_fee !== undefined ? Number(t.cost.transit_fee) : undefined,
        steps: (t.segments ?? []).map((s: any) => ({
          instruction: s.bus?.buslines?.[0]?.name ?? s.walking?.origin ?? '换乘',
          distance: Number(s.bus?.buslines?.[0]?.distance ?? s.walking?.distance ?? 0),
        })),
      }
    },

    /** 天气实况（v3/weather/weatherInfo，extensions=base） */
    async weatherNow(cityAdcode: string): Promise<AmapWeatherNow> {
      const json = await get('/v3/weather/weatherInfo', { city: cityAdcode, extensions: 'base' })
      const l = json.lives?.[0]
      if (!l) throw new AmapError('查不到这个城市的天气', 'NO_DATA')
      return {
        city: l.city, weather: l.weather, temperature: Number(l.temperature),
        wind: `${l.winddirection}风 ${l.windpower}级`, humidity: Number(l.humidity), reportTime: l.reporttime,
      }
    },

    /** 天气预报（v3/weather/weatherInfo，extensions=all） */
    async weatherForecast(cityAdcode: string): Promise<AmapWeatherCast[]> {
      const json = await get('/v3/weather/weatherInfo', { city: cityAdcode, extensions: 'all' })
      const casts = json.forecasts?.[0]?.casts ?? []
      return casts.map((c: any) => ({
        date: c.date, dayWeather: c.dayweather, nightWeather: c.nightweather,
        dayTemp: Number(c.daytemp), nightTemp: Number(c.nighttemp),
      }))
    },

    /** 圆形区域交通态势（v3/traffic/status/circle） */
    async trafficAround(location: string, radius = 1000): Promise<AmapTraffic> {
      const json = await get('/v3/traffic/status/circle', { location, radius, level: 6 })
      const info = json.trafficinfo ?? {}
      return {
        status: TRAFFIC_STATUS[Number(info.status ?? 0)] ?? 'unknown',
        expedite: Number(info.expedite ?? 0), congested: Number(info.congested ?? 0), blocked: Number(info.blocked ?? 0),
      }
    },

    /**
     * 静态地图图片 URL——纯拼接，不发请求。小尺寸卡片用这个画地图，
     * 不用挂 JS SDK，天然不受卡片重绘影响。
     *
     * 有覆盖物（路线/图钉）时**不要**写死 location/zoom：高德会按覆盖物自动算视野，
     * 写死了远距离路线的起点会被裁出画面。
     */
    staticMapUrl(opts: { location?: string; zoom?: number; size?: string; markers?: string; path?: string }): string {
      const qs = new URLSearchParams({ key: keys.webKey, size: opts.size ?? '400*300' })
      const hasOverlay = Boolean(opts.markers || opts.path)
      if (!hasOverlay) {
        qs.set('location', opts.location ?? '116.397428,39.90923')
        qs.set('zoom', String(opts.zoom ?? 14))
      }
      // paths 格式：粗细,颜色,透明度,填充色,填充透明度:坐标串
      if (opts.path) qs.set('paths', `6,0x1E6FD9,1,,:${opts.path}`)
      if (opts.markers) qs.set('markers', opts.markers)
      return `${BASE}/v3/staticmap?${qs.toString()}`
    },

    /** 公交路线关键字查询（v3/bus/linename）——city 必填，高德这个接口不接受留空 */
    async busSearch(keywords: string, city: string): Promise<AmapBusLine[]> {
      const json = await get('/v3/bus/linename', { keywords, city, extensions: 'base' })
      return (json.buslines ?? []).map((b: any) => ({
        id: b.id, type: b.type, name: b.name, startStop: b.start_stop, endStop: b.end_stop,
      }))
    },

    /** 坐标转换（v3/assistant/coordinate/convert）——非高德坐标系转过来，供以后接入外部坐标源用 */
    async coordConvert(locations: string[], coordsys: 'gps' | 'mapbar' | 'baidu' = 'gps'): Promise<string[]> {
      const json = await get('/v3/assistant/coordinate/convert', { locations: locations.join('|'), coordsys })
      return String(json.locations ?? '').split(';').filter(Boolean)
    },
  }
}

export type AmapClient = ReturnType<typeof createAmapClient>
