import { injectTokens } from '../design/tokens'
import { esc } from '../text'   // 卡片标题来自模型，转义走唯一实现
import { createStore } from '../core/store'
import { createRegistry } from '../tools/registry'
import { createDomainState, defaultStorage } from '../state/domain'
import { createPrefs } from '../state/prefs'
import { createStoryStore } from '../state/story'
import { createImageClient } from '../integrations/orimage'
import { buildBookHtml, bookFileName } from '../integrations/h5book'
import { planShrink, withShrink, WEBP_Q } from '../integrations/shrink'
import { pickVoice, zhVoices } from '../screen/speech'
import { XF_VOICES, isCloudVoice, xfVcn, synthesize as xfSynthesize } from '../integrations/xftts'
import { VOLC_VOICES, isVolcVoice, volcSpeaker, volcStream } from '../integrations/volctts'
import { recentSummary } from '../state/session'
import { createAutoplay } from '../integrations/mediaHandlers'
import { healStep } from '../cards/heal'
import { titleOf } from '../cards/summary'   // 标题兜底的唯一实现（空串也要退回模板名）
import { routeOf } from '../config/interactions'
import { yieldsTo, type Writer } from './election'
import { createAmapClient } from '../integrations/amap'
import { createItunesClient } from '../integrations/itunes'
import { createStockClient } from '../integrations/qtstock'
import { createHolidayClient } from '../integrations/holiday'
import { createPoemClient } from '../integrations/poem'
import { createPodcastClient } from '../integrations/podcast'
import { createAutomationStore, type AutomationRule } from '../state/automation'
import { createAutomationEngine } from '../core/automation'
import { createMonitor } from '../core/monitor'
import { createTravelStore } from '../state/travel'
import { createTravelEngine } from '../integrations/travelHandlers'
import { createFxClient } from '../integrations/frankfurter'
import { fxSource } from '../integrations/travelSources'
import { mockSource } from '../integrations/travelMock'
import { createVideoGen } from '../integrations/orvideo'
import { createMusicGen } from '../integrations/ormusic'
import { createLrclibClient } from '../integrations/lrclib'
import { api } from '../config/upstream'
import { createRadioClient } from '../integrations/radio'
import { createNewsClient } from '../integrations/news'
import { createPexelsClient } from '../integrations/pexels'
import { createWebSearch } from '../integrations/websearch'
import { createOpenMeteoClient } from '../integrations/openmeteo'
import { createPipeline } from '../agent/pipeline'
import { createScheduler } from '../agent/scheduler'
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
/** 屏幕点选的等价触发去重窗口（R1-③） */
let lastAnswer = { said: '', at: 0 }
/** 本面板的写者身份。多面板并存时新开的接管，旧的让位（election.ts） */
const ME: Writer = { src: Math.random().toString(36).slice(2, 10), boot: Date.now() }
let muted = false

/** 领域状态仓：队列/历史/收藏（localStorage 持久化）。记忆系统的第三级 */
const state = createDomainState()
/**
 * 绘本域仓 + 图像客户端。图像走的是**同一个 OpenRouter Key** ——
 * 加一家图像服务商就要加一个 Key、一套鉴权、一份跨域风险，换不来任何东西。
 */
const story = createStoryStore(defaultStorage())
/**
 * **压缩接在出图那一刻**，不是导出那一刻（2026-08-14 真跑之后改）。
 * 原图 base64 ~580KB/张，只在导出时压的话它一路走完全程：进卡片、
 * 进 localStorage（七页 4MB，配额按 UTF-16 双字节算 —— 一本都存不下，
 * 而且写失败是静默的），每页还要把这么大的定妆照当参考图传回去。
 * 接在客户端后面，下游全都白捡。
 */
const imageGen = withShrink(createImageClient(fetch.bind(window), () => apiKey), shrinkDataUrl)

