import { createBus, type BusMsg } from '../bus'
import { showRoute } from './mapView'

const $ = (id: string) => document.getElementById(id)!
const POS = ['driver', 'passenger', 'rearLeft', 'rearRight'] as const
const CN: Record<string, string> = { driver: '主驾', passenger: '副驾', rearLeft: '左后', rearRight: '右后' }

/* ── 等比缩放：设计稿 2560×1440 ── */
const stage = $('stage')
const fit = () => { stage.style.transform = `scale(${Math.min(innerWidth / 2560, innerHeight / 1440)})` }
addEventListener('resize', fit); fit()
addEventListener('keydown', e => {
  if (e.key.toLowerCase() === 'f')
    document.fullscreenElement ? document.exitFullscreen() : document.documentElement.requestFullscreen()
})

/* ── 车窗渲染状态：车机屏自己跑过渡动画，控制面板只下发 target ── */
const cur: Record<string, number> = { driver: 0, passenger: 0, rearLeft: 0, rearRight: 0 }
const tgt: Record<string, number> = { ...cur }
let meta: Record<string, any> = { speed: 0, childLock: false, weather: 'cloudy', outTemp: 3, soc: 68 }
let hotWindows: string[] = []
const TRANSIT = 4000

/* ── 桌面卡片：位置由 desk 统一计算下发，车机屏只负责画 ── */
interface CardView {
  id: string; template: string; size: string; kind: string; title: string; data: any
  row: number; col: number; rowSpan: number; colSpan: number
}
let deskState: { cards: CardView[]; overlay?: CardView; free: number } = { cards: [], free: 6 }
let hotCards = new Set<string>()
const esc = (s: any) => String(s ?? '').replace(/[&<>]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;' }[c]!))

const CAR_SVG = `<svg viewBox="0 0 520 900" preserveAspectRatio="xMidYMid meet" style="height:100%;width:100%">
  <defs>
    <linearGradient id="bg" x1="0" y1="0" x2="1" y2="1">
      <stop offset="0" stop-color="#FBFCFE"/><stop offset=".5" stop-color="#E7ECF2"/><stop offset="1" stop-color="#D3DAE3"/>
    </linearGradient>
    <linearGradient id="tire" x1="0" y1="0" x2="0" y2="1">
      <stop offset="0" stop-color="#3A3F47"/><stop offset="1" stop-color="#1B1E23"/>
    </linearGradient>
  </defs>
  <!-- 轮胎：四角外露，俯视图最能辨认"这是一辆车"的细节 -->
  <rect x="46" y="214" width="30" height="128" rx="14" fill="url(#tire)"/>
  <rect x="444" y="214" width="30" height="128" rx="14" fill="url(#tire)"/>
  <rect x="46" y="592" width="30" height="128" rx="14" fill="url(#tire)"/>
  <rect x="444" y="592" width="30" height="128" rx="14" fill="url(#tire)"/>
  <!-- 车身：浅色烤漆，前后保险杠收圆 -->
  <rect x="60" y="30" width="400" height="840" rx="96" fill="url(#bg)" stroke="#B7C1CE" stroke-width="3"/>
  <!-- 引擎盖 / 后备箱棱线，车身细节 -->
  <path d="M170 60 L350 60" stroke="#C6CFD9" stroke-width="4" stroke-linecap="round"/>
  <path d="M170 838 L350 838" stroke="#C6CFD9" stroke-width="4" stroke-linecap="round"/>
  <!-- 后视镜 -->
  <rect x="52" y="248" width="18" height="34" rx="7" fill="#C6CFD9" stroke="#AEB9C6" stroke-width="1.5"/>
  <rect x="450" y="248" width="18" height="34" rx="7" fill="#C6CFD9" stroke="#AEB9C6" stroke-width="1.5"/>
  <!-- 前挡风玻璃（深色隔热玻璃，白天也是暗色） -->
  <path d="M118 268 L402 268 L372 196 Q260 172 148 196 Z" fill="#141B24" stroke="#2C3644" stroke-width="2"/>
  <!-- 车顶：包住四扇侧窗 -->
  <rect x="118" y="272" width="284" height="368" rx="34" fill="#1A212B" stroke="#2C3644" stroke-width="2"/>
  <!-- 后挡风玻璃 -->
  <path d="M126 644 L394 644 L366 716 Q260 738 154 716 Z" fill="#141B24" stroke="#2C3644" stroke-width="2"/>
  <!-- 尾灯 -->
  <rect x="96" y="842" width="106" height="16" rx="8" fill="#C0392B"/>
  <rect x="318" y="842" width="106" height="16" rx="8" fill="#C0392B"/>
  <g id="wins"></g></svg>`

const WIN = [
  { id: 'driver', x: 104, y: 290, w: 26, h: 158 },
  { id: 'rearLeft', x: 104, y: 462, w: 26, h: 158 },
  { id: 'passenger', x: 390, y: 290, w: 26, h: 158 },
  { id: 'rearRight', x: 390, y: 462, w: 26, h: 158 },
]

/**
 * 把高德的一句话指引（"沿人民南路向东行驶141米右转"）拆成
 * 距离 + 动作 + 箭头，好让转向条像真车导航那样一眼可读。
 * 纯展示层的文本解析，不是业务逻辑。
 */
const TURN_ICONS: Array<[RegExp, string]> = [
  [/左转|向左/, '↰'], [/右转|向右/, '↱'],
  [/掉头/, '⤺'], [/环岛/, '⟳'],
  [/靠左|左前/, '↖'], [/靠右|右前/, '↗'],
  [/到达|终点/, '◎'],
]
function parseTurn(instruction: string) {
  const dist = instruction.match(/(\d+(?:\.\d+)?)\s*(米|公里|千米)/)
  const icon = TURN_ICONS.find(([re]) => re.test(instruction))?.[1] ?? '↑'
  // 动作取最后一个动词短语，前面的路名信息在小屏上属于噪音
  const action = instruction.replace(/^.*?(\d+(?:\.\d+)?)\s*(米|公里|千米)/, '').trim() || instruction
  return { dist: dist ? `${dist[1]}${dist[2]}` : '', action, icon }
}

/**
 * 导航卡单独渲染：地图容器建一次就长在那儿，之后只更新转向条与底部数字。
 * 整块 innerHTML 重刷会把活地图实例冲掉（闪屏、丢视角），所以这里必须分开处理。
 */
function renderNavCard(node: HTMLDivElement, c: CardView) {
  const d = c.data ?? {}
  if (!node.querySelector('.navwrap')) {
    node.innerHTML = `<div class="navwrap">
      <div class="turnbar"></div>
      <div class="mapbox"></div>
      <div class="navfoot"></div>
    </div>`
  }
  const step = d.steps?.[0]?.instruction as string | undefined
  const turn = step ? parseTurn(step) : undefined
  const bar = node.querySelector('.turnbar') as HTMLElement
  bar.style.display = turn ? '' : 'none'
  if (turn) bar.innerHTML = `<div class="arrow">${turn.icon}</div>
    <div class="turntext"><b>${esc(turn.dist)}</b><span>${esc(turn.action)}</span></div>`

  node.querySelector('.navfoot')!.innerHTML = `
    <div class="navbig"><b>${d.eta ?? '--'}</b><span>分钟</span></div>
    <div class="navbig"><b>${d.distance ?? '--'}</b><span>公里</span></div>
    <div class="navdest">${esc(d.destination ?? '')}</div>`

  // 活地图优先；跑不了（无 Key / 环境不支持 WebGL2 / 加载失败）就退回静态图，绝不白屏
  const box = node.querySelector('.mapbox') as HTMLElement
  showRoute(box, { originLoc: d.originLoc, destLoc: d.destLoc, polyline: d.polyline, waypoints: d.waypoints }).then(ok => {
    if (ok || !d.mapUrl) return
    const img = box.querySelector('img') as HTMLImageElement | null
    if (img) { if (img.src !== d.mapUrl) img.src = d.mapUrl } // 只换地址，不重建节点
    else box.innerHTML = `<img class="mapimg" src="${esc(d.mapUrl)}" alt="路线地图">`
  })
}

/** 卡片模板渲染 —— 模板为主 + 通用卡兜底 */
function body(c: CardView): string {
  const d = c.data ?? {}
  switch (c.template) {
    case 'vehicle':
      return `<div style="flex:1;min-height:0;display:flex;align-items:center;justify-content:center">${CAR_SVG}</div>`
    case 'control':
      return (d.items ?? []).map((it: any) => {
        const isPct = typeof it.value === 'number' && it.unit === '%'
        const shown = typeof it.value === 'boolean' ? (it.value ? '开' : '关')
          : typeof it.value === 'number' ? `${Math.round(it.value)}${esc(it.unit ?? '')}`
          : esc(String(it.value ?? '--'))
        return `
        <div class="win${hotWindows.includes(it.key) ? ' hot' : ''}">
          <div class="top"><span>${esc(it.label)}</span><em>${shown}</em></div>
          ${isPct ? `<div class="track"><div class="fill" style="width:${Math.round(it.value)}%"></div></div>` : ''}
        </div>`
      }).join('')
    case 'confirm':
      return `<div class="sub">${esc(d.question ?? d.text)}</div>
        <div>${(d.options ?? ['确认', '取消']).map((o: string) => `<span class="opt">${esc(o)}</span>`).join('')}</div>`
    case 'notice':
      return `<div class="sub">${esc(d.text)}</div>${d.suggestion ? `<div class="sug">${esc(d.suggestion)}</div>` : ''}`
    case 'list':
      // 带序号：用户是用语音选的（"第一个"），屏上必须能对上号
      return `<ol class="listcard">${(d.items ?? []).map((i: any) =>
        `<li><b>${esc(i.label)}</b>${i.sub ? `<small>${esc(i.sub)}</small>` : ''}</li>`).join('')}</ol>`
    case 'capability':
      return `<div class="cap">${(d.items ?? []).map((i: any) =>
        `<div class="${i.off ? 'off' : ''}">${esc(i.label)}<small>${esc(i.desc ?? '')}</small></div>`).join('')}</div>`
    case 'weather':
      return `${d.now ? `<div class="rowline"><span>现在</span><em>${esc(d.now.weather)} ${Math.round(d.now.temperature)}°C</em></div>
        <div class="sub">${esc(d.now.wind ?? '')}${d.now.humidity !== undefined ? ` · 湿度${d.now.humidity}%` : ''}</div>` : ''}
        ${(d.forecast ?? []).slice(0, 3).map((f: any) => `
        <div class="rowline"><span>${esc(f.date)}</span><em>${esc(f.dayWeather)} ${Math.round(f.dayTemp)}°/${Math.round(f.nightTemp)}°</em></div>`).join('')}`
    case 'nav':
      // 导航卡由 renderNavCard 单独处理——活地图有状态，不能跟着文字一起重绘
      return ''
    default:
      return `<div class="sub">${esc(d.text ?? '')}</div>`
  }
}

/**
 * 卡片节点按 id 复用，不再整体 innerHTML 重绘。
 * 原因：车窗动画每帧都调 renderDesk()，整体重绘会把其它卡片（将来可能是活地图组件）
 * 一起销毁重建——地图瓦片闪烁、状态丢失。CSS Grid 用 grid-row/grid-column 显式定位，
 * 不依赖 DOM 顺序，所以"节点建好之后只挪位置、按需更内容"是安全的。
 */
const cardNodes = new Map<string, HTMLDivElement>()
const cardSig = (c: CardView) => `${c.template}|${c.title}|${JSON.stringify(c.data)}|${hotCards.has(c.id)}`

function renderDesk() {
  const desk = $('desk')
  const seen = new Set<string>()
  // 占位符零状态，直接整体重建最简单，不需要跟卡片一样按身份复用
  desk.querySelectorAll('.slot').forEach(el => el.remove())

  const occupied: boolean[][] = [[false, false, false], [false, false, false]]
  for (const c of deskState.cards) {
    seen.add(c.id)
    for (let dr = 0; dr < c.rowSpan; dr++)
      for (let dc = 0; dc < c.colSpan; dc++) occupied[c.row + dr]?.splice(c.col + dc, 1, true)
    let node = cardNodes.get(c.id)
    if (!node) {
      node = document.createElement('div')
      cardNodes.set(c.id, node)
      desk.appendChild(node)
    }
    node.style.gridRow = `${c.row + 1} / span ${c.rowSpan}`
    node.style.gridColumn = `${c.col + 1} / span ${c.colSpan}`
    node.className = `card tpl-${c.template} kind-${c.kind}${hotCards.has(c.id) ? ' hot' : ''}`
    const sig = cardSig(c)
    if (node.dataset.sig !== sig) {
      if (c.template === 'nav') renderNavCard(node, c)
      else node.innerHTML = `<h3>${esc(c.title)}</h3>${body(c)}`
      node.dataset.sig = sig
    }
  }
  for (let r = 0; r < 2; r++) for (let col = 0; col < 3; col++) {
    if (occupied[r][col]) continue
    const slot = document.createElement('div')
    slot.className = 'slot'
    slot.style.gridRow = String(r + 1)
    slot.style.gridColumn = String(col + 1)
    desk.appendChild(slot)
  }

  // 卡片被移除时（不再出现在新状态里），才真正清掉对应 DOM 节点
  for (const [id, node] of cardNodes) {
    if (!seen.has(id)) { node.remove(); cardNodes.delete(id) }
  }

  const ov = $('overlay')
  if (deskState.overlay) {
    ov.className = 'on'
    ov.innerHTML = `<div class="card tpl-${deskState.overlay.template}">
      <h3>${esc(deskState.overlay.title)}</h3>${body(deskState.overlay)}</div>`
  } else { ov.className = ''; ov.innerHTML = '' }

  // 车辆示意图里的车窗
  const g = document.getElementById('wins')
  if (g) g.innerHTML = WIN.map(w => {
    const p = cur[w.id], h = Math.max(w.h * (1 - p / 100), 0)
    const hot = hotWindows.includes(w.id)
    return `<rect x="${w.x}" y="${w.y}" width="${w.w}" height="${w.h}" rx="12" fill="#05080D"/>
      <rect x="${w.x}" y="${w.y + (w.h - h)}" width="${w.w}" height="${h}" rx="12"
        fill="rgba(120,190,255,.42)" stroke="rgba(150,210,255,.5)" stroke-width="1.5"/>
      ${hot ? `<rect x="${w.x - 5}" y="${w.y - 5}" width="${w.w + 10}" height="${w.h + 10}" rx="15"
        fill="none" stroke="#4DA3FF" stroke-width="3"/>` : ''}`
  }).join('')
}

function renderStatus() {
  const c = $('chipSpd')
  c.textContent = meta.speed < 1 ? '静止 · P 挡' : `${Math.round(meta.speed)} km/h · D 挡`
  c.className = 'chip' + (meta.speed > 100 ? ' warn' : '')
  $('chipLock').style.display = meta.childLock ? '' : 'none'
  $('tOut').textContent = String(Math.round(meta.outTemp))
  $('soc').textContent = String(Math.round(meta.soc))
  $('wx').textContent = meta.weather === 'rain' ? '🌧 小雨' : '☁ 多云'
}

/* ── 过渡动画：车窗位置由车机屏本地逼近 target ── */
let last = performance.now()
const loop = (t: number) => {
  const dt = t - last; last = t
  let moved = false
  for (const k of POS) {
    const c = cur[k], g = tgt[k]
    if (Math.abs(c - g) > 0.4) {
      cur[k] = c < g ? Math.min(c + (dt / TRANSIT) * 100, g) : Math.max(c - (dt / TRANSIT) * 100, g)
      moved = true
    } else cur[k] = g
  }
  if (moved) {
    // 车窗卡的数值随过渡实时更新（L1 卡内控件级反馈）
    for (const card of deskState.cards)
      if (card.template === 'control' && card.data?.items)
        for (const it of card.data.items) if (it.key in cur) it.value = cur[it.key]
    renderDesk()
  }
  requestAnimationFrame(loop)
}
requestAnimationFrame(loop)

/* ── 语音层 ── */
const TAG: Record<string, string> = {
  idle: '待机', wakeup: '唤醒', listening: '聆听中', thinking: '思考中 · 等待模型首字',
  speaking: '播报中', executing: '执行中 · 形象缩小让位', confirming: '待确认',
  rejected: '已拒绝 · 说明原因与替代方案',
}
const setVoice = (s: string) => { $('voice').dataset.s = s; $('subTag').textContent = TAG[s] ?? s }
function setSub(text: string | null | undefined, who?: string) {
  const el = $('subText')
  if (text === null) { el.innerHTML = '<span class="cursor"></span>'; return }
  el.className = who === 'user' ? 'user' : ''
  el.textContent = text ?? ''
}

/* ── 消息处理 ── */
const bus = createBus((m: BusMsg | any) => {
  connected()
  switch (m.type) {
    case 'state':
      Object.assign(tgt, m.target); meta = { ...meta, ...m.meta }; renderStatus(); break
    case 'cards':
      deskState = m.desk; renderDesk(); break
    case 'voice':
      if (m.s) setVoice(m.s); if ('text' in m) setSub(m.text, m.who); break
    case 'highlight':
      hotWindows = m.ids ?? []
      hotCards = new Set(m.cards ?? [])
      renderDesk()
      setTimeout(() => { hotWindows = []; hotCards = new Set(); renderDesk() }, 2000)
      break
    case 'reject': {
      const el = $('reject')
      if (!m.on) { el.classList.remove('on'); break }
      $('rjT').textContent = m.title ?? ''; $('rjD').innerHTML = m.desc ?? ''
      el.classList.add('on'); break
    }
  }
})

let ok = false
const connected = () => { if (!ok) { ok = true; $('conn').style.opacity = '0' } }
const hello = () => bus.send({ type: 'hello' })
hello(); setTimeout(hello, 500); setInterval(hello, 4000)

setInterval(() => {
  const d = new Date()
  $('clock').textContent = `${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`
}, 1000)
renderStatus(); renderDesk()
export { CN }
