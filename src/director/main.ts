import { injectTokens } from '../design/tokens'
import { esc } from '../text'   // 卡片标题来自模型，转义走唯一实现
import { createStore } from '../core/store'
import { createRegistry } from '../tools/registry'
import { createDomainState } from '../state/domain'
import { createPrefs } from '../state/prefs'
import { recentSummary } from '../state/session'
import { createAutoplay } from '../integrations/mediaHandlers'
import { healStep } from '../cards/heal'
import { routeOf } from '../config/interactions'
import { createAmapClient } from '../integrations/amap'
import { createItunesClient } from '../integrations/itunes'
import { createRadioClient } from '../integrations/radio'
import { createNewsClient } from '../integrations/news'
import { createPexelsClient } from '../integrations/pexels'
import { createWebSearch } from '../integrations/websearch'
import { createAgent } from '../agent/runtime'
import { createOpenRouter, createOnlineChat, FALLBACK_MODELS, pickFastModels, type ModelInfo } from '../agent/llm'
import { createBus } from '../bus'
import { createDesk } from '../cards/desk'
import { createOrchestrator } from '../cards/orchestrator'
import { SIGNALS } from '../config/signals'
import { CONSTRAINTS } from '../config/constraints'
import { TOOLS } from '../config/tools'
import { CARD_TEMPLATES } from '../config/cards'
import { CARD_RULES, DATA_BUILDERS } from '../config/cardRules'
import { MAIN_AGENT } from '../../agents/main-agent/manifest'

// Token 必须运行时注入：build-single 只替换 <script>，外部 .css 在单文件版会整个丢失
injectTokens('director')

const $ = <T extends HTMLElement = HTMLElement>(id: string) => document.getElementById(id) as T

const POS = ['driver', 'passenger', 'rearLeft', 'rearRight'] as const

/* ══════════ 底层装配 ══════════ */
const store = createStore(SIGNALS, CONSTRAINTS)
const desk = createDesk()
const amapWebKey: string = (import.meta as any).env?.VITE_AMAP_WEB_KEY || ''
// 免费层只对 localhost 开放且禁止部署——新闻是唯一只在 npm run dev 下能用的能力
const newsKey: string = (import.meta as any).env?.VITE_NEWSAPI_KEY || ''
const pexelsKey: string = (import.meta as any).env?.VITE_PEXELS_KEY || ''
const amap = amapWebKey ? createAmapClient(fetch.bind(window), { webKey: amapWebKey }) : undefined
if (!amapWebKey) console.warn('未配置 VITE_AMAP_WEB_KEY，navigation.*/weather.query 会报 unavailable')
// iTunes 不需要 Key，直接装配。它走 JSONP（不支持 CORS），载入器默认用 <script> 标签
/** 领域状态仓：队列/历史/收藏（localStorage 持久化）。记忆系统的第三级 */
const state = createDomainState()
const prefs = createPrefs()
const autoplay = createAutoplay(store, state)
const registry = createRegistry(store, TOOLS, Date.now, {
  state, prefs, desk, amap, itunes: createItunesClient(), radio: createRadioClient(fetch.bind(window)),
  news: createNewsClient(fetch.bind(window), () => newsKey),
  pexels: createPexelsClient(fetch.bind(window), () => pexelsKey),
  websearch: createWebSearch(createOnlineChat(() => apiKey, () => modelId)) })

// 卡片编排器：桌面 = f(状态)。基础卡片（导航/车窗反馈）由规则驱动，模型零参与
createOrchestrator({ store, desk, rules: CARD_RULES, builders: DATA_BUILDERS, deps: { store, amap, state } }).start()

let apiKey: string = (import.meta as any).env?.VITE_OPENROUTER_KEY || ''
let modelId = ''
const llm = createOpenRouter(() => apiKey, () => modelId)
const agent = createAgent({
  manifest: MAIN_AGENT, registry, store, llm,
  desktopSummary: () => desk.summary(),
  prefsList: () => prefs.list().map(x => x.text),
  recentSummary: () => recentSummary(state),
  onTurnStart: () => desk.endTask(),
})

/* ══════════ 桌面 → 车机屏：位置由 desk 统一计算，车机屏只管画 ══════════ */
const brief = (c: any) => ({ id: c.id, template: c.template, size: c.size, kind: c.kind, urgency: c.urgency,
  row: c.row, col: c.col, rowSpan: c.rowSpan, colSpan: c.colSpan,
  title: c.data?.title ?? CARD_TEMPLATES.find(t => t.id === c.template)?.label ?? c.template, data: c.data })