/* ── 绘本的照片来源与导出（控制面板那一小块） ── */
const $s = (id: string) => document.getElementById(id) as any
function renderStoryNote() {
  const pic = $s('heroPic'), ok = $s('heroOk'), note = $s('storyNote')
  const photo = story.photo()
  if (pic) { pic.src = photo || ''; pic.style.display = photo ? '' : 'none' }
  if (ok) ok.checked = story.consented()
  const b = story.books()[0]
  /**
   * 花了多少钱要**看得见**。图像比文本贵一个量级（实测 $0.068/张，
   * 一本 7 页约 $0.55），不显示的话跑几轮就烧掉 Key 的额度还不知道 ——
   * 跟「带着上回的记忆」同一条：看不见的状态等于没有状态。
   */
  const cents = Number(store.get('story.cents') || 0)
  const money = cents ? `　本次已花 $${(cents / 100).toFixed(2)}` : ''
  if (note) note.textContent = (b
    ? `上一本：《${b.title}》，${b.pages.length} 页`
    : (photo ? '照片就位，说「给孩子讲个故事」就能开始' : '还没有照片')) + money
}
store.subscribe('story.cents', renderStoryNote)
/**
 * 项目目录里的照片。**只在没上传过时才读** —— 上传的优先级更高，
 * 不然用户换了图刷新一下又被目录里那张顶回去。
 */
async function loadHeroFromPublic() {
  if (story.photo()) return
  for (const n of ['child.jpg', 'child.png', 'child.jpeg', 'child.webp']) {
    try {
      const r = await fetch('/hero/' + n)
      if (!r.ok) continue
      const blob = await r.blob()
      await savePhoto(await new Promise<string>(res => {
        const fr = new FileReader(); fr.onload = () => res(String(fr.result)); fr.readAsDataURL(blob)
      }))
      break
    } catch { /* 没放图就算了 */ }
  }
  renderStoryNote()
}
/**
 * 存照片前先重采样。**手机原图 3–5MB，base64 之后 6MB** ——
 * localStorage 配额（5MB，还按 UTF-16 双字节算）当场爆，而域仓的写是
 * 静默失败的：家长上传了照片，界面上什么都没发生，接着定妆报"还没有照片"。
 * 缩到长边 1280 对定妆完全够用（参考图本来也会被模型降采样）。
 */
async function savePhoto(dataUrl: string) {
  story.savePhoto(await shrinkDataUrl(dataUrl))
  renderStoryNote()
}
$s('heroFile')?.addEventListener('change', (e: any) => {
  const f = e.target.files?.[0]; if (!f) return
  const fr = new FileReader()
  fr.onload = () => void savePhoto(String(fr.result))
  fr.readAsDataURL(f)
})
$s('heroOk')?.addEventListener('change', (e: any) => {
  if (e.target.checked) story.consent(); else story.revoke()
  renderStoryNote()
})
$s('heroForget')?.addEventListener('click', () => { story.revoke(); renderStoryNote() })

/**
 * 清空全部记录（2026-08-19 用户点名：重启/刷新都删不掉定时任务这类持久化数据）。
 * 清**记录类**：自动任务、偏好、播放历史/收藏、绘本（照片/授权/成书）、
 * 上回摘要、壁纸。**保留配置类**：模型选择、TTS 音色语速、当前城市——
 * 那些是设置不是记录，清了用户还得重挑一遍。
 * 删完整页刷新：域仓/自动化引擎都在启动时装配，热清一半会留内存残影。
 */
$s('wipeAll')?.addEventListener('click', () => {
  const RECORD_KEYS = [
    'cockpit-sim:automations', 'cockpit-sim:lastTime', 'cockpit-sim:wallpaper',
    'cockpit.prefs', 'cockpit.history', 'cockpit.favorites', 'cockpit.queries',
    'cockpit-sim:story:books', 'cockpit-sim:story:cast', 'cockpit-sim:story:consent',
    'cockpit-sim:story:photo', 'cockpit-sim:story:profile',
  ]
  if (!confirm('清空全部记录？\n\n包括：自动任务、偏好、播放历史与收藏、绘本（照片/成书）、上回对话摘要、壁纸。\n模型选择、音色、城市这些设置会保留。\n\n清完页面会刷新。')) return
  for (const k of RECORD_KEYS) localStorage.removeItem(k)
  location.reload()
})

