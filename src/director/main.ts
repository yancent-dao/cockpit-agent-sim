import { injectTokens } from '../design/tokens'
import { esc } from '../text'   // 卡片标题来自模型，转义走唯一实现
import { createStore } from '../core/store'
import { createRegistry } from '../tools/registry'
import { createDomainState } from '../state/domain'
import { createPrefs } from '../state/prefs'
import { recentSummary } from '../state/session'
import { createAutoplay } from '../integrations/mediaHandlers'
import { healStep } from '../cards/heal'
import { titleOf } from '../cards/summary'   // 标题兜底的唯一实现（空串也要退回模板名）
import { routeOf } from '../config/interactions'
import { yieldsTo, type Writer } from './election'
import { createAmapClient } from '../integrations/amap'
import { createItunesClient } from '../integrations/itunes'
import { createRadioClient } from '../integrations/radio'
import { createNewsClient } from '../integrations/news'
import { createPexelsClient } from '../integrations/pexels'
import { createWebSearch } from '../integrations/websearch'
import { createPipeline } from '../agent/pipeline'
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
import { FAST_AGENT } from '../../agents/main-agent/fast'
import { SKILLS } from '../../agents/main-agent/skills'

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
/** 本面板的写者身份。多面板并存时新开的接管，旧的让位（election.ts） */
const ME: Writer = { src: Math.random().toString(36).slice(2, 10), boot: Date.now() }
let muted = false

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
let fastModelId = ''
const llm = createOpenRouter(() => apiKey, () => modelId)
// 快层用自己的（更便宜更快的）模型；没选就跟慢层同一个——功能不断，只是不快
const fastLlm = createOpenRouter(() => apiKey, () => fastModelId || modelId)
const LASTTIME_KEY = 'cockpit-sim:lastTime'
const pipeline = createPipeline({
  registry, store, fastLlm, slowLlm: llm,
  fastManifest: FAST_AGENT, slowManifest: { ...MAIN_AGENT, skills: SKILLS },
  desktopSummary: () => desk.summary(),
  prefsList: () => prefs.list().map(x => x.text),
  recentSummary: () => recentSummary(state),
  onTurnStart: () => desk.endTask(),
  memory: { load: () => localStorage.getItem(LASTTIME_KEY), save: t => localStorage.setItem(LASTTIME_KEY, t) },
})

/* ══════════ 桌面 → 车机屏：位置由 desk 统一计算，车机屏只管画 ══════════ */
const brief = (c: any) => ({ id: c.id, template: c.template, size: c.size, kind: c.kind, urgency: c.urgency,
  row: c.row, col: c.col, rowSpan: c.rowSpan, colSpan: c.colSpan,
  // 右上角缩放按钮该不该置灰——desk 是唯一权威（模板允许的尺寸表 + minSize +
  // 紧急度下限），车机屏不重算一遍
  canShrink: desk.canStep(c.id, 'down'), canGrow: desk.canStep(c.id, 'up'),
  title: titleOf(c), data: c.data })
function pushDesk() {
  if (muted) return   // 让位期间不写屏——两个面板轮流推就是"整屏两秒一闪"的根
  const l = desk.layout()
  bus.send({ type: 'cards', src: ME.src, boot: ME.boot, desk: {
    cards: l.cards.map(brief),
    overlay: l.overlay ? brief(l.overlay) : undefined, free: l.free,
    // 台下排队（等位区）：车机屏只要 数量 + 名字 就能画边缘条，几何不发
    staged: l.staged.map((c: any) => ({ id: c.id, template: c.template, title: titleOf(c) })),
  } } as any)
}

/**
 * 台下清单卡：机制按 desk.layout().staged 生成（模型零参与）。
 * 名单是活的——台下有卡上台/淘汰时开着的清单要跟着变，空了自己退场。
 */