function pushDesk() {
  const l = desk.layout()
  bus.send({ type: 'cards', desk: {
    cards: l.cards.map(brief),
    overlay: l.overlay ? brief(l.overlay) : undefined, free: l.free,
  } } as any)
}
/** 生成式卡的自检结果。车机屏那边量的（Node 里没有 DOM 量不了），这里只做记录 */
const canvasNotes = new Map<string, { stripped?: string[]; overflow?: boolean; bumps?: number }>()

/**
 * 卡片检查器。演示时最常被问的是「为什么这张被挤掉了」——
 * 把仲裁真正用到的每个字段摊开摆着（不是挑几个好看的），
 * 比事后翻 trace 快得多。**只读不写，不许有业务逻辑。**
 */
function renderInspector() {
  const l = desk.layout()
  const el = $('inspect')
  $('inspN').textContent = `${l.cards.length} 张`
  if (!l.cards.length) { el.innerHTML = `<div class="empty">桌面为空</div>`; return }
  el.innerHTML = l.cards.map((c: any) => {
    const ttl = typeof c.ttl === 'number' ? `${c.ttl}s` : c.ttl
    const note = canvasNotes.get(c.id)
    return `<div class="e u-${c.urgency ?? 'normal'}${c.sizeLocked ? ' locked' : ''}">
      <b>${esc(c.data?.title ?? c.template)}</b>
      <span><i>${c.template}</i> ${c.size}</span>
      <span>${c.kind} · <i>${c.urgency ?? 'normal'}</i></span>
      <span>ttl <i>${ttl}</i></span>
      <span>${c.evictable === false ? '不可挤' : '可挤'}</span>
      <span>${c.row},${c.col} +${c.rowSpan}×${c.colSpan}</span>
      ${note?.stripped?.length ? `<span class="strip">剥离 ${esc(note.stripped.join(' '))}</span>` : ''}
      ${note?.overflow ? `<span class="strip">内容溢出</span>` : ''}
    </div>`
  }).join('')
}
desk.subscribe(renderInspector)
renderInspector()

desk.subscribe(pushDesk)
// diff 高亮：同槽数据真变了（北京刷进成都那张天气卡）让屏幕闪一下。
// desk 只报事实（哪张卡变了），闪不闪、闪多久是屏幕的事
// 150ms 合并去抖：起播要连写六个信号，每写一次都 diff 出变化，
// 不合并的话一次换曲发六条 highlight，屏幕闪成一串
const hlPending = new Map<string, ReturnType<typeof setTimeout>>()
desk.onDataChange(id => {
  if (hlPending.has(id)) return
  hlPending.set(id, setTimeout(() => {
    hlPending.delete(id)
    bus.send({ type: 'highlight', ids: [], cards: [id] } as any)
  }, 150))
})
// 卡片被挤出必须告诉用户 —— 静默消失不可接受。走横幅而不是塞一张卡：
// 「我把天气收起来了」是对刚才那个动作的解释，不是内容
desk.onNotice(n => bus.send({
  type: 'banner', on: true, reason: 'evicted', title: '腾了个位置', desc: n.note, ttl: 5000,
}))
setInterval(() => desk.tick(), 500)

$('toolCount').textContent = `${registry.list(MAIN_AGENT.tools).length} tools`