/**
 * ── 朗读音色：家长自己挑，默认女声 ──
 *
 * 音色是**系统装的**，每台机器不一样（这台 mac 上有 18 个中文音色），
 * 没得选就只能听默认那个。选择存 localStorage —— 车机屏同源读得到，
 * `storage` 事件让它立刻生效，不用给 bus 加一类消息。
 */
const VOICE_KEY = 'cockpit-sim:tts:voice'
const XF = {
  appId: String((import.meta as any).env?.VITE_XFYUN_APPID ?? ''),
  apiKey: String((import.meta as any).env?.VITE_XFYUN_API_KEY ?? ''),
  apiSecret: String((import.meta as any).env?.VITE_XFYUN_API_SECRET ?? ''),
}
const xfOk = !!(XF.appId && XF.apiKey && XF.apiSecret)
function renderVoices() {
  const sel = $s('ttsVoice'); if (!sel) return
  const list = zhVoices((speechSynthesis?.getVoices?.() ?? []) as any)
  const saved = localStorage.getItem(VOICE_KEY) || pickVoice(list as any)?.name || ''
  // 云端组永远列出来：没配 Key 就在标签上说清（看不见的能力等于没有能力）
  const cloud = `<optgroup label="云端超拟人 · 讯飞${xfOk ? '' : '（未配 Key，选了也走本机）'}">` +
    XF_VOICES.map(v => `<option value="${v.value}"${v.value === saved ? ' selected' : ''}>${v.label}</option>`).join('') +
    '</optgroup>' +
    // 豆包：Key 在 vite 代理侧注入（前端零凭据），要 dev/preview server 在跑
    `<optgroup label="云端 · 豆包（经代理，需 npm run dev）">` +
    VOLC_VOICES.map(v => `<option value="${v.value}"${v.value === saved ? ' selected' : ''}>${v.label}</option>`).join('') +
    '</optgroup>'
  const local = list.length
    ? `<optgroup label="本机音色">` + list.map(v => {
        const tag = v.female === true ? '女声' : v.female === false ? '男声' : '—'
        return `<option value="${v.name.replace(/"/g, '&quot;')}"${v.name === saved ? ' selected' : ''}>` +
          `${v.name}（${tag}·${v.lang}）</option>`
      }).join('') + '</optgroup>'
    : '<optgroup label="本机音色"><option disabled>这台机器没装中文音色</option></optgroup>'
  sel.innerHTML = cloud + local
}
$s('ttsVoice')?.addEventListener('change', (e: any) => {
  localStorage.setItem(VOICE_KEY, e.target.value)
  // 同一个窗口内改 localStorage 不会给自己发 storage 事件，车机屏在另一个
  // 窗口所以收得到；这里只管存
})
$s('ttsTry')?.addEventListener('click', () => {
  const name = $s('ttsVoice')?.value ?? ''
  const demo = '小雨点打在桥上，妞妞把伞举得高高的。'
  // 豆包：Key 在代理侧，面板零凭据直接连（实拍：没这分支时选豆包落进本机
  // 兜底，试听出来是系统默认音色）
  if (isVolcVoice(name)) {
    const vv = volcSpeaker(name)
    if (vv) {
      const chunks: Uint8Array[] = []
      volcStream(vv, demo, .92, c => chunks.push(c)).done
        .then(() => new Audio(URL.createObjectURL(new Blob(chunks as BlobPart[], { type: 'audio/mpeg' }))).play())
        .catch(e => log('r', `豆包试听失败：${e?.message ?? e}`))
      return
    }
  }
  if (isCloudVoice(name) && xfOk) {
    xfSynthesize(XF, xfVcn(name), demo, .92)
      .then(b => new Audio(URL.createObjectURL(b)).play())
      .catch(e => log('r', `讯飞试听失败：${e?.message ?? e}`))
    return
  }
  const v = pickVoice((speechSynthesis.getVoices() ?? []) as any, { name })
  try { speechSynthesis.cancel() } catch { /* 没在说话时个别内核会抛 */ }
  const u = new SpeechSynthesisUtterance(demo)
  u.lang = 'zh-CN'; u.rate = .92
  if (v) u.voice = v as any
  speechSynthesis.speak(u)
})
if ('speechSynthesis' in window) {
  /**
   * `getVoices()` 第一次调用**是空的**（音色异步加载），而 `voiceschanged`
   * 实测并不可靠 —— 页面加载 800ms 后手动查已经有 180 个音色，事件却没来过。
   * 事件 + 有界重试两条都挂上：谁先到算谁的，拿到就停。
   */
  speechSynthesis.addEventListener?.('voiceschanged', renderVoices)
  let tries = 0
  const poll = setInterval(() => {
    renderVoices()
    if (speechSynthesis.getVoices().length || ++tries > 12) clearInterval(poll)
  }, 250)
  renderVoices()
}
/**
 * 导出：Blob + `<a download>`。**零依赖**，也不需要后端 ——
 * 自包含 H5 双击就能开，这是家长真正会转发的东西。
 */