function renderStagedList(openIt = false) {
  const open = desk.findByKey('stagedlist')
  if (!open && !openIt) return
  const l = desk.layout()
  const items = l.staged.map((c: any) => ({
    label: titleOf(c), sub: CARD_TEMPLATES.find(t => t.id === c.template)?.label, value: c.id,
  }))
  if (!items.length) { if (open) desk.dismiss(open.id); return }
  // 名单没变就不动——update() 无条件 emit，订阅里不设这道闸会自己触发自己
  if (open && JSON.stringify(open.data?.items) === JSON.stringify(items)) return
  // urgent：用户点名要看的清单不能自己也进等位区（台下清单排队进台下是笑话），
  // urgent 档不可挤且压得过 normal 卡，一定进得来
  desk.render({ key: 'stagedlist', template: 'stagedlist', size: '1/3', kind: 'system',
    urgency: 'urgent', ttl: 'untilTaskEnd', data: { title: '还在后台的内容', items } })
}
desk.subscribe(() => renderStagedList())
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
  // 单写者选举：收到**另一个面板**的桌面推送且它更晚启动 → 我让位静默。
  // 用户在本面板一开口（ask）就夺回
  if ((m as any).type === 'cards' && (m as any).src && yieldsTo(ME, { src: (m as any).src, boot: (m as any).boot ?? 0 })) {
    if (!muted) { muted = true; log('r', '检测到另一个控制面板在写屏，本面板已让位（在这里说句话即可接管）') }
    return
  }
  /**
   * 让位期间不执行任何来自屏幕的副作用。
   *
   * muted 以前只闸住 pushDesk/push（写屏），而 mediaEvent / userAction /
   * canvasNote / 各种芯片开关照常处理——两个控制面板并存时（选举机制存在的
   * 前提场景）一次屏幕点击被两个面板各执行一遍：media.control 调两次
   * 一次点击跳两首歌，autoplay 双进、history 往共享的 localStorage 里
   * 写重复条目，让位面板的 store/desk 还在背地里持续演化并与真相分叉。
   * hello 例外——那是连接握手，pushDesk/push 自己会看 muted。
   */
  if (muted && (m as any).type !== 'hello') return
  // ended → 机制自动续播，零模型调用（公理 4）。写的是信号，
  // 规则会自己刷新播放器卡——桌面 = f(状态) 的又一次兑现
  if (m.type === 'mediaEvent' && m.event === 'ended') {
    autoplay.onEnded()
    log('p', store.get('media.playing') ? `放完了，自动下一首：${store.get('media.track')}` : '队列放完了')
    return
  }
  /**
   * 放不出来（流 404 / 中途断流 / 被自动播放策略拦下）。
   *
   * 以前这三种事实全被下面那句 `if (m.type !== 'hello') return` 静默吞掉：
   * playing 一直挂在 true，播放器卡显示"播放中"、Agent 也以为在放歌，
   * 用户却只听到寂静。现在落到信号上，规则会自己收掉播放器卡。
   * blocked 是"还没解锁"不是"坏了"，车机屏那边已有引导横幅，这里只同步状态。
   */
  if (m.type === 'mediaEvent' && (m.event === 'error' || m.event === 'blocked')) {
    autoplay.onError()
    if (m.event === 'error') {
      log('e', `放不出来：${store.get('media.track') || '当前内容'}${m.detail ? ' · ' + m.detail : ''}`)
      bus.send({ type: 'banner', on: true, reason: 'rejected', title: '这个放不出来',
        desc: '换一个试试，或者说"下一首"', ttl: 6000 })
    }
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
        const next = healStep(card.size, m.contentPx, { bumps: note.bumps, sizeLocked: card.sizeLocked, template: card.template })
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
      // 右上角缩放按钮跟滑撤同一条路由（桌面管理，不叫醒模型），按 op 分派：
      // dismiss 走既有的划走逻辑，shrink/grow 直调 desk.step —— 到头了
      // 静默不动就行（按钮下一次该自己置灰），不用横幅打扰
      if (decl.op === 'shrink' || decl.op === 'grow') {
        const r = desk.step(m.cardId, decl.op === 'shrink' ? 'down' : 'up')
        // 放不下要说一声。desk 现在会如实返回 NO_ROOM 而不是假装 ok，
        // 但用户看到的仍然是"点了没反应"——除非我们把原因摆出来
        if (r.status === 'rejected' && r.code === 'NO_ROOM')
          bus.send({ type: 'banner', on: true, reason: 'constraint', title: '放不下',
            desc: r.message ?? '先收起一张卡再试', ttl: 4000 })
      } else {
        desk.dismiss(m.cardId, { byUser: true })
        log('u', `[屏幕] 划走了「${card.data?.title ?? card.template}」`)
      }
    } else if (decl.route === 'tool') {
      log('u', `[屏幕] ${m.act} → ${decl.tool}`)
      // valueParam：条目携带的 value 填进参数（台下清单点某项 → focus 那张卡）
      const args = { ...(decl.args ?? {}), ...(decl.valueParam && m.value ? { [decl.valueParam]: m.value } : {}) }
      registry.invoke(decl.tool!, args as any).then(r => {
        if (r.status !== 'ok') log('r', `${decl.tool}: ${r.message ?? r.code}`)
      })
    } else {
      const said = `（用户在屏幕上点选）${m.value ?? m.act}`
      log('u', `[屏幕] ${said}`)
      ask(said)
    }
    return
  }
  // 覆盖层 ✕：窗口管理直调，不叫醒模型（关掉盖在脸上的东西没有理解成分）
  if ((m as any).type === 'overlayClose') {
    desk.dismiss((m as any).cardId, { byUser: true })
    log('u', '[屏幕] 关掉了覆盖层')
    return
  }
  // 边缘条同样是开关：开着再点收回
  if ((m as any).type === 'stagedChip') {
    const open = desk.findByKey('stagedlist')
    if (open) desk.dismiss(open.id, { byUser: true })
    else renderStagedList(true)
    return
  }
  // 芯片是开关：开着再点就收回（实拍：展开后没法收）
  if ((m as any).type === 'taskChip') {
    const open = desk.findByKey('bgtasks')
    if (open) desk.dismiss(open.id, { byUser: true })
    else renderBgTasks(true)
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
  if (muted) return
  const target: Record<string, number> = {}
  for (const k of POS) target[k] = store.getTarget(`cabin.window.${k}.position`) as number
  bus.send({
    type: 'state', target,
    meta: {
      speed: store.get('vehicle.speed'), childLock: store.get('cabin.childLock'),
      weather: store.get('env.weather'), outTemp: store.get('cabin.temperature.outside'),
      soc: store.get('powertrain.soc'), gear: store.get('vehicle.gear'),
      tasks: pipeline.tasks().map(t => ({ id: t.id, label: t.label, status: t.status, current: t.current })),
    },
  })
  for (const k of POS) $(`m-${k}`).textContent = String(Math.round(store.getTarget(`cabin.window.${k}.position`) as number))
  // 门/舱口按钮兼作状态灯：Agent 开的门（door.set）也要亮，所以从 store 回读
  document.querySelectorAll<HTMLElement>('[data-door]').forEach(b =>
    b.classList.toggle('on', store.get(b.dataset.door!) === true))
  renderSnap()
  const v = store.checkInvariants()
  $('invar').innerHTML = v.length
    ? `<span style="color:#FF5C5C">⚠ 不变量违规：${v.join('；')}</span>`
    : '状态不变量：正常'
}

