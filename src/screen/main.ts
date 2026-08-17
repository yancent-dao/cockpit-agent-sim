import { injectTokens } from '../design/tokens'
import { createBus, type BusMsg } from '../bus'
import { afterRead, beforeRead, WAIT_MAX_MS, IMG_WAIT_MS } from './storyflow'
import { pickVoice, estimateMs, litUpto, voiceAct } from './speech'
import { isCloudVoice, xfVcn, synthesize as xfSynthesize } from '../integrations/xftts'
import { fitScale } from './overflowgate'
import { parseTurn, dayLabel, speedChip } from './turn'
import { navForm, mediaForm, formOf } from '../config/forms'
import { createBannerQueue, toneOf, bannerHtml } from './banner'
import { posKey, isNoop, commitMoves, type Move } from './flip'
import { classifyGesture } from './gestures'
import { sanitize } from './sanitize'
import { SANDBOX, buildSrcdoc, validateBridgeMsg } from './canvasApp'
import { tokensFor } from '../design/tokens'
import { dimsOf, GRID, TIERS, SCREEN } from '../config/grid'
import { cardBody, tierClass, accentClass, fmtTime, progressPct,
  NAV_SKELETON, NAV_SLOTS, PLAYER_SKELETON, PLAYER_SLOTS } from './render'
import { showRoute, disposeRoute, resizeRoute } from './mapView'
import { createPlayer } from './player'
import { esc } from '../text'
import { TPL_ICONS, ICON_PREV, ICON_PLAY, ICON_PAUSE, ICON_NEXT, weatherIcon } from './icons'
import { routeOf } from '../config/interactions'

// Token 必须运行时注入：build-single 只替换 <script>，外部 .css 在单文件版会整个丢失
injectTokens('screen')
// 几何常量注入：栅格/内边距的唯一出处是 grid.ts，CSS 只消费变量——
// 之前 repeat(12,1fr) 和 padding 在两边手工同步，注释里自己承认"改这里要同步改那边"
{
  const el = document.createElement('style')
  el.textContent = `:root{--grid-cols:${GRID.cols};--grid-rows:${GRID.rows};` +
    `--desk-pad:${SCREEN.padY}px ${SCREEN.padX}px;--desk-gap:${SCREEN.gap}px;--status-h:${SCREEN.statusH}px}`
  document.head.appendChild(el)
}

const $ = (id: string) => document.getElementById(id)!
const POS = ['driver', 'passenger', 'rearLeft', 'rearRight'] as const
const CN: Record<string, string> = { driver: '主驾', passenger: '副驾', rearLeft: '左后', rearRight: '右后' }

/* ── 等比缩放：设计稿 2560×1440 ── */
const stage = $('stage')
/** 舞台缩放比。FLIP 要用它换算 —— getBoundingClientRect 给的是缩放后像素 */
let stageScale = 1
const fit = () => {
  // 0.92：给真机边框和投影留出呼吸空间——贴满视口时黑边被裁在屏外
  stageScale = Math.min(innerWidth / 2560, innerHeight / 1440) * 0.92
  stage.style.transform = `scale(${stageScale})`
}
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
  /** 右上角缩放按钮该不该置灰——desk 算好直接发，屏幕不重算业务逻辑 */
  canShrink?: boolean; canGrow?: boolean
}
let deskState: { cards: CardView[]; overlay?: CardView; free: number;
  staged?: Array<{ id: string; template: string; title: string }> } = { cards: [], free: 6 }
let hotCards = new Set<string>()

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
/**
 * 横幅队列。三条提示同时来时只显示一条、其余排队 —— 队列逻辑在 banner.ts（可测），
 * 这里只负责把它接到 DOM 上。
 */
const BAN_ICON: Record<string, string> = { danger: '⨯', warn: '!', info: 'i', ok: '✓' }
const banners = createBannerQueue({
  show: b => {
    const el = $('banner')
    $('bnT').textContent = b.title ?? ''
    // 正文一律转义，只有 code 字段被包成 <code>——desc 的来源里有模型
    // 完全可控的字符串（挤出告知内嵌的卡片标题、模型话术、子 Agent summary），
    // 而这个页面的 localStorage 里放着 OpenRouter 和高德的 Key
    $('bnD').innerHTML = bannerHtml(b)
    $('bnI').textContent = BAN_ICON[b.tone ?? 'info'] ?? 'i'
    el.className = `a-${b.tone ?? 'info'} on`
  },
  hide: () => { $('banner').classList.remove('on') },
})
setInterval(() => banners.tick(), 200)

const player = createPlayer({
  report: (event, detail) => {
    bus.send({ type: 'mediaEvent', event, detail } as any)
    // 被浏览器的自动播放策略拦下来了。这是**唯一**需要用户动手的时刻，
    // 所以到这一步才说 —— 不必开屏就先摆一张遮罩
    if (event === 'blocked')
      banners.push({ title: '声音被浏览器拦住了', text: '在屏幕上点一下就能放出声', tone: 'warn', ttl: 8000 })
  },
})

/**
 * 自动播放解锁。
 *
 * **不再用全屏遮罩挡着**——它是演示时第一眼看到的东西，而 95% 的场合
 * 根本用不到声音。改成：屏幕上任何一次点击都拿来换播放权限（多数演示者
 * 打开窗口时总会点一下），真被浏览器拦下来时再走横幅说一句。
 *
 * 浏览器的自动播放策略是硬的，去掉遮罩不等于问题消失 ——
 * 区别只是「默认假设有问题」变成「出问题时才说」。
 *
 * 必须在事件处理函数里**同步**调用 unlock()，塞进 await 之后就不算用户手势了。
 */
addEventListener('pointerdown', () => {
  if (player.unlocked) return
  player.unlock()
}, { capture: true })

/**
 * 手势层：命中测试 → 查交互声明 → 上报 userAction。
 * 这里不做任何路由决策（那是 director 对着声明表干的事）——
 * 屏幕上报的是"用户做了什么"这个**事实**，跟 mediaEvent 同一条边界。
 * 位移阈值按 stage 像素算：client 位移要除以舞台缩放比（FLIP 踩过的同一个坑）。
 */
let gStart: { x: number; y: number; t: number; card: HTMLElement | null; target: HTMLElement | null } | null = null
addEventListener('pointerdown', e => {
  const card = (e.target as HTMLElement).closest?.('.card') as HTMLElement | null
  gStart = { x: e.clientX, y: e.clientY, t: Date.now(), card, target: e.target as HTMLElement }
})
addEventListener('pointerup', e => {
  if (!gStart) return
  const s0 = gStart; gStart = null
  const g = classifyGesture({
    dx: (e.clientX - s0.x) / stageScale,
    dy: (e.clientY - s0.y) / stageScale,
    dt: Date.now() - s0.t,
  })
  if (!g || !s0.card) return
  const cardId = [...cardNodes.entries()].find(([, n]) => n === s0.card)?.[0]
  if (!cardId) return
  if (g === 'tap') {
    const hit = s0.target?.closest?.('[data-act]') as HTMLElement | null
    if (!hit || !s0.card.contains(hit)) return
    bus.send({ type: 'userAction', cardId, act: hit.dataset.act!, value: hit.dataset.value } as any)
  } else if (g === 'swipe-x') {
    bus.send({ type: 'userAction', cardId, act: 'swipe:away' } as any)
  }
  // scroll 交给浏览器原生（.bd overflow:auto），手势层不管
})

