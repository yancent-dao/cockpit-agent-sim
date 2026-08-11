/**
 * 导航 + 天气的 handler 实现，从 registry.ts 拆出来——
 * 这部分是"有真实逻辑"的代码（接高德真实 API），会持续变大，
 * 单独一个文件才不会把通用机制（registry.ts）冲垮。
 */
import type { Store } from '../core/store'
import type { Desk } from '../cards/desk'
import { AmapError, thinPolyline, type AmapClient, type CarType } from './amap'
import type { ToolResult } from './registry'

/** 三方服务失败一律翻译成 unavailable——L2 的语义是"服务不可用"，不是"车不让做" */
const amapFail = (e: unknown, what: string): ToolResult => ({
  status: 'unavailable',
  code: e instanceof AmapError ? e.code ?? 'AMAP_ERROR' : 'AMAP_ERROR',
  message: `${what}服务暂时不可用：${e instanceof Error ? e.message : String(e)}`,
  suggestion: '可以稍后再试，或者换个说法',
})

/**
 * 导航地图：起点(A,蓝)/终点(B,红) 图钉 + 真实路线折线。
 * setDestination、getStatus 与导航卡规则共用同一套拼法。
 * 不写死 zoom —— 让高德按覆盖物自动算视野，否则远距离路线起点会被裁出画面。
 */
export const buildMapUrl = (
  amap: AmapClient, origin: string, destLocation: string, polyline?: string, waypoints: string[] = [],
) => {
  // 起点 A(蓝) / 途经点 1,2,3(橙) / 终点 B(红)。途经点没标注的话，
  // 用户只看到一条绕远的线，不知道为什么绕
  const marks = [
    `mid,0x2E7FD6,A:${origin}`,
    ...waypoints.map((w, i) => `mid,0xC97A16,${i + 1}:${w}`),
    `mid,0xDB4045,B:${destLocation}`,
  ]
  return amap.staticMapUrl({
    size: '750*420',
    ...(polyline && { path: thinPolyline(polyline) }),
    markers: marks.join('|'),
  })
}

export interface SavedPlace { alias: string; address: string; location: string }

/**
 * alias（常用地址）优先、poiId 次之、address 兜底，解析出目的地名称与坐标。
 * alias 命中时直接用存好的坐标，省一次地理编码往返。
 */
async function resolveDestination(
  amap: AmapClient,
  args: { poiId?: string; address?: string; alias?: string },
  places: SavedPlace[] = [],
) {
  if (args.alias) {
    const p = places.find(x => x.alias === args.alias)
    return p ? { name: p.alias, location: p.location } : null
  }
  if (args.poiId) {
    const p = await amap.placeDetail(args.poiId)
    return p && { name: p.name, location: p.location }
  }
  const g = await amap.geocode(args.address!)
  return g && { name: g.formattedAddress, location: g.location }
}

/**
 * 沿途搜索的中心点：导航中取路线中段（车已经在起点了，找"前方"的更有用），
 * 没导航就用当前位置。
 */
function searchCenter(store: Store): string {
  const poly = (store.get('navigation.routePolyline') as string) || ''
  const pts = poly.split(';').filter(Boolean)
  if (store.get('navigation.active') === true && pts.length > 1) return pts[Math.floor(pts.length / 2)]
  return store.get('vehicle.location') as string
}

/** 车牌与车型从信号取——这是车的固有属性，不该让用户每次报一遍 */
const vehicleProfile = (store: Store) => ({
  plate: (store.get('vehicle.plate') as string) || undefined,
  carType: (store.get('vehicle.carType') as CarType) || undefined,
})