/**
 * 导出前把每张图重采样成 webp。**不压等于交付不了** ——
 * 实测 Gemini 出的一张图 358–588KB，七页的 H5 会到 4.5MB，微信发不出去，
 * 而"家长发给爷爷奶奶"正是这个产品的交付方式。
 * 决策（缩到多大、压不压）在 `shrink.ts` 的纯函数里，这里只做 canvas 重采样。
 */
async function shrinkDataUrl(url: string): Promise<string> {
  try {
    const im = await new Promise<HTMLImageElement>((res, rej) => {
      const i = new Image(); i.onload = () => res(i); i.onerror = rej; i.src = url
    })
    const plan = planShrink(im.naturalWidth, im.naturalHeight)
    if (plan.skip && url.startsWith('data:image/webp')) return url   // 已经是压好的
    const cv = document.createElement('canvas')
    cv.width = plan.w; cv.height = plan.h
    cv.getContext('2d')!.drawImage(im, 0, 0, plan.w, plan.h)
    const out = cv.toDataURL('image/webp', WEBP_Q)
    // 压完反而更大就用原图（小图转码有时会胀）
    return out.length < url.length ? out : url
  } catch { return url }   // 压不了就用原图，别让整本书导不出来
}

$s('bookExport')?.addEventListener('click', async () => {
  const raw = story.books()[0]
  if (!raw) return
  const btn = $s('bookExport'); btn.disabled = true; btn.textContent = '正在打包…'
  const cast = story.cast()
  const b = {
    ...raw,
    pages: await Promise.all(raw.pages.map(async pg =>
      pg.image ? { ...pg, image: await shrinkDataUrl(pg.image) } : pg)),
  }
  const p = story.profile() ?? {}
  const html = buildBookHtml(b, { name: p.name, age: p.age,
    cast: cast ? await shrinkDataUrl(cast) : undefined })
  btn.disabled = false; btn.textContent = '导出上一本书'
  const url = URL.createObjectURL(new Blob([html], { type: 'text/html;charset=utf-8' }))
  const a = document.createElement('a')
  a.href = url; a.download = bookFileName(b); a.click()
  const note = $s('storyNote')
  if (note) note.textContent = `《${b.title}》已导出，${(html.length / 1024 / 1024).toFixed(1)}MB`
  setTimeout(() => URL.revokeObjectURL(url), 1000)
})
loadHeroFromPublic()
renderStoryNote()
const prefs = createPrefs()
const autoplay = createAutoplay(store, state)

/* ══════════ 自动化任务（设计 2026-08-18-automation-design.md） ══════════
 *
 * **后台运行**的落点：引擎常驻这里，5 秒评估一轮（信号沿 + 每天定时），
 * 与对话世代无关——没在聊天、聊到一半、刚 barge-in 都照常触发。
 * 规则在 localStorage，刷新/重开还在。零后端边界如实：车机窗口在任务就在，
 * 关掉浏览器即停（等同真车熄火断电）。
 *
 * 动作执行在这层（core 引擎只判定）：tool 直调 registry；prompt 委托
 * 叫醒慢层；ask 规则先弹确认卡，用户点了"执行"模型再 automation.run。
 */