/* ══════════ 跨窗口 ══════════ */
// 车机屏每 4 秒发一次 hello。它可能是聊到一半才打开、也可能是中途刷新的，
// 那时候桌面上早有卡了——只点亮连接灯不够，得把当前状态整个补推过去。
// 每次都推而不是只在首次推：刷新后控制面板这边并不知道对面换了个新页面。
// 代价是 4 秒一次小 postMessage，车机屏那边按节点 diff，不会闪
const bus = createBus(m => {
  // ended → 机制自动续播，零模型调用（公理 4）。写的是信号，
  // 规则会自己刷新播放器卡——桌面 = f(状态) 的又一次兑现
  if (m.type === 'mediaEvent' && m.event === 'ended') {
    autoplay.onEnded()
    log('p', store.get('media.playing') ? `放完了，自动下一首：${store.get('media.track')}` : '队列放完了')
    return
  }
  if (m.type === 'canvasNote') {
    const prev = canvasNotes.get(m.cardId) ?? { bumps: 0 }
    const note = {
      stripped: m.stripped ?? prev.stripped,
      overflow: m.overflow ?? prev.overflow,
      bumps: prev.bumps ?? 0,
    }
    canvasNotes.set(m.cardId, note)
    if (m.stripped?.length) log('r', `生成式卡剥离 ${m.stripped.join(' ')}`)
    // 尺寸自愈闭环（机制，零模型）：实测内容高度 → 升降档，≤2 次防振荡
    if (typeof m.contentPx === 'number') {
      const card = desk.get(m.cardId)
      if (card) {
        const next = healStep(card.size, m.contentPx, { bumps: note.bumps, sizeLocked: card.sizeLocked })
        if (next) {
          const r = desk.resize(m.cardId, next as any, false)
          if (r.status === 'ok') { note.bumps++; log('p', `生成式卡自适应：${card.size} → ${next}`) }
        }
      }
    }
    if (m.overflow) log('e', '生成式卡内容溢出，超出部分用户看不到')
    renderInspector()
    return
  }
  /**
   * 用户在屏上的动作 → 按**交互声明**分三类路由（全部已拍板）：
   *   answer 合成用户输入进对话（点第 2 项 = 说"第二个"，语音触控可混用）
   *   tool   直调，不叫醒模型（按暂停等 LLM 转一圈是灾难）
   *   desk   桌面管理，记入意愿层（滑掉的卡规则不许诈尸）
   * 声明查不到 → 丢弃，不瞎猜。
   */
  if (m.type === 'userAction') {
    const card = desk.get(m.cardId)
    if (!card) return
    const decl = routeOf(card.template, m.act)
    if (!decl) return
    if (decl.route === 'desk') {
      desk.dismiss(m.cardId, { byUser: true })
      log('u', `[屏幕] 划走了「${card.data?.title ?? card.template}」`)
    } else if (decl.route === 'tool') {
      log('u', `[屏幕] ${m.act} → ${decl.tool}`)
      registry.invoke(decl.tool!, (decl.args ?? {}) as any).then(r => {
        if (r.status !== 'ok') log('r', `${decl.tool}: ${r.message ?? r.code}`)
      })
    } else {
      const said = `（用户在屏幕上点选）${m.value ?? m.act}`
      log('u', `[屏幕] ${said}`)
      ask(said)
    }
    return
  }
  if (m.type !== 'hello') return
  setConn(true)
  pushDesk(); push()
})
const setConn = (ok: boolean) => {
  $('dot').classList.toggle('on', ok)
  $('connTxt').textContent = ok ? '车机屏已连接' : '车机屏未连接'
}
$('openScreen').onclick = () => {
  const w = open(new URL('screen.html', location.href).href, 'cockpitScreen', 'width=1440,height=880')
  bus.setPeer(w)
  log('p', '已打开车机屏 · 拖到外接屏后按 F 全屏')
}

function push() {
  const target: Record<string, number> = {}
  for (const k of POS) target[k] = store.getTarget(`cabin.window.${k}.position`) as number
  bus.send({
    type: 'state', target,
    meta: {
      speed: store.get('vehicle.speed'), childLock: store.get('cabin.childLock'),
      weather: store.get('env.weather'), outTemp: store.get('cabin.temperature.outside'),
      soc: store.get('powertrain.soc'),
    },
  })
  for (const k of POS) $(`m-${k}`).textContent = String(Math.round(store.getTarget(`cabin.window.${k}.position`) as number))
  const v = store.checkInvariants()
  $('invar').innerHTML = v.length
    ? `<span style="color:#FF5C5C">⚠ 不变量违规：${v.join('；')}</span>`
    : '状态不变量：正常'
}
setInterval(() => { store.tick(200); push() }, 200)
pushDesk()

/* ══════════ 追踪面板 ══════════ */
const traceEl = $('trace')
function log(cls: string, text: string) {
  const div = document.createElement('div')
  div.className = cls; div.textContent = text
  traceEl.appendChild(div); traceEl.scrollTop = traceEl.scrollHeight
}
$('clr').onclick = () => (traceEl.innerHTML = '')
$('resetSess').onclick = () => { agent.reset(); log('p', '── 会话已重置 ──') }

