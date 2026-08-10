import { createBus, type BusMsg } from '../bus'

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

/* ── 桌面卡片 ── */
interface CardView { id: string; template: string; size: string; kind: string; title: string; data: any }
let deskState: { agent: CardView[]; fixed: CardView[]; overlay?: CardView; agentFree: number } =
  { agent: [], fixed: [], agentFree: 3 }
let hotCards = new Set<string>()

const WIDTH: Record<string, number> = { '1/6': 1, '1/3': 2, '1/2': 3 }
const esc = (s: any) => String(s ?? '').replace(/[&<>]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;' }[c]!))

const CAR_SVG = `<svg viewBox="0 0 520 900" preserveAspectRatio="xMidYMid meet" style="height:100%;width:100%">
  <defs><linearGradient id="bg" x1="0" y1="0" x2="1" y2="1">
    <stop offset="0" stop-color="#232B38"/><stop offset="1" stop-color="#151A23"/></linearGradient></defs>
  <rect x="60" y="30" width="400" height="840" rx="96" fill="url(#bg)" stroke="#333D4D" stroke-width="3"/>
  <path d="M118 268 L402 268 L372 196 Q260 172 148 196 Z" fill="#0E141D" stroke="#2C3644" stroke-width="2"/>
  <rect x="118" y="272" width="284" height="368" rx="34" fill="#1A212B" stroke="#2C3644" stroke-width="2"/>
  <path d="M126 644 L394 644 L366 716 Q260 738 154 716 Z" fill="#0E141D" stroke="#2C3644" stroke-width="2"/>
  <rect x="96" y="842" width="106" height="16" rx="8" fill="#7A3038"/>
  <rect x="318" y="842" width="106" height="16" rx="8" fill="#7A3038"/>
  <g id="wins"></g></svg>`

const WIN = [
  { id: 'driver', x: 104, y: 290, w: 26, h: 158 },
  { id: 'rearLeft', x: 104, y: 462, w: 26, h: 158 },
  { id: 'passenger', x: 390, y: 290, w: 26, h: 158 },
  { id: 'rearRight', x: 390, y: 462, w: 26, h: 158 },
]

/** 卡片模板渲染 —— 模板为主 + 通用卡兜底 */
function body(c: CardView): string {
  const d = c.data ?? {}
  switch (c.template) {
    case 'vehicle':
      return `<div style="flex:1;min-height:0;display:flex;align-items:center;justify-content:center">${CAR_SVG}</div>`
    case 'control':
      return (d.items ?? []).map((it: any) => `
        <div class="win${hotWindows.includes(it.key) ? ' hot' : ''}">
          <div class="top"><span>${esc(it.label)}</span><em>${Math.round(it.value)}${esc(it.unit ?? '')}</em></div>
          <div class="track"><div class="fill" style="width:${Math.round(it.value)}%"></div></div>
        </div>`).join('')
    case 'confirm':
      return `<div class="sub">${esc(d.question ?? d.text)}</div>
        <div>${(d.options ?? ['确认', '取消']).map((o: string) => `<span class="opt">${esc(o)}</span>`).join('')}</div>`
    case 'notice':
      return `<div class="sub">${esc(d.text)}</div>${d.suggestion ? `<div class="sug">${esc(d.suggestion)}</div>` : ''}`
    case 'list':
      return `<div class="sub">${(d.items ?? []).map((i: any) =>
        `<div style="margin-bottom:10px">${esc(i.label)}${i.sub ? ` <small style="opacity:.6">${esc(i.sub)}</small>` : ''}</div>`).join('')}</div>`
    case 'capability':
      return `<div class="cap">${(d.items ?? []).map((i: any) =>
        `<div class="${i.off ? 'off' : ''}">${esc(i.label)}<small>${esc(i.desc ?? '')}</small></div>`).join('')}</div>`
    default:
      return `<div class="sub">${esc(d.text ?? '')}</div>`
  }
}

function renderDesk() {
  const desk = $('desk')
  const html: string[] = []
  const rowOf = (list: CardView[], row: number, free: number) => {
    let col = 1
    for (const c of list) {
      const w = WIDTH[c.size] ?? 1
      html.push(`<div class="card tpl-${c.template} kind-${c.kind}${hotCards.has(c.id) ? ' hot' : ''}"
        style="grid-row:${row};grid-column:${col} / span ${w}">
        <h3>${esc(c.title)}</h3>${body(c)}</div>`)
      col += w
    }
    for (let i = 0; i < free; i++) html.push(`<div class="slot" style="grid-row:${row};grid-column:${col + i}"></div>`)
  }
  rowOf(deskState.agent, 1, deskState.agentFree)
  rowOf(deskState.fixed, 2, 3 - deskState.fixed.reduce((n, c) => n + (WIDTH[c.size] ?? 1), 0))
  desk.innerHTML = html.join('')

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
    for (const list of [deskState.agent, deskState.fixed])
      for (const card of list)
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