const autoStore = createAutomationStore({
  get: k => localStorage.getItem(k), set: (k, v) => localStorage.setItem(k, v),
})
async function executeAutomation(rule: AutomationRule): Promise<string> {
  const parts: string[] = []
  for (const act of rule.do) {
    if ('prompt' in act && act.prompt) {
      // 委托类：合成一条带来源的输入叫醒助手——它的产出走正常语音/卡片通道。
      // source:'automation' 让它经 Scheduler 排队等用户回合结束，不抢麦
      // （R-2 修复：以前这里没打 source，默认落 'voice'，能在用户说话时插队）
      ask(`[自动任务·${rule.name}] ${act.prompt}`, { source: 'automation' })
      parts.push('已交给助手')
    } else if ('tool' in act && act.tool) {
      const r = await registry.invoke(act.tool, act.args ?? {})
      parts.push(`${act.tool} ${r.status === 'ok' ? '✓' : r.message ?? r.status}`)
    }
  }
  return parts.join('、') || '空任务'
}
const onAutoFire = async (rule: AutomationRule) => {
  if (rule.ask) {
    // 运行前询问：确认卡的选项自带上下文——点选合成的那句话要让模型看得懂
    desk.render({
      key: `auto-ask-${rule.id}`, template: 'confirm', size: 'wide', kind: 'system', ttl: 'untilTaskEnd',
      data: { title: '自动任务', question: `「${rule.name}」条件满足了，要执行吗？`,
        options: [`执行自动任务「${rule.name}」`, '这次跳过'] },
    })
    log('p', `⚙ 自动任务「${rule.name}」条件满足，等用户确认`)
    bus.send({ type: 'voice', s: 'confirming', text: `自动任务${rule.name}条件满足了，要执行吗`, who: 'agent' })
    return
  }
  const brief = await executeAutomation(rule)
  log('p', `⚙ 自动任务「${rule.name}」已执行：${brief}`)
  bus.send({ type: 'banner', on: true, title: `自动任务 · ${rule.name}`, desc: '已执行', ttl: 6000 })
}
const autoEngine = createAutomationEngine(store, autoStore, r => { void onAutoFire(r) })
setInterval(() => autoEngine.evaluate(), 5000)

/* ── 旅行任务的采样调度 ──
 *
 * monitor 只说"谁到期了"，取数/建卡在 travelEngine，叫醒模型在这儿——
 * 三层各管各的，跟 automation 的 引擎判定 / 装配执行 是同一条分工。
 *
 * 触发之后**不直接说话**，而是把事实交给模型去组织话术（PRD：建议必须
 * 带依据，而依据在返回的 trend 里）。走 scheduler 排队：系统事件永远
 * 等用户这一轮说完才轮到自己，不抢麦。
 */
const travelEngine = createTravelEngine({
  store: () => travelStore, desk: () => desk,
  sources: () => travelSources, clock: Date.now,
})
const travelMonitor = createMonitor({
  items: () => travelEngine.items(),
  onDue: ids => { void onTravelDue(ids) },
})
async function onTravelDue(ids: string[]) {
  // ids 为空 = 面板已经自己采过了，这里只走"叫醒模型报简报"那一半
  const fired = ids.length ? await travelEngine.sampleDue(ids)
    : travelStore.watches().filter(w => w.status === 'fired')
      .map(w => ({ watchId: w.id, kind: w.kind, label: w.label, value: w.lastValue!,
                   threshold: w.threshold, note: undefined as string | undefined,
                   trend: undefined as any }))
  if (!fired.length) return          // 无更新不开口——连模型都不叫醒
  log('p', `✈ 行程监控触发 ${fired.length} 项：${fired.map(f => f.label).join('、')}`)
  const facts = fired.map(f =>
    `${f.label}：现在 ${f.value}${f.threshold !== undefined ? `（你设的线 ${f.threshold}）` : ''}` +
    `${f.trend?.band ? `，近 30 天处于${f.trend.band}` : ''}${f.note ? `（${f.note}）` : ''}`).join('；')
  scheduler.submit(
    `[系统] 你盯着的行程有更新了：${facts}。` +
    `按章法报一句 ≤40 字的简报，带上依据；屏幕上趋势卡已经有了，别逐条念数字。`,
    { source: 'system:travelFired' })
}
/* ── 面板上的三个手动闸（演示可控性） ──
 *
 * 真实价格不会配合演示按时降价，这是接真 API 的固有矛盾。不造假数据的解法
 * 是**把阈值设在现价之上**：下一轮采样必然命中，触发链路、卡片、话术全是真的。
 */