/* ══════════ 实时信号快照（只读） ══════════
   Agent 改了什么这里立刻能看到——演示时不用翻 trace 猜"到底调没调成"。
   行定义是数据：别名→格式化，一个 if 业务判断都没有 */
const lblOf = (alias: string) => {
  const s = SIGNALS.find(x => x.alias === alias)
  const v = store.get(alias)
  return String((s?.valueLabels as any)?.[v as any] ?? v)
}
const SNAP: Array<[string, () => string | null]> = [
  ['空调', () => store.get('cabin.climate.power')
    ? `${store.get('cabin.climate.targetTemp')}°C · ${store.get('cabin.climate.fanSpeed')}档 · ${lblOf('cabin.climate.airflow')}` : null],
  ['主驾座椅', () => {
    const h = Number(store.get('seat.driver.heating') ?? 0), vt = Number(store.get('seat.driver.ventilation') ?? 0)
    return h || vt ? [h ? `加热${h}档` : '', vt ? `通风${vt}档` : ''].filter(Boolean).join(' · ') : null
  }],
  ['方向盘加热', () => store.get('cabin.steeringWheel.heating') ? '开' : null],
  ['天窗', () => { const p = Number(store.get('cabin.sunroof.glass.position') ?? 0); return p ? `开 ${Math.round(p)}%` : null }],
  ['氛围灯', () => store.get('cabin.ambientLight.power')
    ? `${lblOf('cabin.ambientLight.color')} · ${store.get('cabin.ambientLight.brightness')}%` : null],
  ['香氛', () => store.get('cabin.fragrance.power') ? lblOf('cabin.fragrance.scent') : null],
  ['雨刷', () => store.get('cabin.wiper.mode') !== 'off' ? lblOf('cabin.wiper.mode') : null],
  ['驾驶模式', () => lblOf('vehicle.driveMode')],
  ['媒体', () => {
    const src = store.get('media.source')
    if (!src || src === 'none') return null
    return `${store.get('media.track') || lblOf('media.source')} ${store.get('media.playing') ? '▶' : '⏸'} · 音量${store.get('media.volume')}`
  }],
  ['导航', () => store.get('navigation.active')
    ? `${store.get('navigation.destination')} · ${store.get('navigation.eta')}分钟 · ${store.get('navigation.distanceRemaining')}km` : null],
]
const snapEl = $('snap')
snapEl.innerHTML = SNAP.map(([k]) => `<div><span>${k}</span><b class="dim">—</b></div>`).join('')
const snapVals = Array.from(snapEl.querySelectorAll('b'))
function renderSnap() {
  SNAP.forEach(([, fn], i) => {
    let v: string | null = null
    try { v = fn() } catch { /* 信号没配全时快照行降级成 —，不许把面板整个炸了 */ }
    const b = snapVals[i], txt = v ?? '—'
    if (b.textContent !== txt) { b.textContent = txt; b.classList.toggle('dim', v === null) }
  })
}
setInterval(() => { store.tick(200); push() }, 200)
pushDesk()
// 调试句柄：控制面板本来就是调试/演示面板，控制台里能直接戳机制层
// （无业务逻辑，只是把已有对象挂出来）
;(window as any).__sim = { desk, registry, store }

