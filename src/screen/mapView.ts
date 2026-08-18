/**
 * 高德 JS API 活地图。
 *
 * 为什么不是静态图：静态图是一张死图片，没有缩放、没有平移、路线是烘焙好的。
 * 活地图能真实呈现"导航中"的感觉，也是车机该有的样子。
 *
 * 关键约束：地图实例有状态，**绝不能随卡片文字刷新被销毁重建**（会闪、会丢视角）。
 * 所以这里按容器缓存实例，只更新覆盖物；卡片渲染那边保证容器节点本身不被替换。
 *
 * 加载失败（无网、Key 无效、域名白名单没配）时静默返回 false，
 * 由调用方回退到静态图——演示不能因为地图挂了就白屏。
 */

const JS_KEY = (import.meta as any).env?.VITE_AMAP_JS_KEY || ''
const JS_SECRET = (import.meta as any).env?.VITE_AMAP_JS_SECRET || ''

/** 底图渲染完成的等待上限，超时就认定渲不出来 */
const RENDER_TIMEOUT = 6000

let loading: Promise<boolean> | null = null

/** 动态加载 JS API。只加载一次，失败不再重试（避免每帧重试刷屏） */
function loadAMap(): Promise<boolean> {
  if (loading) return loading
  if (!JS_KEY) return (loading = Promise.resolve(false))

  loading = new Promise<boolean>(resolve => {
    // 安全密钥必须在脚本加载前设好，否则 2021 后的 JS API 会拒绝服务
    if (JS_SECRET) (window as any)._AMapSecurityConfig = { securityJsCode: JS_SECRET }
    const s = document.createElement('script')
    s.src = `https://webapi.amap.com/maps?v=2.0&key=${JS_KEY}`
    s.onload = () => resolve(Boolean((window as any).AMap))
    s.onerror = () => resolve(false)
    document.head.appendChild(s)
  })
  return loading
}

const parse = (loc?: string): [number, number] | null => {
  const [lng, lat] = (loc ?? '').split(',').map(Number)
  return Number.isFinite(lng) && Number.isFinite(lat) ? [lng, lat] : null
}

interface Live {
  map: any; overlays: any[]; sig: string
  /** 图层与模拟行驶的活对象（2026-08-18 白捡批）：加了要能撤，撤了要能再加 */
  sat?: any; traf?: any; mover?: any; cruising?: boolean
}
const live = new WeakMap<HTMLElement, Live>()

export interface RouteView {
  originLoc?: string
  destLoc?: string
  polyline?: string
  /** 分号分隔的途经点坐标串 */
  waypoints?: string
  /* ── 地图显示状态（map.control 写的信号，经导航卡 data 传到这） ── */
  mapZoom?: number
  mapView?: 'follow' | 'overview'
  mapStyle?: '2d' | '3d' | 'satellite'
  mapHeading?: 'north' | 'vehicle'
  /** 实时路况图层（红黄绿） */
  mapTraffic?: boolean
  /** 模拟行驶：车标沿路线跑一遍（演示用） */
  cruise?: boolean
}

/**
 * 在容器里画出路线。容器已有地图就复用，只重画覆盖物。
 * @returns 是否成功（false 时调用方应回退静态图）
 */
export async function showRoute(box: HTMLElement, v: RouteView): Promise<boolean> {
  const ok = await loadAMap()
  if (!ok) return false
  const AMap = (window as any).AMap

  const path = (v.polyline ?? '').split(';').map(parse).filter(Boolean) as [number, number][]
  const origin = parse(v.originLoc)
  const dest = parse(v.destLoc)
  if (!dest && !path.length) return false

  const sig = `${v.originLoc}|${v.destLoc}|${v.waypoints ?? ''}|${path.length}`
  const existing = live.get(box)
  if (existing?.sig === sig) {
    // 路线没变不重建 overlay，但**视图状态每次都应用** —— zoom/视角/朝向
    // 是 map.control 改的，跟路线无关；这些操作幂等且便宜
    applyView(existing.map, v, path, existing.overlays)
    applyExtras(existing, v, path)
    return true
  }

  let map = existing?.map
  if (!map) {
    map = new AMap.Map(box, {
      zoom: 13,
      center: dest ?? origin ?? undefined,
      // 车机上不需要用户操作地图，关掉交互省得误触；也更像真车的导航视图
      dragEnable: false, zoomEnable: false, doubleClickZoom: false,
    })
    // 底图真的渲染出来才算数。2.0 的矢量底图走 WebGL，遇到软件渲染的环境会
    // "瓦片下载成功但画不出来"（实测过，屏幕一片白）——complete 事件不来就当它没戏，
    // 交给调用方回退静态图。特性检测（webgl2 是否可创建）实测不可靠，别用。
    const painted = await new Promise<boolean>(resolve => {
      const done = () => resolve(true)
      map.on('complete', done)
      setTimeout(() => resolve(false), RENDER_TIMEOUT)
    })
    if (!painted) {
      map.destroy?.()
      box.innerHTML = ''
      return false
    }
  }

  existing?.overlays.forEach(o => map.remove(o))
  const overlays: any[] = []

  if (path.length > 1) {
    overlays.push(new AMap.Polyline({
      path, strokeColor: '#1E6FD9', strokeWeight: 8, strokeOpacity: 0.95, lineJoin: 'round', showDir: true,
    }))
  }
  const pin = (pos: [number, number], color: string, radius = 9) => new AMap.CircleMarker({
    center: pos, radius, fillColor: color, fillOpacity: 1, strokeColor: '#fff', strokeWeight: 3,
  })
  if (origin) overlays.push(pin(origin, '#2E7FD6'))
  // 途经点单独标出来，否则用户只看到一条绕远的线，不知道为什么绕
  for (const w of (v.waypoints ?? '').split(';').map(parse).filter(Boolean) as [number, number][])
    overlays.push(pin(w, '#C97A16', 8))
  if (dest) overlays.push(pin(dest, '#DB4045'))

  overlays.forEach(o => map.add(o))
  const entry: Live = { map, overlays, sig }
  live.set(box, entry)
  applyView(map, v, path, overlays)
  applyExtras(entry, v, path)
  return true
}

