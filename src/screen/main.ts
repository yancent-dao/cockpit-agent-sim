import { injectTokens } from '../design/tokens'
import { createBus, type BusMsg } from '../bus'
import { parseTurn, dayLabel } from './turn'
import { navForm, mediaForm } from './layout'
import { createBannerQueue, toneOf } from './banner'
import { dimsOf, GRID, TIERS } from '../config/grid'
import { cardBody, tierClass, accentClass } from './render'
import { showRoute, disposeRoute, resizeRoute } from './mapView'
import { createPlayer } from './player'

// Token 必须运行时注入：build-single 只替换 <script>，外部 .css 在单文件版会整个丢失
injectTokens('screen')

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
const player = createPlayer({ report: (event, detail) => bus.send({ type: 'mediaEvent', event, detail } as any) })

// 必须在点击的事件处理函数里同步 unlock()，塞进 await 之后就不算用户手势了
$('unlock').addEventListener('click', () => {
  player.unlock()
  $('unlock').classList.add('gone')
}, { once: true })

/**
 * 播放器卡。跟导航卡同一个道理——<video> 元素不能跟着文字一起重绘，
 * 重建就从头开始播了，所以容器建一次就长在那儿。
 */
function renderPlayerCard(node: HTMLDivElement, c: CardView) {
  const d = c.data ?? {}
  const isVideo = d.source === 'video'
  const form = mediaForm(...dimsOf(c.size))
  if (!node.querySelector('.plwrap')) {
    node.innerHTML = `<div class="plwrap">
      <div class="plart"></div>
      <div class="plmeta"><b class="pltrack"></b><span class="plartist"></span>
        <div class="pl-hint"></div></div>
    </div>`
  }
  // 窄卡（封面挤掉歌名）竖排；封面本身在小档直接不出现
  node.classList.toggle('narrow', !form.blocks.includes('sub'))
  const art = node.querySelector('.plart') as HTMLElement
  art.style.display = form.blocks.includes('art') ? '' : 'none'
  const sub = node.querySelector('.plartist') as HTMLElement
  sub.style.display = form.blocks.includes('sub') ? '' : 'none'
  // 控制条是**状态指示不是按钮**——屏幕不可交互，画成图标就有诱导点击的风险。
  // 这行字把它标回语音能力，顺带填了「能力曝光度」的一半
  const hint = node.querySelector('.pl-hint') as HTMLElement
  hint.style.display = form.blocks.includes('hint') ? '' : 'none'
  hint.innerHTML = `◎ 说<b>「换一首」</b><b>「大点声」</b>都可以`
  if (isVideo) {
    player.attachVideo(art)
  } else {
    const url = String(d.artwork ?? '')
    const img = art.querySelector('img') as HTMLImageElement | null
    if (url) {
      if (img) { if (img.src !== url) img.src = url }
      else art.innerHTML = `<img src="${esc(url)}" alt="">`
    } else if (!img) {
      // 没封面就给个音源图标，别留个空洞
      art.innerHTML = `<div class="plicon">${d.source === 'radio' ? '📻' : '♪'}</div>`
    }
  }
  node.querySelector('.pltrack')!.textContent = String(d.track ?? '')
  node.querySelector('.plartist')!.textContent = String(d.artist ?? '')
  node.classList.toggle('is-video', isVideo)

  // 播放由卡片数据驱动——车机屏依然只是输出设备，不做任何"该播什么"的判断。
  // play() 内部对同一个地址是幂等的，重复渲染不会打断播放
  if (d.playing && d.streamUrl) player.play({ url: String(d.streamUrl), source: d.source, volume: Number(d.volume ?? 40) })
  else if (!d.playing) player.pause()
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
  // 尺寸决定形态：一格宽的地图看不出路，不如把空间让给转向指令
  const form = navForm(...dimsOf(c.size))
  const step = d.steps?.[0]?.instruction as string | undefined
  const turn = step ? parseTurn(step) : undefined
  const bar = node.querySelector('.turnbar') as HTMLElement
  bar.style.display = turn && form.blocks.includes('turn') ? '' : 'none'
  if (turn) bar.innerHTML = `<div class="arrow">${turn.icon}</div>
    <div class="turntext"><b>${esc(turn.dist)}</b><span>${esc(turn.action)}</span></div>
    ${turn.road ? `<div class="turnroad">${esc(turn.road)}</div>` : ''}`

  // 途经点要写出来：语音说了"先去充电站再去太古里"，屏幕只写终点的话用户不知道要绕路
  const via = (d.via ?? []).length ? `<em>经 ${esc((d.via as string[]).join('、'))}</em>` : ''
  const foot = node.querySelector('.navfoot') as HTMLElement
  foot.style.display = form.blocks.includes('foot') ? '' : 'none'
  foot.innerHTML = `
    <div class="navbig"><b>${d.eta ?? '--'}</b><span>分钟</span></div>
    <div class="navbig"><b>${d.distance ?? '--'}</b><span>公里</span></div>
    <div class="navdest">${via}${esc(d.destination ?? '')}</div>`

  const box = node.querySelector('.mapbox') as HTMLElement
  const hasMap = form.blocks.includes('map')
  // 没地图时两块要垂直居中，否则会被推到上下两端、中间空一大片
  node.classList.toggle('no-map', !hasMap)
  box.style.display = hasMap ? '' : 'none'
  if (!form.blocks.includes('map')) { disposeRoute(box); return }   // 小卡不画地图，实例留着会错位还白占 WebGL context
  // 还是显示地图但格子变了（2/3 ↔ 1/2）：实例留着，通知它重算视口
  if (node.dataset.mapSize && node.dataset.mapSize !== c.size) resizeRoute(box)
  node.dataset.mapSize = c.size
  // 活地图优先；跑不了（无 Key / 环境不支持 WebGL2 / 加载失败）就退回静态图，绝不白屏
  showRoute(box, { originLoc: d.originLoc, destLoc: d.destLoc, polyline: d.polyline, waypoints: d.waypoints }).then(ok => {
    if (ok || !d.mapUrl) return
    const img = box.querySelector('img') as HTMLImageElement | null
    if (img) { if (img.src !== d.mapUrl) img.src = d.mapUrl } // 只换地址，不重建节点
    else box.innerHTML = `<img class="mapimg" src="${esc(d.mapUrl)}" alt="路线地图">`
  })
}