/**
 * 任务进展卡（§6.2）：Claude 式步骤流——✓ 已完成（带耗时）/ ⟳ 进行中。
 * 点任务芯片打开；开着时 taskUpdate 事件 live 刷新；全部翻篇自动撤。
 * 复用 list 模板，零新模板。
 */
function renderBgTasks(force = false) {
  if (!force && !desk.findByKey('bgtasks')) return
  const ST: Record<string, string> = { done: '✓ 完成', failed: '✗ 没成', cancelled: '— 已取消' }
  const ts = pipeline.tasks()
  if (!ts.length) return
  const items: Array<{ label: string; sub?: string }> = []
  for (const t of [...ts].sort(a => (a.status === 'running' ? -1 : 1))) {
    items.push({ label: `【${t.label}】`, sub: t.status === 'running' ? '进行中' : ST[t.status] })
    for (const st of t.steps) {
      const done = st.ms !== undefined || t.status !== 'running'
      items.push({
        label: `${done ? '✓' : '⟳'} ${st.label}`,
        sub: st.ms !== undefined ? `${(st.ms / 1000).toFixed(1)}s` : (done ? '' : '…'),
      })
    }
  }
  // urgent：用户点名要看的进展卡不能被后续任意一次常规重刷挤走——
  // 之前它是 normal 优先级，桌面满时随便一张同级卡重新断言就会把它挤进等位区，
  // 用户看到的就是"点开闪一下就没了"（它自己没消失，是被别的卡顶下去了）
  desk.render({ key: 'bgtasks', template: 'list', kind: 'system', urgency: 'urgent', ttl: 120, refreshTtl: true,
    data: { title: '后台任务进展', items } })
}

/* ══════════ 追踪面板 ══════════ */
const traceEl = $('trace')
function log(cls: string, text: string) {
  const div = document.createElement('div')
  div.className = cls; div.textContent = text
  traceEl.appendChild(div); traceEl.scrollTop = traceEl.scrollHeight
}
$('clr').onclick = () => (traceEl.innerHTML = '')
/**
 * 跨会话记忆的可见化 + 一键清除。
 *
 * 实拍事故：用户开机第一句是"打开车窗、打开空调、你有哪些功能"，三件事一件没做，
 * Agent 接着上个会话的话头问"你要去哪个充电站"——上回的压缩摘要一直躺在
 * localStorage 里，页面一加载就被塞进 thread，而界面上没有任何地方说这件事。
 */