/* ══════════ Agent 事件 → 车机屏 ══════════ */
agent.on(e => {
  switch (e.type) {
    case 'thinking':
      bus.send({ type: 'voice', s: 'thinking', text: null }); break
    case 'executing':
      bus.send({ type: 'voice', s: 'executing' }); break
    case 'speaking':
      bus.send({ type: 'voice', s: 'speaking', text: e.text, who: 'agent' }); break
    case 'confirming':
      bus.send({ type: 'voice', s: 'confirming', text: e.text, who: 'agent' })
      bus.send({ type: 'card', action: 'show', id: 'confirm', title: '需要确认', body: e.text })
      break
    case 'rejected':
      bus.send({ type: 'voice', s: 'rejected' })
      bus.send({ type: 'banner', on: true, reason: 'rejected', title: '已拒绝执行', desc: e.text, ttl: 6000 })
      break
    case 'done':
      setTimeout(() => bus.send({ type: 'voice', s: 'idle', text: '' }), 3000); break
    case 'error':
      log('e', '✗ ' + e.message)
      bus.send({ type: 'voice', s: 'rejected', text: '出错了：' + e.message, who: 'agent' })
      break
  }
})

/* ══════════ 发起一轮对话 ══════════ */
let busy = false
async function ask(text: string) {
  if (busy) return
  if (!apiKey) { log('e', '✗ 请先填入 OpenRouter API Key'); return }
  if (!modelId) { log('e', '✗ 请先选择模型'); return }
  busy = true; $('busy').textContent = '思考中…'
  bus.send({ type: 'banner', on: false })
  bus.send({ type: 'card', action: 'dismiss', id: 'confirm' })
  bus.send({ type: 'voice', s: 'listening', text, who: 'user' })
  log('u', `\n▸ ${text}`)

  const t0 = performance.now()
  const r = await agent.run(text)

  for (const s of r.trace) {
    if (s.type === 'prompt') log('p', `  · 注入 ${s.system.length} 字符 / ${s.toolCount} 个工具`)
    if (s.type === 'toolCall') log('t', `  → ${s.name}(${JSON.stringify(s.args)})  [${s.permission}]`)
    if (s.type === 'toolResult') {
      const res: any = s.result
      const cls = res.status === 'ok' ? 'k' : res.status === 'inputRequired' ? 'r' : res.status === 'failed' ? 'e' : 'r'
      log(cls, `  ← ${res.status}${res.code ? ' · ' + res.code : ''}${res.message ? ' · ' + res.message : ''}  (${s.ms}ms)`)
      if (res.status === 'ok' && res.changed?.length) {
        const ids = res.changed
          .filter((p: string) => p.startsWith('cabin.window.'))
          .map((p: string) => p.split('.')[2])
        if (ids.length) bus.send({ type: 'highlight', ids })
        if (res.code === 'SPEED_LIMITED') bus.send({ type: 'banner', on: true, reason: 'constraint', title: '已限位', desc: `${res.message} · <code>${res.code}</code>`, ttl: 6000 })
        const cid = (res.data as any)?.cardId
        if (cid) bus.send({ type: 'highlight', ids: [], cards: [cid] } as any)
      }
    }
  }
  log('a', `  ⟵ ${r.reply || '(无话术)'}`)
  log('p', `  ${r.rounds} 轮 · ${Math.round(performance.now() - t0)}ms · ${r.stopReason}`)
  push()
  busy = false; $('busy').textContent = ''
}

$('send').onclick = () => { const v = $<HTMLInputElement>('say').value.trim(); if (v) { $<HTMLInputElement>('say').value = ''; ask(v) } }
$<HTMLInputElement>('say').onkeydown = e => { if (e.key === 'Enter') $('send').click() }

/* ══════════ 车辆状态控件 ══════════ */
const setSpeed = (v: number) => { store.setDirect('vehicle.speed', v); $<HTMLInputElement>('spd').value = String(v); $('spdV').textContent = `${v} km/h`; push() }
const setSrc = (v: string) => { store.setDirect('perception.voiceSource', v); $<HTMLSelectElement>('vsrc').value = v }
const setLock = (v: boolean) => { store.setDirect('cabin.childLock', v); const b = $('bLock'); b.textContent = '儿童锁 ' + (v ? '开' : '关'); b.classList.toggle('on', v); push() }
const setRain = (v: boolean) => { store.setDirect('env.weather', v ? 'rain' : 'cloudy'); const b = $('bRain'); b.textContent = '天气 ' + (v ? '小雨' : '多云'); b.classList.toggle('on', v); push() }