export function createNavHandlers(store: Store, needAmap: () => AmapClient, desk?: () => Desk | undefined) {
  /** 常用地址。放内存即可——模拟环境不做持久化，刷新页面重来是可接受的 */
  const places: SavedPlace[] = []
  /**
   * 候选列表卡：多个候选自动上屏，事情一办完就撤——显示是机制，不指望模型自觉。
   * 注意不能用 untilTaskEnd（用户下一句就撤）：实测用户的下一句常常正是冲着这张卡问的
   * （"上面那个离这儿多远？"），撤了他就没东西可指。撤销点放在"这件事翻篇"上。
   */
  const showCandidates = (pois: Array<{ name: string; address: string }>) => {
    desk?.()?.render({
      key: 'nav-candidates', template: 'list', size: '1/2', kind: 'task', ttl: 120, refreshTtl: true,
      data: { title: '你要去哪个？', items: pois.map(p => ({ label: p.name, sub: p.address })) },
    })
  }
  /** 目的地定了，候选列表与方案对比都完成使命 */
  const dismissCandidates = () => {
    const d = desk?.()
    for (const key of ['nav-candidates', 'routes']) {
      const c = d?.findByKey(key)
      if (c) d!.dismiss(c.id)
    }
  }

  return {
    /* ── 失败一律 unavailable，绝不编造搜索结果或路线（CAR-bench 反幻觉） ── */
    navSearch: async (args: any): Promise<ToolResult> => {
      if (args.type === 'bus') {
        if (!args.near)
          return { status: 'rejected', code: 'INVALID_PARAMS', message: '搜公交线路必须指定城市，用 near 传，比如"北京"' }
        try {
          const buslines = await needAmap().busSearch(args.query, args.near)
          return { status: 'ok', data: { buslines } }
        } catch (e) {
          return amapFail(e, '公交线路查询')
        }
      }
      try {
        const pois = await needAmap().placeSearch(args.query, args.near)
        if (pois.length >= 2) showCandidates(pois)
        return { status: 'ok', data: { pois } }
      } catch (e) {
        return amapFail(e, '地点搜索')
      }
    },

    /**
     * 列出某地下辖区县。这是"附近哪个县城在下雨""周边哪个区限行"这类需求的第一步——
     * 先拿到候选区县，再用别的工具逐个查。
     */
    regionDistricts: async (args: any): Promise<ToolResult> => {
      const amap = needAmap()
      try {
        const area = args.area || await amap.cityOf(store.get('vehicle.location') as string)
        if (!area)
          return { status: 'unavailable', code: 'PLACE_NOT_FOUND', message: '定不了当前在哪个城市', suggestion: '直接说要查哪个城市周边' }
        const districts = await amap.districts(area)
        return { status: 'ok', data: { area, districts } }
      } catch (e) {
        return amapFail(e, '行政区域查询')
      }
    },

    /* ── 常用地址：回家/去公司不用每次报地址 ── */
    placesSave: (args: any): ToolResult => {
      const i = places.findIndex(p => p.alias === args.alias)
      const place: SavedPlace = { alias: args.alias, address: args.address, location: args.location }
      if (i >= 0) places[i] = place
      else places.push(place)
      dismissCandidates() // 存好了，那张"你要存哪个"的候选卡完成使命
      return { status: 'ok', data: { saved: place }, message: `记住了，${args.alias}` }
    },

    placesList: (): ToolResult => ({ status: 'ok', data: { places } }),

    /**
     * 沿途/周边搜索。导航中沿路线前方找，没导航就绕当前位置找。
     * 不传关键词时按车型给默认：电车找充电站、油车找加油站。
     */
    navSearchAlong: async (args: any): Promise<ToolResult> => {
      const amap = needAmap()
      const carType = store.get('vehicle.carType') as CarType
      const keyword = args.keyword || (carType === 'fuel' ? '加油站' : '充电站')
      try {
        // near 允许 Agent 指定搜索中心：拿到一批充电站后再挨个搜"这个站周围有没有饺子馆"
        // 这类复合需求，靠的就是把"搜哪儿"的决策权留给 Agent，而不是写死在这儿
        const center = args.near || searchCenter(store)
        const pois = await amap.placeAround(center, keyword, args.radius)
        desk?.()?.render({
          key: 'along', template: 'list', size: '1/2', kind: 'task', ttl: 120, refreshTtl: true,
          data: {
            title: `附近的${keyword}`,
            items: pois.map(p => ({
              label: p.name,
              sub: p.distance !== undefined ? `${Math.round(p.distance / 100) / 10}公里 · ${p.address}` : p.address,
            })),
          },
        })
        return { status: 'ok', data: { keyword, pois } }
      } catch (e) {
        return amapFail(e, `${keyword}搜索`)
      }
    },

    /** 多方案对比："快 3 分钟但多 15 块过路费" —— 市场车机的标配决策信息 */
    navCompareRoutes: async (args: any): Promise<ToolResult> => {
      if (!args.poiId && !args.address)
        return { status: 'rejected', code: 'INVALID_PARAMS', message: '至少要提供 poiId 或 address 其中一个' }
      const amap = needAmap()
      try {
        const resolved = await resolveDestination(amap, args)
        if (!resolved)
          return { status: 'unavailable', code: 'PLACE_NOT_FOUND', message: '找不到这个地方', suggestion: '换个更具体的地址或名称试试' }

        const origin = store.get('vehicle.location') as string
        const raw = await amap.drivingRoutes(origin, resolved.location, {
          preference: 'default', waypoints: args.waypoints, ...vehicleProfile(store),
        })
        const routes = raw.map(r => ({
          eta: Math.round((r.duration ?? 0) / 60),
          distance: Math.round(r.distance / 100) / 10,
          tolls: r.tolls,
          trafficLights: r.trafficLights,
          restricted: r.restricted,
        }))
        // 打人话标签，Agent 直接念，不用自己归纳
        const fastest = Math.min(...routes.map(r => r.eta))
        const cheapest = Math.min(...routes.map(r => r.tolls ?? 0))
        const labeled = routes.map(r => {
          const tags: string[] = []
          if (r.eta === fastest) tags.push('最快')
          if ((r.tolls ?? 0) === cheapest) tags.push((r.tolls ?? 0) === 0 ? '免费' : '最省钱')
          return { ...r, label: tags.join('·') || '备选' }
        })

        desk?.()?.render({
          key: 'routes', template: 'list', size: '1/2', kind: 'task', ttl: 120, refreshTtl: true,
          data: {
            title: `去${resolved.name}，几条路线`,
            items: labeled.map(r => ({
              label: `${r.label} ${r.eta}分钟`,
              sub: `${r.distance}公里${r.tolls ? ` · 过路费${r.tolls}元` : ' · 不收费'}`,
            })),
          },
        })

        return { status: 'ok', data: { destination: resolved.name, routes: labeled } }
      } catch (e) {
        return amapFail(e, '路线规划')
      }
    },

    navSetDestination: async (args: any): Promise<ToolResult> => {
      if (!args.poiId && !args.address && !args.alias)
        return { status: 'rejected', code: 'INVALID_PARAMS', message: '至少要提供 alias、poiId 或 address 其中一个' }
      const amap = needAmap()
      try {
        const resolved = await resolveDestination(amap, args, places)
        if (!resolved)
          return {
            status: 'unavailable', code: 'PLACE_NOT_FOUND',
            message: args.alias ? `没存过"${args.alias}"这个地址` : '找不到这个地方',
            suggestion: args.alias ? '可以先用 places.save 存一个，或者直接说具体地址' : '换个更具体的地址或名称试试',
          }

        const origin = store.get('vehicle.location') as string
        const mode = args.mode ?? 'driving'
        const route = mode === 'driving'
          ? await amap.driving(origin, resolved.location, {
              preference: args.preference ?? 'default',
              waypoints: args.waypoints,
              ...vehicleProfile(store), // 车牌与车型从信号取——限行规避不该让用户每次说一遍
            })
          : await amap.routeBy(mode, origin, resolved.location)
        const eta = Math.round((route.duration ?? 0) / 60)
        const distance = Math.round(route.distance / 100) / 10

        store.set('navigation.destination', resolved.name)
        store.set('navigation.eta', eta)
        store.set('navigation.distanceRemaining', distance)
        store.set('navigation.destinationLocation', resolved.location) // 存坐标，供 getStatus 以后重建地图
        store.set('navigation.nextInstruction', route.steps[0]?.instruction ?? '')
        store.set('navigation.routePolyline', route.polyline ?? '')
        store.set('navigation.waypoints', (args.waypoints ?? []).join(';'))
        store.set('navigation.active', true) // 最后置 active：编排器一看到它就要建卡，此时其它信号必须已就绪
        dismissCandidates() // 目的地定了，候选列表使命完成

        // 静态地图：车机屏没法访问高德 Key，图片 URL 得在这里（有 Key 的地方）拼好整个给它
        const mapUrl = buildMapUrl(amap, origin, resolved.location, route.polyline, args.waypoints)

        return {
          status: 'ok',
          data: {
            destination: resolved.name, eta, distance,
            tolls: route.tolls, tollDistance: route.tollDistance,
            restricted: route.restricted, trafficLights: route.trafficLights,
            steps: route.steps, polyline: route.polyline, mapUrl,
          },
        }
      } catch (e) {
        return amapFail(e, '路线规划')
      }
    },

    navControl: (args: any): ToolResult => {
      if ((args.action === 'start' || args.action === 'resume') && !store.get('navigation.destination'))
        return {
          status: 'rejected', code: 'NO_DESTINATION',
          message: '还没设置目的地，没法开始导航', suggestion: '要不要先帮你找个目的地？',
        }
      if (args.action === 'cancel') {
        store.set('navigation.active', false)
        store.set('navigation.destination', '')
        store.set('navigation.eta', 0)
        store.set('navigation.distanceRemaining', 0)
        store.set('navigation.destinationLocation', '')
        store.set('navigation.nextInstruction', '')
        store.set('navigation.routePolyline', '')
        store.set('navigation.waypoints', '')
      } else {
        store.set('navigation.active', args.action !== 'pause')
      }
      return { status: 'ok', data: { active: store.get('navigation.active') } }
    },

    navGetStatus: async (): Promise<ToolResult> => {
      const active = store.get('navigation.active') as boolean
      const distance = (store.get('navigation.distanceRemaining') as number) ?? 0
      const soc = (store.get('powertrain.soc') as number) ?? 0
      const estimatedRange = Math.round(soc * 4) // 简化估算：soc% × 4km/%，不是真实续航模型

      // 路况、地图都是导航中才有意义的附加信息，查/拼失败（包括 amap 依赖没装配）也不拖累核心状态查询
      let traffic
      let mapUrl
      if (active) {
        try {
          const amap = needAmap()
          try { traffic = await amap.trafficAround(store.get('vehicle.location') as string) }
          catch { /* 拿不到路况就不给，不影响其它字段 */ }
          const destLoc = store.get('navigation.destinationLocation') as string
          if (destLoc) mapUrl = buildMapUrl(amap, store.get('vehicle.location') as string, destLoc,
            store.get('navigation.routePolyline') as string)
        } catch { /* amap 未装配，跳过这些附加字段 */ }
      }

      return {
        status: 'ok',
        data: {
          active,
          destination: store.get('navigation.destination'),
          eta: store.get('navigation.eta'),
          distance, // 跟 setDestination 返回的字段名保持一致，方便两边共用同一张 nav 卡
          estimatedRange,
          enoughBattery: distance <= estimatedRange,
          ...(traffic && { traffic }),
          ...(mapUrl && { mapUrl }),
        },
      }
    },

    /* ── 天气：地名先转 adcode，查不到就诚实说查不到 ── */
    weatherQuery: async (args: any): Promise<ToolResult> => {
      const amap = needAmap()
      try {
        const g = await amap.geocode(args.location)
        if (!g?.adcode)
          return { status: 'unavailable', code: 'PLACE_NOT_FOUND', message: '找不到这个地方的天气', suggestion: '换个更常见的地名试试' }
        const [now, forecast] = await Promise.all([amap.weatherNow(g.adcode), amap.weatherForecast(g.adcode)])
        // 查询结果自动上屏——模型只负责播报，不用（也不该）自己搬数据建卡。
        // key 带 adcode：问"周边哪个县最凉快"会并行查一串地方，写死 key 会让它们
        // 互相覆盖，屏幕上只剩最后一个，跟播报的对比结论对不上。
        desk?.()?.render({
          key: `weather:${g.adcode}`, template: 'weather', size: '1/3', kind: 'task', ttl: 120, refreshTtl: true,
          data: { title: `${g.formattedAddress}天气`, now, forecast },
        })
        return { status: 'ok', data: { city: g.formattedAddress, now, forecast } }
      } catch (e) {
        return amapFail(e, '天气查询')
      }
    },
  }
}