/**
 * 图层与模拟行驶（2026-08-18 已有 Key 白捡批）。
 * 全部幂等：开了不重复加、关了真移除——map.control 每次刷新都会走到这。
 */
function applyExtras(l: Live, v: RouteView, path: [number, number][]) {
  const AMap = (window as any).AMap
  try {
    // 卫星底图
    if (v.mapStyle === 'satellite' && !l.sat) { l.sat = new AMap.TileLayer.Satellite(); l.map.add(l.sat) }
    else if (v.mapStyle !== 'satellite' && l.sat) { l.map.remove(l.sat); l.sat = null }
    // 实时路况（红黄绿），autoRefresh 让它自己保持新鲜
    if (v.mapTraffic && !l.traf) { l.traf = new AMap.TileLayer.Traffic({ autoRefresh: true }); l.map.add(l.traf) }
    else if (!v.mapTraffic && l.traf) { l.map.remove(l.traf); l.traf = null }
    // 模拟行驶：车标沿路线 moveAlong（MoveAnimation 插件按需加载）
    if (v.cruise && !l.cruising && path.length > 1) {
      l.cruising = true
      AMap.plugin(['AMap.MoveAnimation'], () => {
        if (!l.cruising) return   // 插件加载回来前用户已经停了
        if (!l.mover) l.mover = new AMap.Marker({ map: l.map, position: path[0], zIndex: 200, anchor: 'center' })
        l.mover.moveAlong(path, { duration: 300, autoRotation: true })
      })
    } else if (!v.cruise && l.cruising) {
      l.cruising = false
      l.mover?.stopMove?.()
    }
  } catch { /* 图层能力缺失（老内核）不该影响路线本体 */ }
}

/**
 * 应用地图显示状态（map.control 写的信号，经导航卡 data 到这）。
 * 幂等且便宜，路线没变时也每次都应用 —— zoom/视角/朝向跟路线无关。
 *
 * 车头朝上没有真实航向可用（模拟环境），拿路线首段的方位角近似 ——
 * 演示里车总朝着路线方向走，误差可接受。
 */
function applyView(map: any, v: RouteView, path: [number, number][], overlays?: any[]) {
  try {
    if (v.mapView !== 'follow') {
      // 全览（也是缺省）：让整条路线都在视野内，留点边距别贴边。
      // **显式传 overlays** —— null 在个别版本会被当成空数组，什么都不缩放
      map.setFitView(overlays?.length ? overlays : undefined, false, [40, 40, 40, 40])
    } else {
      const center = parse(v.originLoc) ?? parse(v.destLoc)
      if (center) map.setCenter(center)
      if (typeof v.mapZoom === 'number') map.setZoom(v.mapZoom)
    }
    map.setPitch?.(v.mapStyle === '3d' ? 55 : 0)
    if (v.mapHeading === 'vehicle' && path.length > 1) {
      const [x1, y1] = path[0], [x2, y2] = path[Math.min(8, path.length - 1)]
      const bearing = Math.atan2(x2 - x1, y2 - y1) * 180 / Math.PI
      map.setRotation?.(-bearing)
    } else map.setRotation?.(0)
  } catch { /* 个别内核不支持 pitch/rotation，静默跳过 */ }
}

/**
 * 销毁容器里的地图实例。卡片缩到不显示地图的尺寸时调用——
 * 留着不管的话，容器尺寸变了画布会错位，而且白占一个 WebGL context。
 * 放大回来时 showRoute 会自己重建。
 */
export function disposeRoute(box: HTMLElement) {
  const l = live.get(box)
  if (!l) return
  l.map.destroy?.()
  live.delete(box)
  box.innerHTML = ''
}

/** 容器尺寸变了要通知地图重算视口，否则画布留在旧尺寸上 */
export function resizeRoute(box: HTMLElement) {
  live.get(box)?.map.resize?.()
}