function renderMemNote() {
  const el = $('memNote')
  const on = pipeline.hasLastTime()
  el.style.display = on ? '' : 'none'
  if (on) el.textContent = '带着上回的记忆（会影响这次的回答，点「忘掉上回」清掉）'
  $('forgetMem').toggleAttribute('disabled', !on)
}
$('forgetMem').onclick = () => {
  pipeline.forgetLastTime()
  renderMemNote()
  log('p', '── 已忘掉上回的记忆 ──')
}
$('resetSess').onclick = () => {
  pipeline.reset()          // 连跨会话那行一起清，不然刷新后它又回来了
  renderMemNote()
  log('p', '── 会话已重置（含上回的记忆）──')
}
renderMemNote()

/* ══════════ Pipeline 事件 → 车机屏 ══════════ */
// 后台任务交付排队：语音正忙（在播报）就压着，idle 再放——通知不打断对话（§6.1）
let voiceBusy = false
const deliveries: Array<() => void> = []
const flushDeliveries = () => { while (!voiceBusy && deliveries.length) deliveries.shift()!() }
pipeline.on(e => {
  switch (e.type) {
    case 'thinking':
      bus.send({ type: 'voice', s: 'thinking', text: null }); break
    case 'executing':
      bus.send({ type: 'voice', s: 'executing' }); break
    case 'speaking':
      voiceBusy = true
      bus.send({ type: 'voice', s: 'speaking', text: e.text, who: 'agent' }); break
    case 'confirming':
      bus.send({ type: 'voice', s: 'confirming', text: e.text, who: 'agent' })
      break
    case 'rejected':
      bus.send({ type: 'voice', s: 'rejected' })
      bus.send({ type: 'banner', on: true, reason: 'rejected', title: '已拒绝执行', desc: e.text, ttl: 6000 })
      break
    // 旧 turn 的慢层迟到话术：不抢麦，走横幅（§4.1）
    case 'lateNote':
      log('a', `  ⟵(补) ${e.text}`)
      bus.send({ type: 'banner', on: true, reason: 'late', title: '补一句', desc: e.text, ttl: 6000 })
      break
    case 'taskUpdate': {
      push()
      renderBgTasks()          // 进展卡开着就 live 刷新
      // 全部翻篇 → 进展卡按"这件事翻篇"退场（交付卡随 taskDone 自己上）
      if (pipeline.tasks().length && pipeline.tasks().every(t => t.status !== 'running')) {
        const c = desk.findByKey('bgtasks')
        if (c) desk.dismiss(c.id)
      }
      break
    }
    case 'taskDone':
      log(e.ok ? 'k' : 'e', `后台任务${e.ok ? '完成' : '没成'}：${e.summary.slice(0, 60)}`)
      deliveries.push(() => {
        // 机械交付：子 Agent 的 summary 播报 + 横幅。卡片它自己建过了，这里不代劳
        bus.send({ type: 'voice', s: 'speaking', text: e.summary, who: 'agent' })
        bus.send({ type: 'banner', on: true, reason: e.ok ? 'task' : 'taskFail',
          title: e.ok ? '后台任务完成' : '后台任务没成', desc: e.summary.slice(0, 80), ttl: 8000 })
        setTimeout(() => bus.send({ type: 'voice', s: 'idle', text: '' }), 3000)
        push()
      })
      flushDeliveries()
      break
    case 'done':
      setTimeout(() => { voiceBusy = false; bus.send({ type: 'voice', s: 'idle', text: '' }); flushDeliveries() }, 3000)
      break
    case 'error':
      log('e', '✗ ' + e.message)
      bus.send({ type: 'voice', s: 'rejected', text: '出错了：' + e.message, who: 'agent' })
      break
  }
})