/** 卡片模板渲染 —— 模板为主 + 通用卡兜底 */

/**
 * 卡片节点按 id 复用，不再整体 innerHTML 重绘。
 * 原因：车窗动画每帧都调 renderDesk()，整体重绘会把其它卡片（将来可能是活地图组件）
 * 一起销毁重建——地图瓦片闪烁、状态丢失。CSS Grid 用 grid-row/grid-column 显式定位，
 * 不依赖 DOM 顺序，所以"节点建好之后只挪位置、按需更内容"是安全的。
 */
const cardNodes = new Map<string, HTMLDivElement>()
// size 必须进签名：尺寸变了形态也要跟着变（导航卡缩小要收起地图），
// 不算进来的话只有栅格位置动、内容还是老样子
const cardSig = (c: CardView) => `${c.template}|${c.size}|${c.title}|${JSON.stringify(c.data)}|${hotCards.has(c.id)}`

function renderDesk() {
  const desk = $('desk')
  const seen = new Set<string>()
  // 占位符零状态，直接整体重建最简单，不需要跟卡片一样按身份复用
  desk.querySelectorAll('.slot').forEach(el => el.remove())

  const occupied: boolean[][] = Array.from({ length: GRID.rows }, () => Array(GRID.cols).fill(false))
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
    // 档位类给 --u（字号 = 字阶 × --u），语义色类给 --ac 一族。
    // sz-* 那 22 条硬怼 font-size 的规则被这一个类取代了
    // picking：等着用户开口选。用户是用语音选的（"第二个"），
    // 屏上必须让他知道现在轮到他说话了
    const picking = c.template === 'confirm' || (c.template === 'list' && c.data?.picking)
    node.className = `card tpl-${c.template} kind-${c.kind} ${tierClass(c.size)} ${
      accentClass(c.template, c.data)}${hotCards.has(c.id) ? ' hot' : ''}${picking ? ' picking' : ''}`
    const sig = cardSig(c)
    if (node.dataset.sig !== sig) {
      if (c.template === 'nav') renderNavCard(node, c)
      else if (c.template === 'media') renderPlayerCard(node, c)
      else {
        // .bd 认领全部剩余高度并让内容贴底——诊断 1「内容缩在左上角」的修法
        node.innerHTML = `<h3>${esc(c.title)}</h3><div class="bd">${cardBody(c)}</div>`
        // 车身图形是资源不是逻辑，留在这里填进 render 层给的占位
        const slot = node.querySelector('.vehslot')
        if (slot) slot.innerHTML = CAR_SVG
      }
      node.dataset.sig = sig
    }
  }
  // 占位符按**基准卡大小**（4×2）画，不是按单元格。48 个 1×1 小方块的空桌面
  // 看着像坏掉的棋盘；6 个基准块才读得出"这儿能放一张卡"
  const [bw, bh] = [TIERS.card.w, TIERS.card.h]
  for (let r = 0; r + bh <= GRID.rows; r += bh)
    for (let col = 0; col + bw <= GRID.cols; col += bw) {
      let free = true
      for (let dr = 0; dr < bh && free; dr++)
        for (let dc = 0; dc < bw; dc++) if (occupied[r + dr][col + dc]) { free = false; break }
      if (!free) continue
      const slot = document.createElement('div')
      slot.className = 'slot'
      slot.style.gridRow = `${r + 1} / span ${bh}`
      slot.style.gridColumn = `${col + 1} / span ${bw}`
      desk.appendChild(slot)
    }

  // 卡片被移除时（不再出现在新状态里），才真正清掉对应 DOM 节点
  for (const [id, node] of cardNodes) {
    if (!seen.has(id)) {
      // 播放器卡退场意味着 media.playing 变 false，声音得跟着停
      if (node.classList.contains('tpl-media')) player.stop()
      node.remove(); cardNodes.delete(id)
    }
  }

  const ov = $('overlay')
  if (deskState.overlay) {
    ov.className = 'on'
    ov.innerHTML = `<div class="card tpl-${deskState.overlay.template}">
      <h3>${esc(deskState.overlay.title)}</h3>${cardBody(deskState.overlay)}</div>`
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
// data-s 同时打在 #stage 上：待机时桌面要往下长，占掉语音区让出来的高度
const setVoice = (s: string) => {
  $('voice').dataset.s = s
  $('stage').dataset.s = s
  $('subTag').textContent = TAG[s] ?? s
}
function setSub(text: string | null | undefined, who?: string) {
  const el = $('subText')
  if (text === null) { el.innerHTML = '<span class="cursor"></span>'; return }
  el.className = who === 'user' ? 'user' : ''
  el.textContent = text ?? ''
}

/**
 * 横幅队列。三条提示同时来时只显示一条、其余排队 —— 队列逻辑在 banner.ts（可测），
 * 这里只负责把它接到 DOM 上。
 */
const BAN_ICON: Record<string, string> = { danger: '⨯', warn: '!', info: 'i', ok: '✓' }
const banners = createBannerQueue({
  show: b => {
    const el = $('banner')
    $('bnT').textContent = b.title ?? ''
    // desc 里允许 <code> 标记错误码——这段由平台自己拼，不是模型输出
    $('bnD').innerHTML = b.text
    $('bnI').textContent = BAN_ICON[b.tone ?? 'info'] ?? 'i'
    el.className = `a-${b.tone ?? 'info'} on`
  },
  hide: () => { $('banner').classList.remove('on') },
})
setInterval(() => banners.tick(), 200)

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
    case 'banner':
      if (!m.on) { banners.clear(); break }
      banners.push({ title: m.title, text: m.desc ?? '', tone: toneOf(m.reason), ttl: m.ttl, jump: m.jump })
      break
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
