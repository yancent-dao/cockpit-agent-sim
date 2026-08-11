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

interface Live { map: any; overlays: any[]; sig: string }
const live = new WeakMap<HTMLElement, Live>()

export interface RouteView {
  originLoc?: string
  destLoc?: string
  polyline?: string
  /** 分号分隔的途经点坐标串 */
  waypoints?: string
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
  if (existing?.sig === sig) return true // 路线没变，别白折腾

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
  live.set(box, { map, overlays, sig })
  // 让整条路线都在视野内，留点边距别贴边
  map.setFitView(overlays, false, [40, 40, 40, 40])
  return true
}