/**
 * 播放器卡。跟导航卡同一个道理——<video> 元素不能跟着文字一起重绘，
 * 重建就从头开始播了，所以容器建一次就长在那儿。
 */
function renderPlayerCard(node: HTMLDivElement, c: CardView) {
  const d = c.data ?? {}
  const isVideo = d.source === 'video'
  const form = mediaForm(...dimsOf(c.size))
  if (!node.querySelector('.plwrap')) {
    node.innerHTML = PLAYER_SKELETON
    ;(node.querySelector('.plctl') as HTMLElement).innerHTML =
      `<span data-act="tap:prev">${ICON_PREV}</span><span data-act="tap:toggle">${ICON_PLAY}</span><span data-act="tap:next">${ICON_NEXT}</span>`
    // 全套播控与音量：hall 起才有。是**状态指示**不是按钮，语音才是主通道
    ;(node.querySelector('.plmix') as HTMLElement).innerHTML =
      `<span>🔀 随机</span><span>🔁 循环</span><span>♥ 收藏</span>`
    ;(node.querySelector('.plvol') as HTMLElement).innerHTML =
      `<span>🔈</span><div class="pltrk"><div class="plfl" style="width:60%"></div></div><span>🔊</span>`
  }
  /**
   * 按**槽位表**统一显隐。以前每个块手写一行 `form.blocks.includes('x')`，
   * 加一个块要记得同时改形态函数和这里 —— 漏一边就是"声明了却从不显示"
   * （车身图那次就是这么死的，图画好了从没在屏幕上出现过）。
   */
  const slot = (name: string) => node.querySelector(PLAYER_SLOTS[name]) as HTMLElement | null
  for (const [name, sel] of Object.entries(PLAYER_SLOTS)) {
    const el = node.querySelector(sel) as HTMLElement | null
    if (el) el.style.display = form.blocks.includes(name) ? '' : 'none'
  }
  // 完整队列：court 起。跟"接下来"预告分开——一个是一行预告，一个是列表
  const q = slot('queue')
  if (q && form.blocks.includes('queue')) {
    const list: any[] = d.queue ?? []
    q.innerHTML = list.slice(0, 4).map(t =>
      `<div class="qi">${esc(t.track ?? t)}</div>`).join('')
  }
  // 竖排只给竖条卡（tower）：宽度不够封面和文字并排。以前用"没有 sub"判断，
  // 封面改成任何档位都在之后，chip/strip 会被误判成竖排——一行高的卡竖着摞必然溢出
  const [pc, pr] = dimsOf(c.size)
  node.classList.toggle('narrow', pr >= 4 && pc <= 4)
  // 控制条是**状态指示不是按钮**——屏幕不可交互，画成图标就有诱导点击的风险。
  // 这行字把它标回语音能力，顺带填了「能力曝光度」的一半
  const barEl = node.querySelector('.plbar') as HTMLElement
  const art = node.querySelector('.plart') as HTMLElement
  // 控制条从"状态指示"变成真按钮（触控落地，§10 的约定反转）。
  // 电台没有上下曲，藏掉两端只留播放/暂停
  const ctl = node.querySelector('.plctl') as HTMLElement
  // 中键随状态换脸：播放中显 ⏸，暂停显 ▶。只在状态变化时重写——
  // hello 心跳每 4 秒全量重推，无脑重写 SVG 会闪
  const mid = ctl.children[1] as HTMLElement
  if (mid.dataset.st !== String(!!d.playing)) {
    mid.dataset.st = String(!!d.playing)
    mid.innerHTML = d.playing ? ICON_PAUSE : ICON_PLAY
  }
  // 两级控制条：bar 档三键；小到 card 档留播放/暂停单键（实拍缺口：
  // 卡被挤到 1/6 时完全没按钮，想停都停不了）
  const full = form.blocks.includes('bar')
  const single = !full && form.blocks.includes('toggle')
  if (!(full || single)) ctl.style.display = 'none'
  for (const el of Array.from(ctl.children) as HTMLElement[]) {
    const isMid = el.dataset.act === 'tap:toggle'
    el.style.display = (single && !isMid) || (d.source === 'radio' && !isMid) ? 'none' : ''
  }
  // 直播与否是**音源**的属性，不是"这一刻 duration 是多少"能猜的
  barEl.classList.toggle('live', d.source === 'radio')
  const nxt = node.querySelector('.pl-next') as HTMLElement
  const upcoming: string[] = d.nextUp ?? []
  if (!upcoming.length) nxt.style.display = 'none'
  nxt.textContent = upcoming.length ? `接下来：${upcoming.join(' · ')}` : ''
  const hint = node.querySelector('.pl-hint') as HTMLElement
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
      // 没封面给渐变底 + 音源图标，别留灰洞
      art.innerHTML = `<div class="plicon">${TPL_ICONS.media}</div>`
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
 * 生成式卡：模型直出的 HTML 进 Shadow DOM。
 *
 * Shadow DOM 天然做样式隔离 —— 模型写的 style 漏不出去污染桌面，桌面的样式
 * 也不会打乱它，同时 font/color 仍从外部继承，所以它默认就长得像这套系统。
 * 零依赖，浏览器原生。
 *
 * 消毒（sanitize.ts）是**安全边界不是可选项**：这是整个系统里唯一一处
 * 把模型输出当代码执行的地方。消毒后为空就退回纯文字，**绝不白屏**。
 */
function renderCanvasCard(node: HTMLDivElement, c: CardView) {
  const d = c.data ?? {}
  const host = node.querySelector('.cvhost') as HTMLElement
  if (!host) return
  const root = (host as any).__shadow ?? host.attachShadow({ mode: 'open' })
  ;(host as any).__shadow = root
  const r = sanitize(String(d.html ?? ''))
  // 剥了什么要上报 —— 不说出来的话没人知道模型哪里写错了
  if (r.stripped.length) bus.send({ type: 'canvasNote', cardId: c.id, stripped: r.stripped } as any)
  root.innerHTML = `<style>${tokensFor('screen')}
    :host{display:block;height:100%;overflow:hidden;color:var(--tx-1);
      font-family:inherit;font-size:var(--t-cap)}
    *{box-sizing:border-box;margin:0;max-width:100%}
    table{border-collapse:collapse;width:100%}
    td,th{padding:8px 12px;border-bottom:1px solid var(--hair);text-align:left}
    th{color:var(--tx-3);font-weight:500}
    svg{max-height:100%}
  </style>${r.empty
    // 退回纯文字。模型写了一整屏 <script> 时，用户该看到那句话，不是一张空卡
    ? `<div style="font-size:var(--t-lead);line-height:1.3">${esc(d.text)}</div>`
    : r.html}`
  /**
   * 溢出检测。屏幕不可滚动，超出等于用户永远看不到。
   *
   * 上报给尺寸自愈（升档）是**第三道闸**；升到最大档还溢出时，
   * 第四、第五道闸在这里接手：整体缩放 → 缩不下去就剥到纯文字。
   * 判据在 `overflowgate.ts` 的纯函数里（DOM 跑不了单测）。
   */
  requestAnimationFrame(() => {
    // 先把量到的还原，不然上一轮的 scale 会把这一轮的测量一起缩掉
    host.style.transform = ''
    host.style.width = ''
    node.classList.remove('cvscroll')
    const fit = fitScale({
      w: host.clientWidth, h: host.clientHeight,
      // +2 的余量留给亚像素舍入 —— 跟 heal.ts 用的是同一个数
      contentW: host.scrollWidth - 2, contentH: host.scrollHeight - 2,
      // 行驶中不给滚（滚动要眼睛加手）。5km/h 跟 window.set 的升级阈值同一个数
      canScroll: !(Number(meta.speed) > 5),
    })
    if (fit.do === 'scale') {
      host.style.transformOrigin = 'top left'
      host.style.transform = `scale(${fit.scale})`
      // 缩了之后右边会空出来，把宽度按比例撑回去，别让内容缩成左边一条
      host.style.width = `${100 / fit.scale}%`
    } else if (fit.do === 'scroll') {
      /**
       * **能滚就别丢**。缩到读不了的份上时，滚动保住每一个字 ——
       * 实拍那份研究报告被一路砍成半份，就是因为这一档以前直接跳到剥文字。
       *
       * 「能不能滚」由 fitScale 判（行驶中不给），这里只负责让它真能滚
       * **并且让人看得出来能滚** —— 看不见的能力等于没有能力。
       */
      node.classList.add('cvscroll')
      // 滚到底就撤掉底部渐隐和提示 —— 不然最后一行永远是灰的，
      // 而"可上下滑动"一直在催一个已经做完的动作
      const atEnd = () => node.classList.toggle('cvend',
        host.scrollTop + host.clientHeight >= host.scrollHeight - 2)
      host.onscroll = atEnd
      atEnd()
    } else if (fit.do === 'text') {
      // 缩到读不了的份上 —— 宁可显示得少，不要显示得糊
      root.querySelector('.gen')?.remove()
      host.innerHTML = `<div style="font-size:var(--t-lead);line-height:1.4">${esc(d.text)}</div>
        <div style="margin-top:12px;font-size:var(--t-cap);color:var(--tx-3)">内容过长，已简化</div>`
    }
    // 仍然上报给自愈：升档是更好的解（缩放是兜底不是首选）
    const over = host.scrollHeight > host.clientHeight + 2
    bus.send({ type: 'canvasNote', cardId: c.id, overflow: over, contentPx: host.scrollHeight } as any)
  })
}

/**
 * canvas-app：模型的 JS 在 iframe 沙箱里执行——全系统唯一的容器。
 * 隔离靠源隔离不靠消毒：sandbox 无 allow-same-origin，iframe 是 opaque origin，
 * 拿不到宿主 localStorage（Key 在里面）、碰不到 bus。
 * 桥消息全量过 validateBridgeMsg——沙箱能 post 任意东西，形状校验是宿主的责任。
 */
/**
 * iframe window → cardId。**必须是 WeakMap**：canvas-app 卡每次 srcdoc 重载
 * 都会登记一个新的 contentWindow，用强引用的 Map 就只增不删——每个沙箱页面
 * 连同它的脚本堆被永久钉住，长时间演示里内存以 MB 级无上限累积。
 */
/** 便宜的 32 位串哈希（FNV-1a）。只用来判"内容变没变"，不做安全用途 */
function hash32(str: string): string {
  let h = 0x811c9dc5
  for (let i = 0; i < str.length; i++) { h ^= str.charCodeAt(i); h = Math.imul(h, 0x01000193) }
  return (h >>> 0).toString(36)
}

const appFrames = new WeakMap<Window, string>()   // iframe window → cardId
addEventListener('message', ev => {
  const cardId = ev.source ? appFrames.get(ev.source as Window) : undefined
  if (!cardId) return
  const m = validateBridgeMsg(ev.data)
  if (!m) return
  if (m.type === 'height') bus.send({ type: 'canvasNote', cardId, contentPx: m.px } as any)
  else bus.send({ type: 'userAction', cardId, act: 'app', value: m.value } as any)
})

function renderCanvasAppCard(node: HTMLDivElement, c: CardView) {
  const d = c.data ?? {}
  let frame = node.querySelector('iframe') as HTMLIFrameElement | null
  if (!frame) {
    frame = document.createElement('iframe')
    frame.setAttribute('sandbox', SANDBOX)   // 铁律 ①：只有 allow-scripts
    frame.className = 'cvframe'
    node.querySelector('.bd')!.appendChild(frame)
  }
  const html = String(d.html ?? '').trim()
  if (!html) {
    // 兜底：没代码就显纯文字，绝不白屏
    frame.remove()
    node.querySelector('.bd')!.innerHTML = `<div class="sub">${esc(d.text ?? '')}</div>`
    return
  }
  const doc = buildSrcdoc(html)
  /**
   * 指纹用**内容哈希**而不是 html.length。只比长度的话，模型对同一张卡
   * 重新生成的代码只要字符数恰好相同（把"红色"改成"蓝色"、改一处数值）
   * 就不重载 srcdoc——屏上继续跑旧版程序，而外层 cardSig 已经判定 data 变了、
   * 标题也换成了新的，用户和模型都以为更新过了；appFrames 的桥映射还指向
   * 旧的 contentWindow，旧应用的 action 继续以这张卡的名义上报。
   */
  const sig = `${html.length}:${hash32(html)}`
  if (frame.dataset.sig !== sig) {
    frame.dataset.sig = sig
    frame.srcdoc = doc
    // srcdoc 重载后 contentWindow 会换，load 后重新登记桥映射
    frame.addEventListener('load', () => { if (frame!.contentWindow) appFrames.set(frame!.contentWindow, c.id) }, { once: true })
  }
}

/**
 * 导航卡单独渲染：地图容器建一次就长在那儿，之后只更新转向条与底部数字。
 * 整块 innerHTML 重刷会把活地图实例冲掉（闪屏、丢视角），所以这里必须分开处理。
 */
function renderNavCard(node: HTMLDivElement, c: CardView) {
  const d = c.data ?? {}
  if (!node.querySelector('.navwrap')) node.innerHTML = NAV_SKELETON
  // 尺寸决定形态：一格宽的地图看不出路，不如把空间让给转向指令
  const form = navForm(...dimsOf(c.size))
  const step = d.steps?.[0]?.instruction as string | undefined
  const turn = step ? parseTurn(step) : undefined
  /**
   * 目的地兜底行：**最小档不许渲染成空白**。转向条要有 nextInstruction 才
   * 画得出来（刚设完目的地、或没有高德 Key 的降级演示时它是空的），
   * 那时整张卡三个块全 display:none、标题又被 CSS 藏着，桌面上就只剩
   * 一条带边框的空玻璃条。只在别的块都出不来时露面，不占大档的地方。
   */
  const bar = node.querySelector('.turnbar') as HTMLElement
  const showTurn = !!turn && form.blocks.includes('turn')
  const head = node.querySelector('.navdesthead') as HTMLElement
  const needHead = form.blocks.includes('dest') && !showTurn && !form.blocks.includes('foot')
  head.style.display = needHead ? '' : 'none'
  if (needHead) head.innerHTML = `<b>${esc(d.destination ?? '导航中')}</b>`
  bar.style.display = showTurn ? '' : 'none'
  if (turn) bar.innerHTML = `<div class="arrow">${turn.icon}</div>
    <div class="turntext"><b>${esc(turn.dist)}</b><span>${esc(turn.action)}</span></div>
    ${turn.road ? `<div class="turnroad">${esc(turn.road)}</div>` : ''}`

  // 途经点要写出来：语音说了"先去充电站再去太古里"，屏幕只写终点的话用户不知道要绕路
  const via = (d.via ?? []).length ? `<em>经 ${esc((d.via as string[]).join('、'))}</em>` : ''
  const foot = node.querySelector(NAV_SLOTS.eta) as HTMLElement
  foot.style.display = form.blocks.includes('eta') ? '' : 'none'
  /**
   * **到达时刻排在最前**。Android for Cars 把它列为 TravelEstimate 的必填字段 ——
   * 人真正想知道的是"几点到"，不是"还要多久"。以前它只在最大档露面。
   */
  foot.innerHTML = `
    ${d.arriveAt ? `<div class="navbig"><b>${esc(d.arriveAt)}</b><span>到达</span></div>` : ''}
    <div class="navbig"><b>${d.eta ?? '--'}</b><span>分钟</span></div>
    <div class="navbig"><b>${d.distance ?? '--'}</b><span>公里</span></div>
    <div class="navdest">${via}${esc(d.destination ?? '')}</div>`
  /**
   * 车道指引 —— Android 数据模型里的一等组件，我们一直没有。
   * 路口最关键的信息是"在哪条道"，比 ETA 重要得多。跟着地图走：
   * 没地图的扁条档放不下五个车道箭头。
   */
  const lane = node.querySelector(NAV_SLOTS.lane) as HTMLElement
  const lanes: any[] = d.lanes ?? []
  lane.style.display = form.blocks.includes('lane') && lanes.length ? '' : 'none'
  if (lanes.length) lane.innerHTML = lanes.map(l =>
    `<i class="${l.use ? 'use' : ''}">${esc(l.dir ?? '↑')}</i>`).join('')
  // 下一步预告：hall 和 stage 唯一的内容差别，否则大档就是中档放大留白
  const then = node.querySelector(NAV_SLOTS.then) as HTMLElement
  then.style.display = form.blocks.includes('then') && d.nextTurn ? '' : 'none'
  if (d.nextTurn) then.textContent = String(d.nextTurn)

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
// hot 刻意不进指纹：高亮开/关只翻 class（className 守卫已处理），
// 掺进 sig 会让每次 highlight 的 on/off 各触发一次整卡重填——起播连写
// 六个信号引出一串 highlight 时，卡片就跟着连闪（用户实拍的"卡片闪烁"）
/**
 * 卡片内容指纹。**data 先按引用比，引用变了才序列化。**
 *
 * renderDesk 被车窗过渡的 rAF 循环每帧调用（4 秒过渡 ≈ 240 帧），
 * 每帧对每张卡 JSON.stringify 整个 data 只为得出"没变"——导航卡带着
 * 完整 polyline + steps（跨城路线几十 KB），仅它一张就是每秒数 MB 的
 * 字符串分配与 GC，而掉帧风险恰好落在动画进行时。
 * desk 侧每次 update 都会换新的 data 对象，引用比对足够灵敏。
 */
const dataSigs = new WeakMap<object, string>()
const dataSig = (d: any) => {
  if (d === null || typeof d !== 'object') return String(d)
  let sig = dataSigs.get(d)
  if (sig === undefined) { sig = JSON.stringify(d); dataSigs.set(d, sig) }
  return sig
}
const cardSig = (c: CardView) => `${c.template}|${c.size}|${c.title}|${dataSig(c.data)}`

// 上一帧的台下名单：这一帧新出现的卡若上一帧在台下 = 上台（从右缘滑入）；
// 这一帧消失的卡若进了台下 = 下台（滑向右缘）。方向让用户读出"收起来了"vs"没了"
let prevStagedIds = new Set<string>()

function renderDesk() {
  const desk = $('desk')
  const seen = new Set<string>()
  const stagedNow = deskState.staged ?? []
  const stagedIds = new Set(stagedNow.map(s => s.id))
  // 右缘边缘条："界面之外还有内容"。数字就是台下张数，点击开/收台下清单
  const tab = $('stagedTab')
  tab.classList.toggle('on', stagedNow.length > 0)
  $('stagedN').textContent = String(stagedNow.length)
  // FLIP：位置真的变了才记 first rect。车窗过渡每帧调 renderDesk()，
  // 每帧都跑 FLIP 会打架，卡片抖得像坏掉的
  const moves: Move[] = []
  let fresh = 0            // 这一批新建了第几张，用来错峰
  for (const c of deskState.cards) {
    seen.add(c.id)
    let node = cardNodes.get(c.id)
    if (!node) {
      node = document.createElement('div')
      // 多张卡同时进场要错峰 45ms，一起弹出来像抽搐。
      // 用 CSS 的 nth-child 不行：桌面里卡片和占位块混在一起，序号对不上
      node.style.animationDelay = `${fresh++ * 45}ms`
      // 上台（此前在台下）：从右缘滑入，跟"新卡从下方抬起"分开
      if (prevStagedIds.has(c.id)) {
        node.classList.add('fromstage')
        node.addEventListener('animationend', () => node!.classList.remove('fromstage'), { once: true })
      }
      cardNodes.set(c.id, node)
      desk.appendChild(node)
    }
    const pos = posKey(c)
    if (!isNoop(node.dataset.pos, pos)) {
      moves.push({ node, first: node.getBoundingClientRect() })
      node.style.gridRow = `${c.row + 1} / span ${c.rowSpan}`
      node.style.gridColumn = `${c.col + 1} / span ${c.colSpan}`
    } else if (node.dataset.pos !== pos) {
      // 首次落位（无旧 pos）：写坐标但不进 FLIP
      node.style.gridRow = `${c.row + 1} / span ${c.rowSpan}`
      node.style.gridColumn = `${c.col + 1} / span ${c.colSpan}`
    }
    if (node.dataset.pos !== pos) node.dataset.pos = pos
    // 档位类给 --u（字号 = 字阶 × --u），语义色类给 --ac 一族。
    // sz-* 那 22 条硬怼 font-size 的规则被这一个类取代了
    // picking：等着用户开口选。用户是用语音选的（"第二个"），
    // 屏上必须让他知道现在轮到他说话了。
    // 注：list 那半边（data.picking）全仓库没有生产者——触控落地后用户直接点
    // 条目，不再需要"待选中"高亮，故只保留 confirm 卡这条活着的路
    const picking = c.template === 'confirm'
    // fresh（流光两态）由挂载分支加、定时器摘——className 重写要保留它
    const isFresh = node.classList.contains('fresh')
    const cls = `card tpl-${c.template} kind-${c.kind} ${tierClass(c.size)} ${
      accentClass(c.template, c.data)}${hotCards.has(c.id) ? ' hot' : ''}${picking ? ' picking' : ''}${isFresh ? ' fresh' : ''}`
    // 变了才写：hello 心跳每 4 秒全量重推（容错设计），renderDesk 必须真幂等，
    // 否则属性风暴让整屏看着在"周期刷新"（用户实拍）
    if (node.className !== cls) node.className = cls
    const sig = cardSig(c)
    if (node.dataset.sig !== sig) {
      if (c.template === 'nav') renderNavCard(node, c)
      else if (c.template === 'media') renderPlayerCard(node, c)
      else if (c.template === 'storybook') { node.innerHTML = cardBody(c); speakStory(node, c) }
      else if (c.template === 'canvas-app') {
        if (!node.dataset.shell) {
          node.innerHTML = `<h3><span class="ico">${TPL_ICONS['canvas-app']}</span><span class="cvtitle"></span>` +
            `<span class="genmark">生成式</span></h3><div class="bd"></div>`
          node.dataset.shell = '1'
          // 流光两态：进场旋 2 秒表明"刚生成"，之后静置——持续流动在驾驶环境是注意力噪音
          node.classList.add('fresh')
          setTimeout(() => node.classList.remove('fresh'), 2200)
        }
        node.querySelector('.cvtitle')!.textContent = c.title ?? ''
        renderCanvasAppCard(node, c)
      }
      else if (c.template === 'canvas') {
        /**
         * mount/fill：骨架建一次，之后只填。之前每次 sig 变都整刷 innerHTML，
         * cvhost（和它的 Shadow root）被反复摧毁重建。
         */
        if (!node.dataset.shell) {
          // 角标是诚实标注：这张卡是临场生成的，跟固定模板不是一回事
          node.innerHTML = `<h3><span class="ico">${TPL_ICONS.canvas}</span><span class="cvtitle"></span>` +
            `<span class="genmark">生成式</span></h3><div class="bd"><div class="cvhost"></div></div>`
          node.dataset.shell = '1'
          node.classList.add('fresh')
          setTimeout(() => node.classList.remove('fresh'), 2200)
        }
        node.querySelector('.cvtitle')!.textContent = c.title ?? ''
        renderCanvasCard(node, c)
      }
      else {
        /**
         * mount/fill：骨架（h3 + .bd）建一次，数据变了只重填 .bd 的**内容**。
         * .bd 元素身份稳定是触控的前置——它是将来的滚动容器，
         * 整卡 innerHTML 重刷会把 scrollTop 和按压态一起清零。
         * （.bd 认领剩余高度让内容贴底——诊断 1 的修法不变）
         */
        if (!node.dataset.shell) {
          // 40px 身份图标块：远看一眼定位卡片类型——视觉稿有、上一版漏掉的锚点
          node.innerHTML = `<h3><span class="ico">${TPL_ICONS[c.template] ?? TPL_ICONS.generic}</span>` +
            `<span class="ttl"></span></h3><div class="bd"></div>`
          node.dataset.shell = '1'
        }
        node.querySelector('.ttl')!.textContent = c.title ?? ''
        node.querySelector('.bd')!.innerHTML = cardBody(c)
        // 车身图形是资源不是逻辑，留在这里填进 render 层给的占位
        const slot = node.querySelector('.vehslot')
        if (slot) slot.innerHTML = CAR_SVG
      }
      node.dataset.sig = sig
    }
    // 右上角控制簇（缩放/关闭，2026-08-13 实拍反馈）：跟模板无关的通用桌面
    // 管理动作，挂在所有模板分支之外一次——不用每个模板的挂载代码都抄一遍。
    // data-act 走既有的通用手势分发（tap → 命中 [data-act] → userAction），
    // 这里不需要单独绑 click
    if (!node.querySelector('.cardctl')) {
      const closable = !!routeOf(c.template, 'tap:close')
      const ctl = document.createElement('div')
      ctl.className = 'cardctl'
      ctl.innerHTML = `<span class="cbtn" data-act="tap:shrink">−</span>` +
        `<span class="cbtn" data-act="tap:grow">＋</span>` +
        (closable ? `<span class="cbtn cclose" data-act="tap:close">✕</span>` : '')
      node.appendChild(ctl)
    }
    node.querySelector('[data-act="tap:shrink"]')?.classList.toggle('off', c.canShrink === false)
    node.querySelector('[data-act="tap:grow"]')?.classList.toggle('off', c.canGrow === false)
  }
  // 占位虚线框曾按基准卡大小画过 6 块，产品拍板删掉——壁纸本身就是"空"，
  // 虚线框反而让空桌面像张没画完的表格

  // 卡片被移除时（不再出现在新状态里），才真正清掉对应 DOM 节点
  for (const [id, node] of cardNodes) {
    if (!seen.has(id)) {
      // 播放器卡**真的消失**才停声。下台进等位区不算消失——设计不变量是
      // 「播放器被挤掉后歌还在放」，在这里停的话 store 的 playing 仍是 true，
      // 模型和规则都以为在播放，用户却只听到寂静（召回后还会从 0 秒重播）
      if (!stagedIds.has(id) && node.classList.contains('tpl-media')) player.stop()
      // 退场：先缩到 .94 再淡出，动画结束才真正移除节点。
      // 直接 remove 的话卡片是"啪"地不见的，用户不知道刚才那儿有过东西
      cardNodes.delete(id)
      // 下台（进了等位区）滑向右缘；真消失才缩淡——两个方向两种含义
      node.classList.add(stagedIds.has(id) ? 'tostage' : 'leaving')
      node.addEventListener('animationend', () => node.remove(), { once: true })
      setTimeout(() => node.remove(), 400)   // 动画被打断（切标签页）时的兜底
    }
  }
  prevStagedIds = stagedIds

  // FLIP 收尾：位置真变了的卡片滑过去，不是瞬移
  if (moves.length) commitMoves(moves, stageScale)

  const ov = $('overlay')
  if (deskState.overlay) {
    const o = deskState.overlay
    // 覆盖层有两种：full 档的内容卡，和放不下的 critical 告警。
    // 视觉要分开——一张全屏能力目录跟一条「车门没关」不该长得一样
    const alert = o.data?.urgency === 'critical' || (o as any).urgency === 'critical'
    ov.className = `on${alert ? ' alert' : ''}`
    // 指纹护栏：数据没变不重刷。renderDesk 会被频繁调用（车窗过渡每帧一次），
    // 覆盖层每次整刷会摧毁 iframe 里跑着的游戏和滚动位置
    const sig = `${o.id}|${JSON.stringify(o.data)}`
    if (ov.dataset.sig !== sig) {
      ov.dataset.sig = sig
      ov.innerHTML = ''
      // 走跟桌面卡同一套档位类和语义色类，否则 --u 没定义、字号全塌
      const node = document.createElement('div')
      node.className = `card tpl-${o.template} ${tierClass('full')} ${
        accentClass(o.template, { ...o.data, urgency: alert ? 'critical' : o.data?.urgency })}`
      ov.appendChild(node)
      const oc = { ...o, size: 'full' } as CardView
      // ✕：覆盖层是"临时征用"，必须有归还的门。窗口管理直调（overlayClose），
      // 不走交互声明也不叫醒模型——关掉盖在脸上的东西不需要理解成分
      const CLOSE = `<span class="ovclose" data-close="1">✕</span>`
      // canvas / canvas-app 在覆盖层也要走各自的真渲染分支——之前覆盖层只会
      // cardBody() 通用填充，全屏游戏渲染出来是一张空白卡（用户实拍）
      if (o.template === 'canvas-app') {
        node.innerHTML = `<h3><span class="ico">${TPL_ICONS['canvas-app']}</span><span class="cvtitle"></span>` +
          `<span class="genmark">生成式</span>${CLOSE}</h3><div class="bd"></div>`
        node.querySelector('.cvtitle')!.textContent = o.title ?? ''
        renderCanvasAppCard(node as HTMLDivElement, oc)
      } else if (o.template === 'canvas') {
        node.innerHTML = `<h3><span class="ico">${TPL_ICONS.canvas}</span><span class="cvtitle"></span>` +
          `<span class="genmark">生成式</span>${CLOSE}</h3><div class="bd"><div class="cvhost"></div></div>`
        node.querySelector('.cvtitle')!.textContent = o.title ?? ''
        renderCanvasCard(node as HTMLDivElement, oc)
      } else {
        node.innerHTML = `<h3>${esc(o.title)}${CLOSE}</h3><div class="bd">${cardBody(oc)}</div>`
      }
      ;(node.querySelector('.ovclose') as HTMLElement).onclick = () =>
        bus.send({ type: 'overlayClose', cardId: o.id } as any)
    }
  } else { ov.className = ''; ov.innerHTML = ''; delete ov.dataset.sig }

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

// 天气枚举 → 人话/emoji。信号有 6 个枚举值（clear/cloudy/rain/heavyRain/snow/fog），
// 之前这里只认 rain 一个，下雪显示"多云"
const WX_LABEL: Record<string, string> = { clear: '晴', cloudy: '多云', rain: '小雨', heavyRain: '大雨', snow: '雪', fog: '雾' }
const WX_EMOJI: Record<string, string> = { clear: '☀️', cloudy: '☁️', rain: '🌧', heavyRain: '⛈', snow: '❄️', fog: '🌫' }

function renderStatus() {
  // 后台任务芯片：running 数转圈；失败的短暂标警示色。点开出任务列表卡（机制直调）
  const tasks: Array<{ status: string }> = meta.tasks ?? []
  const runningTasks = tasks.filter(t => t.status === 'running')
  const failed = tasks.some(t => t.status === 'failed')
  const tc = $('chipTask')
  tc.style.display = runningTasks.length || failed ? '' : 'none'
  $('taskN').textContent = String(runningTasks.length)
  // 当前动作微字（§6.2 轻层）：大致在干嘛一眼可知，细看点芯片出进展卡
  $('taskCur').textContent = (runningTasks[0] as any)?.current ? ` · ${(runningTasks[0] as any).current}` : ''
  tc.classList.toggle('warn', failed)
  const c = $('chipSpd')
  c.textContent = speedChip(meta.speed, meta.gear)
  c.className = 'chip' + (meta.speed > 100 ? ' warn' : '')
  $('chipLock').style.display = meta.childLock ? '' : 'none'
  $('tOut').textContent = String(Math.round(meta.outTemp))
  $('soc').textContent = String(Math.round(meta.soc))
  const wl = WX_LABEL[meta.weather] ?? '多云'
  $('wx').textContent = `${WX_EMOJI[meta.weather] ?? '☁️'} ${wl}`
}

$('chipTask').onclick = () => bus.send({ type: 'taskChip' } as any)
$('stagedTab').onclick = () => bus.send({ type: 'stagedChip' } as any)

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
 * 进度条自更新。读 <audio> 的 currentTime，**不经过 store 也不经过 bus** ——
 * 它每秒变好几次，进信号系统就是每秒重评一遍全部规则。
 * 只在播放器卡在场时才跑，待机时是零开销。
 */
function tickProgress() {
  requestAnimationFrame(tickProgress)
  const { current, duration } = player.progress()
  const pct = progressPct(current, duration)
  // 规则保证同时只有一张播放器卡，但代码不该赌这个 —— 全部更新
  for (const meta of Array.from(document.querySelectorAll<HTMLElement>('.tpl-media .plbar'))) {
    if (meta.style.display === 'none') continue
    const fl = meta.querySelector('.plfl') as HTMLElement
    const t = meta.querySelector('.pltime') as HTMLElement
    /**
     * 是不是直播由**音源**定（renderPlayerCard 挂的 .live），不由 duration 猜。
     * 用 duration 猜的话，音乐卡在还没开始播时 duration 是 NaN，
     * 屏上就写出「● 直播中」——一首歌被说成直播是硬错。
     */
    const live = meta.classList.contains('live')
    fl.style.width = live ? '100%' : `${pct ?? 0}%`
    t.textContent = live ? `● 直播中 · 已收听 ${fmtTime(current)}`
      : pct === null ? '' : `${fmtTime(current)} / ${fmtTime(duration)}`
  }
}
requestAnimationFrame(tickProgress)

/* ── 消息处理 ── */
/* ══════════ 绘本朗读：读完一页决定下一步 ══════════
 *
 * 决策在 `storyflow.ts` 的纯函数里（车机屏跑不了单测，判断错一次就是
 * "一章讲完卡在最后一页不动"或者"每页都问一遍"）。这里只做两件事：
 * 念出来、把结论发上总线。**车机屏只报事实**（这一章读完了），
 * 问什么话归模型 —— 跟 mediaEvent 只上报设备事实不上报决定是同一条边界。
 */
let sbSpoken = ''
/**
 * 中文音色。`getVoices()` **第一次调用常常是空的**（音色异步加载），
 * 所以既要在 voiceschanged 时补挑一次，也要在每次开口前再试一次。
 */
let sbVoice: SpeechSynthesisVoice | undefined
/**
 * 家长在控制面板里挑的音色。两个窗口同源，走 localStorage 传 ——
 * 比给 bus 加一类消息省得多，而且 `storage` 事件天然跨窗口。
 */
const VOICE_KEY = 'cockpit-sim:tts:voice'
const refreshVoice = () => {
  try {
    sbVoice = pickVoice(speechSynthesis.getVoices() as any,
      { name: localStorage.getItem(VOICE_KEY) || undefined }) as any
  } catch { /* 没有就算了 */ }
}
if ('speechSynthesis' in window) {
  refreshVoice()
  speechSynthesis.addEventListener?.('voiceschanged', refreshVoice)
  // 面板里换了音色立刻生效，不用刷新车机屏
  addEventListener('storage', e => { if (e.key === VOICE_KEY) refreshVoice() })
}

/**
 * 语速。voice.config 和控制面板写 localStorage，这里读 ——
 * 坏值/没设过退回 0.92（跟原常量一致）。
 */
const RATE_KEY = 'cockpit-sim:tts:rate'
const sbRate = () => {
  const r = Number(localStorage.getItem(RATE_KEY))
  return Number.isFinite(r) && r >= 0.5 && r <= 1.5 ? r : .92
}
/** 念完之后的兜底余量。语速估不准是常态，宁可多等一会儿也别提前翻页 */
const SB_SLACK_MS = 2500

/**
 * 朗读的世代戳。**取消语义**（四条纪律第 3 条）：
 * `speechSynthesis.cancel()` 会让上一句的 `onend` 照样触发，而那个回调里带着
 * "读完了该翻页"的副作用 —— 用户手动点一下下一页，就会连翻两页。
 * 作废的那一轮必须连副作用一起作废，不是只停止等待。
 */
let sbGen = 0
/**
 * 正在等图。**`wait` 不能是死路** —— 实拍看到讲完第一页就停住了：
 * afterRead 说"等图画完再翻"，然后没有任何东西负责"等好了再问一次"。
 * 图落地会刷新卡片（handler 每补一张就 paint 一次），借那次刷新重新决策。
 */
let sbWaiting: { line: string; since: number; retry: ReturnType<typeof setTimeout> } | null = null
const stopWaiting = () => { if (sbWaiting) clearTimeout(sbWaiting.retry); sbWaiting = null }

/** 这一页读完了该干嘛 —— 决策在 storyflow 的纯函数里，这里只发结论 */
function decideNext(c: any, line: string) {
  const d = c?.data ?? {}
  const next = afterRead({
    page: Number(d.page) || 0, chapterEnd: Number(d.chapterEnd) || 0,
    total: Number(d.total) || 0, phase: String(d.phase ?? 'telling'),
    pending: Number(d.pending) || 0,
    waited: sbWaiting?.line === line ? Date.now() - sbWaiting.since : 0,
  })
  if (next.do === 'wait') {
    if (sbWaiting?.line === line) return       // 已经在等了，别把计时重置
    // 图落地会刷新卡片、借那次刷新重新问；但图永远不来（断网、没额度）时
    // 也得有人叫醒 —— 到上限自己再问一次，那时 afterRead 会放行
    sbWaiting = { line, since: Date.now(), retry: setTimeout(() => decideNext(c, line), WAIT_MAX_MS + 200) }
    return
  }
  stopWaiting()
  if (next.do === 'advance')
    bus.send({ type: 'userAction', cardId: c.id, act: 'tap:next' } as any)
  else if (next.do === 'ask')
    setTimeout(() => bus.send({ type: 'storyChapterDone', chapter: Number(d.chapter) || 0 } as any), next.delay)
}

/**
 * 正在等**本页**的图。跟 `sbWaiting`（等下一页的图）不是一回事：
 * 那个决定"翻不翻页"，这个决定"张不张嘴"。
 */
let sbPending: { line: string; since: number; retry: ReturnType<typeof setTimeout> } | null = null
const stopPending = () => { if (sbPending) clearTimeout(sbPending.retry); sbPending = null }

function speakStory(node: HTMLElement, c: any) {
  const d = c?.data ?? {}
  const line = String(d.line ?? '')
  if (!line) return
  // 同一句话不重念，但**要借这次刷新把"等图"重新问一遍**（图刚落地就是这条路）
  if (line === sbSpoken) {
    if (sbWaiting?.line === line) decideNext(c, line)
    return
  }

  /**
   * **本页的图没到就先别开口**（2026-08-14 实拍：「图片没生成好就开始讲故事，
   * 等图片生成好这个故事都讲完了」）。绘本的画面和声音必须对上 ——
   * 对不上它就只是一本有声书。图落地会刷新卡片，借那次刷新再问一次。
   */
  const ready = beforeRead({
    hasImage: !!d.image, pending: Number(d.pending) || 0, phase: String(d.phase ?? 'telling'),
    waited: sbPending?.line === line ? Date.now() - sbPending.since : 0,
  })
  if (ready.do === 'wait') {
    if (sbPending?.line !== line) {
      stopPending()
      // 图永远不来（断网、没额度）时也得有人叫醒 —— 到点自己再问一次
      sbPending = { line, since: Date.now(), retry: setTimeout(() => speakStory(node, c), IMG_WAIT_MS + 200) }
    }
    return
  }
  stopPending()

  sbSpoken = line
  stopWaiting()
  const gen = ++sbGen
  const el = () => node.querySelector('.sbline')

  let done = false
  const finish = () => {
    if (done) return
    done = true
    clearInterval(timer); clearTimeout(guard)
    if (gen !== sbGen) return          // 已经被下一页接管了，副作用一起作废
    storyReading = false               // 麦克风还给主对话
    const t = el(); if (t) t.textContent = line
    decideNext(c, line)
  }

  /**
   * 逐字点亮。**中文得靠时间推** —— `onboundary` 在中文上基本不发事件，
   * 而这是整个产品最讨喜的一秒（孩子跟着字读）。边界事件来了就用它（更准），
   * 不来就按估算的时长匀速推进。
   */
  const rate = sbRate()
  let totalMs = estimateMs(line, rate)
  const t0 = Date.now()
  let byBoundary = false
  const paintLit = (n: number) => {
    const t = el(); if (!t) return
    t.innerHTML = `<span class="lit">${esc(line.slice(0, n))}</span>${esc(line.slice(n))}`
  }
  const timer = setInterval(() => {
    if (byBoundary || done) return
    paintLit(litUpto(line.length, Date.now() - t0, totalMs))
  }, 90)

  /**
   * **朗读整个失灵也不能把故事卡死**。没有中文音色、自动播放被拦、
   * 内核不发 onend —— 任何一条都会让 `onend` 永远不来，而实拍看到的
   * 就是"只讲了一页，也不翻页"。到点了自己往下走。
   */
  let guard = setTimeout(finish, totalMs + SB_SLACK_MS)

  const speakLocal = () => {
    if (gen !== sbGen || !('speechSynthesis' in window)) return
    try { speechSynthesis.cancel() } catch { /* 没说话时 cancel 在个别内核会抛 */ }
    const u = new SpeechSynthesisUtterance(line)
    u.lang = 'zh-CN'; u.rate = rate
    if (!sbVoice) refreshVoice()
    // 挑不到中文音色时不硬塞：留空让引擎按 lang 自己决定，比拿英文音色念中文强
    if (sbVoice) u.voice = sbVoice
    u.onboundary = (ev: any) => {
      byBoundary = true
      paintLit((ev.charIndex || 0) + (ev.charLength || 1))
    }
    u.onend = finish
    u.onerror = finish              // 念不出来也要往下走，不是卡住
    storyReading = true             // 正文占麦：Agent 的衔接话术这段时间只上屏不出声
    speechSynthesis.speak(u)
  }

  /**
   * 云端音色（讯飞超拟人）：合成整段 mp3 再播。逐字点亮继续按时间推，
   * 拿到真实时长后把 totalMs / 兜底 guard 校准成实际长度 ——
   * 估算的短、云端的长，不校准会念到一半被 guard 翻页。
   * 合成本身要等一会儿，guard 先放宽；任何一步失败回退本地音色。
   */
  const chosen = chosenVoice()
  if (isCloudVoice(chosen) && xfReady()) {
    storyReading = true
    sbAudio?.pause(); sbAudio = null
    clearTimeout(guard); guard = setTimeout(finish, totalMs + SB_SLACK_MS + 9000)
    const rearm = (ms: number) => { totalMs = ms; clearTimeout(guard); guard = setTimeout(finish, ms + SB_SLACK_MS) }
    const local = () => { if (gen === sbGen && !done) { rearm(estimateMs(line, rate)); speakLocal() } }
    xfSynthesize(XF_CREDS, xfVcn(chosen), line, rate)
      .then(blob => {
        if (gen !== sbGen || done) return
        const a = new Audio(URL.createObjectURL(blob))
        sbAudio = a
        a.onloadedmetadata = () => {
          if (gen === sbGen && Number.isFinite(a.duration) && a.duration > 0) rearm(a.duration * 1000)
        }
        a.onended = () => { URL.revokeObjectURL(a.src); finish() }
        a.onerror = local
        a.play().catch(local)
      })
      .catch(local)
    return
  }
  speakLocal()
}
/** 绘本的云端音频句柄：新页开讲前停掉上一页的 */
let sbAudio: HTMLAudioElement | null = null

/* ══════════ 主对话话术的 TTS（2026-08-16 实拍：「文字没有播报」） ══════════
 *
 * speechSynthesis 以前只给绘本接了。念不念的决策在 voiceAct（纯函数配测试），
 * 这里只张嘴。音色/语速与绘本共用同一份选择（面板下拉框那份）。
 * 取消要连副作用一起作废（世代戳）——跟绘本那次踩坑同一条纪律。
 */
let storyReading = false
let agGen = 0
/**
 * 讯飞云端音色（超拟人）。Key 走 .env.local，没配就永远走本地 ——
 * 云端挂了（断网/超时/额度）也回退本地音色，话不能不说。
 */
const XF_CREDS = {
  appId: String((import.meta as any).env?.VITE_XFYUN_APPID ?? ''),
  apiKey: String((import.meta as any).env?.VITE_XFYUN_API_KEY ?? ''),
  apiSecret: String((import.meta as any).env?.VITE_XFYUN_API_SECRET ?? ''),
}
const xfReady = () => !!(XF_CREDS.appId && XF_CREDS.apiKey && XF_CREDS.apiSecret)
const chosenVoice = () => localStorage.getItem(VOICE_KEY) || ''

let agAudio: HTMLAudioElement | null = null
function speakAgent(text: string) {
  const gen = ++agGen
  agAudio?.pause(); agAudio = null
  const chosen = chosenVoice()
  if (isCloudVoice(chosen) && xfReady()) {
    agSpeaking = true
    xfSynthesize(XF_CREDS, xfVcn(chosen), text, sbRate())
      .then(blob => {
        if (gen !== agGen) return   // 已被 hush/下一句接管，作废
        const a = new Audio(URL.createObjectURL(blob))
        agAudio = a
        const done = () => { if (gen === agGen) agSpeaking = false; URL.revokeObjectURL(a.src) }
        a.onended = done
        a.onerror = () => speakAgentLocal(text, gen)
        a.play().catch(() => speakAgentLocal(text, gen))
      })
      .catch(() => speakAgentLocal(text, gen))
    return
  }
  speakAgentLocal(text, gen)
}
function speakAgentLocal(text: string, gen: number) {
  if (gen !== agGen || !('speechSynthesis' in window)) return
  try { speechSynthesis.cancel() } catch { /* 没说话时 cancel 在个别内核会抛 */ }
  const u = new SpeechSynthesisUtterance(text)
  u.lang = 'zh-CN'; u.rate = sbRate()
  if (!sbVoice) refreshVoice()
  if (sbVoice) u.voice = sbVoice as any
  const done = () => { if (gen === agGen) agSpeaking = false }
  u.onend = done; u.onerror = done
  agSpeaking = true
  speechSynthesis.speak(u)
}
let agSpeaking = false
/** 用户开口 → Agent 闭嘴。只在确实是 Agent 在说时才 cancel，别误伤绘本正文 */
function hushAgent() {
  if (!agSpeaking) return
  agGen++; agSpeaking = false
  agAudio?.pause(); agAudio = null
  try { speechSynthesis.cancel() } catch { /* 同上 */ }
}

const bus = createBus((m: BusMsg | any) => {
  connected()
  switch (m.type) {
    case 'state':
      Object.assign(tgt, m.target); meta = { ...meta, ...m.meta }; renderStatus(); break
    case 'cards':
      deskState = m.desk; renderDesk(); break
    case 'voice': {
      if (m.s) setVoice(m.s); if ('text' in m) setSub(m.text, m.who)
      const act = voiceAct(m, storyReading)
      if (act === 'speak') speakAgent(m.text)
      else if (act === 'hush') hushAgent()
      break
    }
    case 'highlight':
      hotWindows = m.ids ?? []
      hotCards = new Set(m.cards ?? [])
      renderDesk()
      setTimeout(() => { hotWindows = []; hotCards = new Set(); renderDesk() }, 2000)
      break
    case 'banner':
      if (!m.on) { banners.clear(); break }
      banners.push({ title: m.title, text: m.desc ?? '', code: (m as any).code, tone: toneOf(m.reason), ttl: m.ttl, jump: m.jump })
      break
  }
})

let ok = false
const connected = () => { if (!ok) { ok = true; $('conn').style.opacity = '0' } }
const hello = () => bus.send({ type: 'hello' })
hello(); setTimeout(hello, 500); setInterval(hello, 4000)

setInterval(() => {
  const d = new Date()
  // 状态栏时钟。时间是遥测不是状态，屏端本地每秒刷，不过 store 不过 bus
  $('clock').textContent = `${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`
}, 1000)
renderStatus(); renderDesk()