const tvNote = (t: string) => { const e = $s('tvNote'); if (e) e.textContent = t }
$('tvDemo').onclick = async () => {
  const c = await registry.invoke('travel.create', {
    destination: '首尔', title: '韩国行',
    departDate: new Date(Date.now() + 13 * 864e5).toISOString().slice(0, 10),
    watch: [{ kind: 'flight' }, { kind: 'hotel' }, { kind: 'fx', direction: 'above' }],
  })
  const taskId = (c.data as any)?.taskId
  // 先采一轮拿到现价，再把提醒线设在现价之上——演示必然触发，且全是真链路
  await registry.invoke('travel.refresh', { taskId })
  for (const w of travelStore.watches().filter(w => w.taskId === taskId)) {
    if (w.lastValue === undefined || w.kind === 'fx') continue
    travelStore.addWatch({ ...w, id: w.id + '_x', threshold: Math.round(w.lastValue * 1.05) })
    travelStore.cancelWatch(w.id)
  }
  tvNote('示例任务建好了（韩国行 · 首尔）。点「立刻采一轮」就会触发到价提醒。')
  log('p', '✈ 已建示例行程任务')
  push()
}
$('tvRefresh').onclick = async () => {
  const ids = travelStore.activeWatches(Date.now()).map(w => w.id)
  const fired = await travelEngine.sampleDue(ids)
  tvNote(fired.length ? `采了 ${ids.length} 项，${fired.length} 项到价了` : `采了 ${ids.length} 项，没有到提醒线的`)
  if (fired.length) void onTravelDue([])   // 走同一条交付：叫醒模型报简报
  push()
}
$('tvClear').onclick = () => {
  for (const t of travelStore.tasks()) travelStore.removeTask(t.id)
  for (const c of [...desk.layout().cards]) if (c.template === 'trend' || c.key === 'travel-plan') desk.dismiss(c.id)
  tvNote('行程都清了')
  push()
}

// 每分钟看一眼谁到期。粒度按分钟够了——价格场景不追秒级，端上也不该空转
setInterval(() => travelMonitor.tick(), 60_000)
// 上电补采一轮（PRD：上电后先做一次全量信息更新，判断是否需要提醒）
setTimeout(() => travelMonitor.boot(), 1500)

/* ══════════ 旅行助手（长时任务） ══════════
 *
 * 任务与委托跨上下电存续：关这个窗口 = 熄火（引擎停），重新打开 = 上电
 * （boot 补采一轮）——跟自动化引擎「车机窗口在任务就在」同一条零后端边界。
 *
 * 四类监控项**三真一模拟**：汇率是真的（frankfurter，零 Key、有真历史），
 * 新闻走既有 NewsAPI；机酒暂用示例数据源（RapidAPI 候选全是非官方封装、
 * 免费层 50 次/月），它同时是录制槽——拿到 Key 换一行就是真的。
 */
const travelStore = createTravelStore(defaultStorage())
const travelSources = {
  fx: fxSource(createFxClient(fetch.bind(window))),
  flight: mockSource(),
  hotel: mockSource(),
}