/* ══════════ 发起一轮对话 ══════════ */
async function ask(text: string) {
  // 夺回写权：用户在这个面板开口 = 要用它
  if (muted) { muted = false; ME.boot = Date.now(); log('p', '本面板已接管写屏'); pushDesk(); push() }
  // 不设 busy 闸：barge-in 是常态，世代戳在 pipeline 里管（§4.1）
  if (!apiKey) { log('e', '✗ 请先填入 OpenRouter API Key'); return }
  if (!modelId) { log('e', '✗ 请先选择模型'); return }
  $('busy').textContent = '思考中…'
  bus.send({ type: 'banner', on: false })
  bus.send({ type: 'voice', s: 'listening', text, who: 'user' })
  log('u', `\n▸ ${text}`)

  const t0 = performance.now()
  const r = await pipeline.run(text)

  let rn = 0
  for (const s of r.trace) {
    // 分层流水：⚡快层 / 🐢慢层，每轮标 LLM 耗时——一个需求的流转一眼可读。
    // 完整 Prompt / 消息视图 / 模型原始返回打进浏览器控制台（面板放不下也不该放）
    if (s.type === 'prompt') {
      rn++
      log('p', `  ${s.layer === 'fast' ? '⚡快层' : '🐢慢层'} · LLM ${s.llmMs != null ? (s.llmMs / 1000).toFixed(1) + 's' : '?'} · 注入 ${s.system.length} 字 / ${s.toolCount} 工具`)
      console.groupCollapsed(`%c[R${rn} ${s.layer === 'fast' ? '⚡快层' : '🐢慢层'}] LLM ${((s.llmMs ?? 0) / 1000).toFixed(1)}s`, 'color:#4DA3FF')
      console.log('system:\n' + s.system)
      console.log('messages:', (s as any).view)
      console.log('reply:', (s as any).llmReply)
      console.groupEnd()
    }
    if (s.type === 'reply' && s.text) log('a', `  ⟵${s.layer === 'fast' ? '⚡' : '🐢'} ${s.text}`)
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
        if (res.code === 'SPEED_LIMITED') bus.send({ type: 'banner', on: true, reason: 'constraint', title: '已限位', desc: res.message, code: res.code, ttl: 6000 })
        const cid = (res.data as any)?.cardId
        if (cid) bus.send({ type: 'highlight', ids: [], cards: [cid] } as any)
      }
    }
  }
  if (!r.reply) log('a', '  ⟵ (无话术)')
  const firstReply = r.trace.find(s => s.type === 'reply' && (s as any).text)
  const firstMs = firstReply ? (firstReply as any).at - (r.trace[0] as any).at : null
  log('p', `  首声 ${firstMs != null ? Math.round(firstMs) + 'ms' : '—'} · 总 ${Math.round(performance.now() - t0)}ms · ${r.rounds} 轮 · ${r.stopReason}（每轮完整 Prompt/返回见浏览器控制台）`)
  push()
  $('busy').textContent = ''
}

$('send').onclick = () => { const v = $<HTMLInputElement>('say').value.trim(); if (v) { $<HTMLInputElement>('say').value = ''; ask(v) } }
$<HTMLInputElement>('say').onkeydown = e => { if (e.key === 'Enter') $('send').click() }

/* ══════════ 车辆状态控件 ══════════
   全部 setDirect：这里模拟的是**物理世界的事实**（人踩油门、人拉门、天下雨），
   约束引擎拦的是 Agent 的写入，不归它管。面板不许有业务逻辑——写信号 + 刷显示，仅此而已 */
const setSpeed = (v: number) => { store.setDirect('vehicle.speed', v); $<HTMLInputElement>('spd').value = String(v); $('spdV').textContent = `${v} km/h`; push() }
const setSrc = (v: string) => { store.setDirect('perception.voiceSource', v); $<HTMLSelectElement>('vsrc').value = v }
const setLock = (v: boolean) => { store.setDirect('cabin.childLock', v); const b = $('bLock'); b.textContent = '儿童锁 ' + (v ? '开' : '关'); b.classList.toggle('on', v); push() }
const setWeather = (v: string) => { store.setDirect('env.weather', v); $<HTMLSelectElement>('wxSel').value = v; push() }
const setGear = (g: string) => {
  store.setDirect('vehicle.gear', g)
  document.querySelectorAll<HTMLElement>('#gearSeg button').forEach(b => b.classList.toggle('on', b.dataset.g === g))
  push()
}
const setOcc = (v: boolean) => {
  store.setDirect('perception.occupancy.rearLeft', v)
  const b = $('bOcc'); b.textContent = '左后座 ' + (v ? '有人' : '无人'); b.classList.toggle('on', v); push()
}