$<HTMLInputElement>('spd').oninput = e => setSpeed(Number((e.target as HTMLInputElement).value))
$<HTMLInputElement>('tmp').oninput = e => { const v = Number((e.target as HTMLInputElement).value); store.setDirect('cabin.temperature.outside', v); $('tmpV').textContent = `${v} °C`; push() }
$<HTMLInputElement>('soc').oninput = e => { const v = Number((e.target as HTMLInputElement).value); store.setDirect('powertrain.soc', v); $('socV').textContent = `${v} %`; push() }
$<HTMLSelectElement>('vsrc').onchange = e => setSrc((e.target as HTMLSelectElement).value)
$('bLock').onclick = () => setLock(!store.get('cabin.childLock'))
$('bRain').onclick = () => setRain(store.get('env.weather') !== 'rain')
const CITY_KEY = 'cockpit-sim:city'
const citySelect = $<HTMLSelectElement>('city')
const setCity = (value: string, announce: boolean) => {
  citySelect.value = value
  store.setDirect('vehicle.location', value)
  if (announce) log('p', `当前城市 → ${citySelect.selectedOptions[0].textContent}`)
}
citySelect.onchange = e => {
  const v = (e.target as HTMLSelectElement).value
  localStorage.setItem(CITY_KEY, v)
  setCity(v, true)
}
// 刷新页面后记住上次选的城市——不然默认回北京，演示场景在别的城市就会出现离谱的导航距离
const savedCity = localStorage.getItem(CITY_KEY)
if (savedCity) setCity(savedCity, false)

const SCENES: Record<string, () => void> = {
  park: () => { setSpeed(0); setRain(false); setLock(false) },
  highway: () => { setSpeed(120); setRain(false); setLock(false) },
  rain: () => { setSpeed(45); setRain(true); setLock(false) },
  kids: () => { setSpeed(30); setRain(false); setLock(true) },
}
document.querySelectorAll('[data-sc]').forEach(b => (b as HTMLElement).onclick = () => {
  SCENES[(b as HTMLElement).dataset.sc!]()
  log('p', `场景切换 → ${(b as HTMLElement).textContent}`)
})

/* ══════════ 模型选择 ══════════ */
let allModels: ModelInfo[] = []
let fastOnly = true
/** 默认选中的模型——便宜模型工具调用纪律差（会瞎重复调 Tool），这个稳一些 */
const DEFAULT_MODEL_ID = 'minimax/minimax-m3'

function renderModels() {
  const list = fastOnly
    ? pickFastModels(allModels)
    : allModels.slice().sort((a, b) => (a.promptPrice ?? 0) - (b.promptPrice ?? 0))
  const sel = $<HTMLSelectElement>('model')
  sel.innerHTML = list.map(m =>
    `<option value="${m.id}">${m.name}${m.promptPrice ? `　·　$${(m.promptPrice * 1e6).toFixed(2)}/M` : ''}</option>`).join('')
  $('modelCount').textContent = `${list.length} / ${allModels.length}`
  if (list.length) {
    modelId = list.find(m => m.id === DEFAULT_MODEL_ID)?.id ?? list[0].id
    sel.value = modelId
  }
}
$<HTMLSelectElement>('model').onchange = e => { modelId = (e.target as HTMLSelectElement).value; log('p', `模型切换 → ${modelId}`) }
$('fastOnly').onclick = () => { fastOnly = !fastOnly; $('fastOnly').classList.toggle('on', fastOnly); renderModels() }

async function loadModels() {
  if (!apiKey) { allModels = FALLBACK_MODELS; renderModels(); return }
  try {
    allModels = await llm.models()
    log('k', `✓ 已加载 ${allModels.length} 个支持 function calling 的模型`)
  } catch (err) {
    allModels = FALLBACK_MODELS
    log('e', `✗ 模型列表拉取失败，使用兜底列表：${err}`)
  }
  renderModels()
}
$('reload').onclick = loadModels
$<HTMLInputElement>('key').oninput = e => { apiKey = (e.target as HTMLInputElement).value.trim() }
$<HTMLInputElement>('key').onchange = loadModels

if (apiKey) { $<HTMLInputElement>('key').value = apiKey }
loadModels()
push()
log('p', '控制面板就绪 · 先「打开车机屏」，选好模型后即可对话')