const registry = createRegistry(store, TOOLS, Date.now, {
  state, prefs, desk, amap, itunes: createItunesClient(), radio: createRadioClient(fetch.bind(window)),
  lyrics: createLrclibClient(fetch.bind(window), api('lrclib')).search,
  stocks: createStockClient(fetch.bind(window)), holiday: createHolidayClient(fetch.bind(window)),
  poem: createPoemClient(fetch.bind(window)), podcast: createPodcastClient(fetch.bind(window)),
  orvideo: createVideoGen(fetch.bind(window), () => apiKey),
  ormusic: createMusicGen(fetch.bind(window), () => apiKey),
  news: createNewsClient(fetch.bind(window), () => newsKey),
  pexels: createPexelsClient(fetch.bind(window), () => pexelsKey),
  websearch: createWebSearch(createOnlineChat(() => apiKey, () => modelId)),
  story, image: imageGen,
  automation: { store: autoStore, execute: executeAutomation },
  travel: travelStore, travelSources,
  // 常用地址持久化 + 语音配置：voice.config 写的 key 跟上面那个音色下拉框
  // 是同一个（cockpit-sim:tts:voice），单一事实，车机屏靠 storage 事件生效
  storage: defaultStorage(),
  voices: () => zhVoices((speechSynthesis?.getVoices?.() ?? []) as any),
  // 天气换源（2026-08-15）：零 Key 零注册，官方 CORS，高德留兜底
  openmeteo: createOpenMeteoClient(fetch.bind(window)) })

// 卡片编排器：桌面 = f(状态)。基础卡片（导航/车窗反馈）由规则驱动，模型零参与
/**
 * 车控回执走横幅不进桌面（产品判断：开车窗开空调是通知不是卡片）。
 * 分派在 `channelOf`、落点在编排器，这里只负责把它接到车机屏的横幅上。
 * tone 用 ok：这是"做成了"，跟拒绝/约束那几条 warn 的分开
 */
createOrchestrator({
  store, desk, rules: CARD_RULES, builders: DATA_BUILDERS, deps: { store, amap, state },
  onAck: a => {
    if (muted) return              // 让位给别的写者时不出声（单写者一致性）
    bus.send({ type: 'banner', on: true, reason: 'done', title: a.title, desc: a.text, ttl: 4000 } as any)
    log('a', `[回执] ${a.title}：${a.text}`)
  },
}).start()

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
/**
 * run() 的唯一准入入口（R-2，调度与呈现重构方案 §03）。以前 automation
 * 触发的调用没打 source（默认落 'voice'）、storyChapterDone 甚至裸调
 * pipeline.run() 绕开 ask()——两条路径都能在用户正说话时抢着调 pipeline.run，
 * 而 pipeline 每次 run() 都会 ++gen 让上一个还没跑完的 run 立刻变 stale，
 * 系统事件因此能打断一个真实用户的对话。这里把 pipeline.run 包一层：
 * 语音/点选立即执行（barge-in 语义不变，pipeline 内部继续管），
 * 系统事件/自动化排队等用户回合结束。
 */
const scheduler = createScheduler((text, opts) => pipeline.run(text, opts))

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
  desk.render({ key: 'stagedlist', template: 'stagedlist', size: 'tower', kind: 'system',
    urgency: 'urgent', ttl: 'untilTaskEnd', data: { title: '还在后台的内容', items } })
}
desk.subscribe(() => renderStagedList())
/**
 * 翻篇统一出口的 director 半边（交互总设计 R2）：绘本卡从桌面**彻底消失**
 * （findByKey 台上台下都查——被挤下台不算消失）且故事还活着 → 收场。
 * 状态一落，storyHandlers 的状态机对齐 + 各闸全部生效；覆盖模型
 * card.dismiss 这类不走 userAction 的撤卡路径（实拍：模型关卡后故事还活着）。
 */