$<HTMLInputElement>('spd').oninput = e => setSpeed(Number((e.target as HTMLInputElement).value))
$<HTMLInputElement>('tmp').oninput = e => { const v = Number((e.target as HTMLInputElement).value); store.setDirect('cabin.temperature.outside', v); $('tmpV').textContent = `${v} °C`; push() }
$<HTMLInputElement>('soc').oninput = e => { const v = Number((e.target as HTMLInputElement).value); store.setDirect('powertrain.soc', v); $('socV').textContent = `${v} %`; push() }
$<HTMLSelectElement>('vsrc').onchange = e => setSrc((e.target as HTMLSelectElement).value)
$('bLock').onclick = () => setLock(!store.get('cabin.childLock'))
$('bOcc').onclick = () => setOcc(store.get('perception.occupancy.rearLeft') !== true)
$<HTMLSelectElement>('wxSel').onchange = e => setWeather((e.target as HTMLSelectElement).value)
document.querySelectorAll<HTMLElement>('#gearSeg button').forEach(b => (b.onclick = () => setGear(b.dataset.g!)))
// 门/舱口：按钮既是开关也是状态灯——Agent 开的门（door.set）也要在这里亮起来，
// 所以每次 push 都从 store 回读，不自己记状态
document.querySelectorAll<HTMLElement>('[data-door]').forEach(b => (b.onclick = () => {
  const path = b.dataset.door!
  store.setDirect(path, store.get(path) !== true)
  push()
}))
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
  park: () => { setSpeed(0); setGear('p'); setWeather('cloudy'); setLock(false) },
  highway: () => { setSpeed(120); setGear('d'); setWeather('clear'); setLock(false) },
  rain: () => { setSpeed(45); setGear('d'); setWeather('rain'); setLock(false) },
  kids: () => { setSpeed(30); setGear('d'); setWeather('cloudy'); setLock(true); setOcc(true) },
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

/** 两层模型都是用户的选择：选过就记住（localStorage），刷新不重置；
 *  只有从没选过时才给一次初始推荐（产品点名"不要写成默认的"） */
const MODEL_KEY = 'cockpit-sim:model'
const FAST_MODEL_KEY = 'cockpit-sim:fastModel'
function renderModels() {
  const list = fastOnly
    ? pickFastModels(allModels)
    : allModels.slice().sort((a, b) => (a.promptPrice ?? 0) - (b.promptPrice ?? 0))
  const sel = $<HTMLSelectElement>('model')
  sel.innerHTML = list.map(m =>
    `<option value="${m.id}">${m.name}${m.promptPrice ? `　·　$${(m.promptPrice * 1e6).toFixed(2)}/M` : ''}</option>`).join('')
  $('modelCount').textContent = `${list.length} / ${allModels.length}`
  if (list.length) {
    const saved = localStorage.getItem(MODEL_KEY)
    modelId = (saved && list.find(m => m.id === saved)?.id)
      ?? list.find(m => m.id === DEFAULT_MODEL_ID)?.id ?? list[0].id
    sel.value = modelId
  }
  // 快层模型：只从快速档里挑
  const fastList = pickFastModels(allModels)
  const fsel = $<HTMLSelectElement>('fastModel')
  fsel.innerHTML = fastList.map(m =>
    `<option value="${m.id}">${m.name}${m.promptPrice ? `　·　$${(m.promptPrice * 1e6).toFixed(2)}/M` : ''}</option>`).join('')
  // 初始推荐序（2026-08-13 带真实工具负载 + latency 路由复测）：
  // qwen-flash 2.5-3.6s 且并行调用最准（此前 24s 是话术轮没封顶，已用 maxTokens 修掉）；
  // glm 2.5-5.7s；gemini/haiku 在该组合下走到无权 provider 报 403。
  // 用户选过就完全听用户的（localStorage）
  const FAST_PREFER = [/qwen.+flash/i, /glm.+flash/i, /gemini.+flash/i, /haiku/i]
  if (fastList.length) {
    const saved = localStorage.getItem(FAST_MODEL_KEY)
    fastModelId = (saved && fastList.find(m => m.id === saved)?.id)
      ?? (FAST_PREFER.map(re => fastList.find(m => re.test(m.id))).find(Boolean) ?? fastList[0]).id
    fsel.value = fastModelId
  }
}
$<HTMLSelectElement>('model').onchange = e => { modelId = (e.target as HTMLSelectElement).value; localStorage.setItem(MODEL_KEY, modelId); log('p', `慢层模型 → ${modelId}（已记住）`) }
$<HTMLSelectElement>('fastModel').onchange = e => { fastModelId = (e.target as HTMLSelectElement).value; localStorage.setItem(FAST_MODEL_KEY, fastModelId); log('p', `快层模型 → ${fastModelId}（已记住）`) }
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
