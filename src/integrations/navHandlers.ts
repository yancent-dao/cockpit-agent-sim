/**
 * 导航 + 天气的 handler 实现，从 registry.ts 拆出来——
 * 这部分是"有真实逻辑"的代码（接高德真实 API），会持续变大，
 * 单独一个文件才不会把通用机制（registry.ts）冲垮。
 */
import type { Store } from '../core/store'
import type { OpenMeteoClient } from './openmeteo'
import { shortPlace } from '../text'
import type { Desk } from '../cards/desk'
import { AmapError, thinPolyline, type AmapClient, type CarType } from './amap'
import type { ToolResult } from '../tools/registry'
import { CANDIDATES } from './mediaHandlers'

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

export function createNavHandlers(store: Store, needAmap: () => AmapClient, desk?: () => Desk | undefined,
                                  round?: () => number, storage?: { get(k: string): string | null; set(k: string, v: string): void },
                                  openmeteo?: OpenMeteoClient) {
  /**
   * 常用地址。**持久化的**（2026-08-15 改）——原来是内存数组，
   * "记住了，家"刷新页面就忘，而 places.save 的描述一直承诺
   * "之后用户说回家就能直接导航"，那是跨会话的承诺。
   * 内存副本照旧当工作集，写的时候透写进存储；坏数据当没有，别把导航带崩。
   */
  const PLACES_KEY = 'cockpit-sim:places'
  const places: SavedPlace[] = (() => {
    try { return JSON.parse(storage?.get(PLACES_KEY) ?? '[]') } catch { return [] }
  })()
  const persistPlaces = () => { try { storage?.set(PLACES_KEY, JSON.stringify(places)) } catch { /* 配额满了就算了 */ } }
  /**
   * 候选列表卡：多个候选自动上屏，事情一办完就撤——显示是机制，不指望模型自觉。
   * 注意不能用 untilTaskEnd（用户下一句就撤）：实测用户的下一句常常正是冲着这张卡问的
   * （"上面那个离这儿多远？"），撤了他就没东西可指。撤销点放在"这件事翻篇"上。
   */
  const showCandidates = (pois: Array<{ name: string; address: string }>) => {
    const r = desk?.()?.render({
      key: CANDIDATES, template: 'list', kind: 'task', ttl: 120, refreshTtl: true,   // 尺寸交给内容建议：3 条小卡、10 条大卡
      data: { title: '你要去哪个？', items: pois.map(p => ({ label: p.name, sub: p.address })) },
    })
    // 桌面满时不再是"没显示"——它进了等位区，空位一出现自动上台（2026-08-13）。
    // 但那一刻屏幕上确实还没有它，Agent 仍需要知道，别对着空屏幕说"你说第几个"
    return !!(r && (r as any).staged)
  }
  /** 目的地定了，候选列表、方案对比、周边搜索都完成使命（实拍：从"附近的停车场"
   *  挑一个设成目的地后那张列表一直留着）。比路线时只撤候选、留下路线卡 */
  const dismissCandidates = (keys = [CANDIDATES, 'routes', 'along']) => {
    const d = desk?.()
    for (const key of keys) {
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
        const amap = needAmap()
        // 没指定城市就限定在车所在的城市。全国搜会命中千里之外的同名地点——
        // 实测用户在成都说"临平出口"，搜到了杭州临平区，规划出 1800 公里
        const region = args.near || await amap.cityOf(store.get('vehicle.location') as string).catch(() => null)
        const pois = await amap.placeSearch(args.query, region ?? undefined)
        const notShown = pois.length >= 2 && showCandidates(pois)
        return {
          status: 'ok', data: { pois },
          ...(notShown && {
            code: 'CARD_STAGED',
            message: '候选列表先排队等桌面腾地方了（不是消失，位置一空自动显示），播报时把候选念出来，别让用户去屏幕上找',
          }),
        }
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
      persistPlaces()
      dismissCandidates() // 存好了，那张"你要存哪个"的候选卡完成使命
      return { status: 'ok', data: { saved: place }, message: `记住了，${args.alias}` }
    },

    placesList: (): ToolResult => ({ status: 'ok', data: { places } }),

    /**
     * 地图显示控制。**全部状态化**：zoom 是档位、全览/跟随是视图状态、
     * 2D/3D 与朝向是模式 —— 车机屏读状态渲染，不发命令（桌面 = f(状态)）。
     */
    mapControl: (args: any): ToolResult => {
      if (!args?.action && !args?.style && !args?.heading)
        return { status: 'rejected', code: 'INVALID_PARAMS',
          message: '要说清干什么：放大缩小、看全程、回自车位，或者换 2D/3D、换朝向' }
      const changed: string[] = []
      if (args.action === 'zoomIn' || args.action === 'zoomOut') {
        const cur = store.get('navigation.mapZoom') as number
        const next = Math.max(8, Math.min(18, cur + (args.action === 'zoomIn' ? 1 : -1)))
        store.set('navigation.mapZoom', next); changed.push('navigation.mapZoom')
      } else if (args.action === 'overview' || args.action === 'follow') {
        store.set('navigation.mapView', args.action); changed.push('navigation.mapView')
      }
      if (args.style) { store.set('navigation.mapStyle', args.style); changed.push('navigation.mapStyle') }
      if (args.heading) { store.set('navigation.mapHeading', args.heading); changed.push('navigation.mapHeading') }
      return { status: 'ok', changed }
    },


    /** 改名 = 删了重存，不单开 Tool —— 两个动作模型都会做，别为组合发明新协议 */
    placesRemove: (args: any): ToolResult => {
      const i = places.findIndex(p => p.alias === args.alias)
      if (i < 0)
        return { status: 'rejected', code: 'NOT_FOUND',
          message: `没有存过「${args.alias}」`, suggestion: '用 places.list 看看现在都存了哪些' }
      const [gone] = places.splice(i, 1)
      persistPlaces()
      return { status: 'ok', data: { removed: gone }, message: `删掉了，${gone.alias}` }
    },

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
          key: 'along', template: 'list', kind: 'task', ttl: 120, refreshTtl: true,
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

        dismissCandidates([CANDIDATES]) // 能比路线说明目的地已经定了
        desk?.()?.render({
          key: 'routes', template: 'list', kind: 'task', ttl: 120, refreshTtl: true,
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
        store.set('navigation.waypointNames', (args.waypointNames ?? []).join(';'))
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
        // 坐标串要走逆地理编码。geocode 是"地名→坐标"，拿 104.065861,30.657401
        // 去搜会命中内蒙古一个叫"一零四"的地方——实测撞到过，卡片标题成了
        // "阿拉善左旗一零四天气"
        const isCoord = /^\s*-?\d{1,3}(\.\d+)?\s*,\s*-?\d{1,2}(\.\d+)?\s*$/.test(String(args.location))
        // geocode 只打一次，adcode 和坐标都从同一份结果取 ——
        // 打两次既多一个网络往返，也会把函数式假响应（并行查多地）吃错位
        const geo = isCoord ? null : await amap.geocode(args.location)
        const area = isCoord
          ? await amap.areaOf(String(args.location).trim())
          : geo && { adcode: geo.adcode, name: geo.formattedAddress }
        const g = area?.adcode ? { adcode: area.adcode, formattedAddress: area.name } : null
        if (!g?.adcode)
          return { status: 'unavailable', code: 'PLACE_NOT_FOUND', message: '找不到这个地方的天气', suggestion: '换个更常见的地名试试' }
        /**
         * 2026-08-15 换源：**Open-Meteo 优先，高德兜底**。
         * 换的唯一原因是逐小时（高德不给，hourly 块干等了一个月）；
         * 地名解析仍归高德 geocode —— 它最擅长中文地名，各家干最擅长的。
         * 兜底跟"活地图挂了退静态图"同一条：换源不能把天气变成单点。
         */
        let hourly, range
        let now: any, forecast: any
        const loc = isCoord ? String(args.location).trim() : geo?.location
        if (openmeteo && loc) {
          try {
            // 高德坐标是 lng,lat 序，Open-Meteo 要 lat,lon —— 接反了查出来是海里
            const [lng, lat] = String(loc).split(',').map(Number)
            const w = await openmeteo.forecast(lat, lng)
            now = w.now; forecast = w.forecast; hourly = w.hourly; range = w.range
          } catch { /* 挂了走下面的高德兜底 */ }
        }
        if (!now)
          [now, forecast] = await Promise.all([amap.weatherNow(g.adcode), amap.weatherForecast(g.adcode)])
        // 查询结果自动上屏——模型只负责播报，不用（也不该）自己搬数据建卡。
        // key 带 adcode：问"周边哪个县最凉快"会并行查一串地方，写死 key 会让它们
        // 互相覆盖，屏幕上只剩最后一个，跟播报的对比结论对不上。
        // 家族：同轮并查五个县五张并存，新一轮查别的城旧批退场。
        // ttl untilDismissed：天气是内容不是问题，不许 120 秒自己蒸发（用户点名）——
        // 堆卡由家族机制管，不再靠定时器兜底
        // 尺寸不写死：跟模板 defaultSize 走（1/6）。单城查询铺 1/3 太占地方（实拍），
        // 想看多日预报说"放大"就行
        desk?.()?.render({
          key: `weather:${g.adcode}`, family: 'weather', round: round?.(),
          template: 'weather', kind: 'task', ttl: 'untilDismissed',
          data: { title: `${shortPlace(g.formattedAddress)}天气`, now, forecast,
                  ...(hourly && { hourly }), ...(range && { range }) },
        })
        /**
         * message 要说清**卡上已经是全量**（实拍：用户"要最详细的"，模型
         * getLayout → 两次空 card.update 被拒 → 又把 forecast 抄回卡上，
         * 反而把 hourly 抄丢 —— 白烧 11 秒。它不知道屏上已经有了）。
         */
        return { status: 'ok',
          message: `${shortPlace(g.formattedAddress)}天气已上屏${hourly ? '（含逐小时降水与多日预报，已是最全）' : ''}，不用再建卡或搬数据，口头讲重点就行`,
          data: { city: g.formattedAddress, now, forecast,
            ...(hourly && { hourly: hourly.slice(0, 6) }) } }
      } catch (e) {
        return amapFail(e, '天气查询')
      }
    },
  }
}