desk.subscribe(() => {
  if (!store.get('story.active')) return
  if (desk.findByKey('storybook')) return
  store.set('story.phase', 'done')
  store.set('story.active', false)
  store.set('story.pending', 0)
  log('p', '⛔ 绘本卡不在桌面了，故事就此收场')
})
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
  /**
   * 一章读完了 —— 把话头交回给模型。
   *
   * 车机屏报的是**事实**（读到章末），这里合成一句用户输入进对话，
   * 让模型按技能包的章法开口问「你觉得后面会发生什么呢」。
   * **问什么话不在这里写死** —— 写死就等于把策略搬进了机制，
   * 而且孩子每次听到的都是同一句。
   */
  if (m.type === 'storyChapterDone') {
    // 双保险（同 storyContinue 的锁门）：故事已收场时迟到的章末上报不叫醒模型——
    // 叫醒了它就按章法接着问、接着写，讲完的书又活了
    if (!store.get('story.active')) return
    store.set('story.phase', 'asking')
    // 经 Scheduler（R-2）而不是裸调 pipeline.run：以前这里绕开一切并发保护，
    // 章末唤醒能在用户正说着别的话题时抢着 ++gen，把用户那一轮判成 stale
    scheduler.submit('[系统] 这一章的页读完了。你只做一件事：用 voice.ask 问孩子接下来想怎么发展（开放问题，不给选项）。不要调 story.begin，也不要调 story.continue——孩子还没说想法，写什么都是替他做主', { source: 'system:chapterDone' })
    return
  }
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
      /**
       * 等价触发去重（交互总设计 R1-③）：同一按钮 3 秒内点两下（第一下没看到
       * 反馈再点是人的本能，双通道漏网也走这兜底）→ 第二下忽略。
       * 实拍：点一次"就是他"起了两条 run，第二条把定妆→确认→开书重走一遍。
       */
      if (said === lastAnswer.said && Date.now() - lastAnswer.at < 3000) {
        log('p', '（重复点选，已忽略）')
        return
      }
      lastAnswer = { said, at: Date.now() }
      log('u', `[屏幕] ${said}`)
      ask(said, { answer: true, source: 'tap-answer' })   // 屏端回答直达慢层——快层对"第4个"无事可做
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
  const target: Record<string, number | string> = {}
  for (const k of POS) target[k] = store.getTarget(`cabin.window.${k}.position`) as number
  /**
   * 主题与壁纸也要上车（2026-08-19 实拍修）：target 原来只装四扇车窗，
   * hmi.* 信号从来没发给过车机屏——工具全成功、屏上永远没反应，
   * 应用逻辑是好的，信号没上车。push 每 200ms 一趟，屏端按变化应用。
   */
  target['hmi.theme'] = store.get('hmi.theme') as string
  target['hmi.wallpaper'] = store.get('hmi.wallpaper') as string
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
 * 任务进展卡（§6.2）：步骤流——✓ 已完成（带耗时）/ ⟳ 进行中。
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
    case 'executing': {
      // 活动胶囊的数据源（Avatar 定稿 §02）：pipeline 事件本来就带工具名，
      // 转成 brief（人话）一起上屏——不带的话思考态的"它在干什么"没有任何出口。
      // chip 与 text 分开：text 会进字幕主行，chip 只进胶囊层
      const brief = registry.list().find(t => t.name === (e as any).name)?.brief
      bus.send({ type: 'voice', s: 'executing', chip: brief ?? (e as any).name } as any)
      break
    }
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
async function ask(text: string, opts: { answer?: boolean; source?: string } = {}) {
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
  const r = await scheduler.submit(text, opts)

  let rn = 0
  for (const s of r.trace) {
    // run 可观测：来源与 runId 打头——double-run/幽灵 run 一眼即辨
    if (s.type === 'userInput' && (s as any).runId)
      log('p', `  ⟪${(s as any).runId} · ${(s as any).source}⟫`)
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
    if (s.type === 'toolCall') log('t', `  → ${s.name}(${JSON.stringify(s.args)})  [${s.permission ?? '元'}]`)
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
/**
 * 冷启动"车在哪"（2026-08-18）：没手选过城市就问一次 IP 定位（精度到市，
 * 高德已有 Key 白捡）。非大陆出口 IP 会返回 null——那就维持默认，不瞎猜。
 */
if (!localStorage.getItem(CITY_KEY) && amap) {
  amap.ipLocate().then(r => {
    if (!r || localStorage.getItem(CITY_KEY)) return
    const opt = Array.from(citySelect.options).find(o => r.city.includes(o.textContent ?? '～'))
    if (opt) { citySelect.value = opt.value; citySelect.dispatchEvent(new Event('change')) }
    log('p', `IP 定位：当前城市按 ${r.city} 初始化（可在下拉框改）`)
  }).catch(() => { /* 定位失败维持默认 */ })
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
