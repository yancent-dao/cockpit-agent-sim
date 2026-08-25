import type { Store } from '../core/store'
import { compare } from '../core/types'
import type { Permission, Value } from '../core/types'
import type { ToolDef, ParamDef } from '../config/tools'
import { CAPABILITY_DOMAINS } from '../config/tools'
import { globMatch } from '../core/glob'
import type { Desk } from '../cards/desk'
import { cellsOfTier } from '../config/grid'
import { CARD_TEMPLATES, COMMON_SIZES, type CardTemplate } from '../config/cards'
import { titleOf, recallHint } from '../cards/summary'
import type { AmapClient } from '../integrations/amap'
import type { ItunesClient } from '../integrations/itunes'
import type { RadioClient } from '../integrations/radio'
import type { NewsClient } from '../integrations/news'
import type { PexelsClient } from '../integrations/pexels'
import type { WebSearchClient } from '../integrations/websearch'
import { createNavHandlers } from '../integrations/navHandlers'
import { createMediaHandlers, CANDIDATES } from '../integrations/mediaHandlers'
import { createStoryHandlers, type ImageGen } from '../integrations/storyHandlers'
import type { StoryStore } from '../state/story'
import type { OpenMeteoClient } from '../integrations/openmeteo'
import type { DomainState } from '../state/domain'
import type { Prefs } from '../state/prefs'
import { createMemoryHandlers } from '../integrations/memoryHandlers'
import { createLifeHandlers } from '../integrations/lifeHandlers'
import type { StockClient } from '../integrations/qtstock'
import type { HolidayClient } from '../integrations/holiday'
import type { PoemClient } from '../integrations/poem'
import type { PodcastClient } from '../integrations/podcast'
import { createGenHandlers } from '../integrations/genHandlers'
import { createAutomationHandlers, type AutomationDeps } from '../integrations/automationHandlers'
import { createTravelHandlers } from '../integrations/travelHandlers'
import type { TravelStore } from '../state/travel'
import type { SourceMap } from '../integrations/travelSources'
import type { VideoGenClient } from '../integrations/orvideo'
import type { MusicGenClient } from '../integrations/ormusic'

/** 统一返回契约。inputRequired 对齐 MCP 2026-07-28 的 MRTR */
export interface ToolResult {
  status: 'ok' | 'rejected' | 'inputRequired' | 'unavailable' | 'failed'
  data?: unknown
  changed?: string[]
  code?: string
  message?: string
  suggestion?: string
  /** MRTR 二次确认令牌 */
  token?: string
}

export interface InvokeCtx {
  confirmToken?: string
  /** Agent 的能力白名单，支持通配 */
  allow?: string[]
  /** 跳过确认（仅供控制面板手动触发使用） */
  force?: boolean
  /** runtime 的调用轮次：同一轮并行工具调用共批（家族机制的批号） */
  round?: number
}

const CONFIRM_TTL = 60_000

export interface RegistryDeps { desk?: Desk; amap?: AmapClient; itunes?: ItunesClient; radio?: RadioClient; news?: NewsClient; pexels?: PexelsClient; websearch?: WebSearchClient; state?: DomainState; prefs?: Prefs; story?: StoryStore; image?: ImageGen; lyrics?: (artist: string, track: string, durationSec?: number) => Promise<string | null>
  /** 常用地址等小件的持久化口。浏览器传 localStorage，测试传假的 */
  storage?: { get(k: string): string | null; set(k: string, v: string): void }
  /**
   * 这台机器上可选的朗读音色。清单在浏览器手里（speechSynthesis），
   * registry 在 node 测试里没有它 —— 按 Fetcher 的老办法注入。
   */
  voices?: () => Array<{ name: string; female?: boolean }>
  /** Open-Meteo 天气（2026-08-15 换源）。缺省时 weather.query 走高德老路 */
  openmeteo?: OpenMeteoClient
  /** 生活资讯三件套（2026-08-18，零 Key）：腾讯行情 / timor 节假日 / 今日诗词 */
  stocks?: StockClient
  holiday?: HolidayClient
  poem?: PoemClient
  /** 播客 RSS 直取（只实时流播）。发现走 itunes.searchPodcasts */
  podcast?: PodcastClient
  /** 旅行助手（长时任务）：任务仓 + 各类监控项的数据源表 */
  travel?: TravelStore
  travelSources?: SourceMap
  /** 行程逐日天气（v3）：城市 → 16 天预报。装配层组（geocode + Open-Meteo） */
  travelWeather?: (city: string, days: number) => Promise<Array<{
    date: string; weather: string; hi: number; lo: number }>>
  /** OpenRouter 生成式媒体（与绘本插图同一个 Key 同一个账本） */
  orvideo?: VideoGenClient
  ormusic?: MusicGenClient
  /** 自动化任务：规则仓 + 装配层执行器（设计 2026-08-18-automation-design.md） */
  automation?: AutomationDeps
  /** 工具执行超时（默认 60s）。任何 handler 悬挂都在限时内变 failed——一次挂起的
   *  fetch 不许冻住整个任务（实拍：联网搜索几分钟没反应，进展卡永远转圈） */
  toolTimeoutMs?: number }

export function createRegistry(
  store: Store,
  tools: ToolDef[],
  clock: () => number = Date.now,
  deps: RegistryDeps = {},
) {
  const byName = new Map(tools.map(t => [t.name, t]))
  const tokens = new Map<string, { tool: string; expires: number }>()
  /** 当前轮次。runtime 给就用它的；没给（直调/测试）每次自增——顺序替换语义 */
  let currentRound = 0
  let autoRound = 0
  let seq = 0

  /**
   * 有真实逻辑的 Tool —— 具名 handler 白名单。
   * 允许返回 Promise：接三方真实 API（如高德）本质是网络请求，不能假装同步。
   */
  const needStory = () => {
    if (!deps.story) throw new Error('绘本能力未装配：createRegistry 缺少 story')
    return deps.story
  }
  const needImage = () => {
    if (!deps.image) throw new Error('绘本能力未装配：createRegistry 缺少 image')
    return deps.image
  }

  const handlers: Record<string, (args: any) => ToolResult | Promise<ToolResult>> = {
    getState: args => {
      const snap = store.snapshot()
      if (!args?.paths?.length) return { status: 'ok', data: snap }
      const data: Record<string, Value> = {}
      for (const p of args.paths) if (p in snap) data[p] = snap[p]
      return { status: 'ok', data }
    },
    speak: args => ({ status: 'ok', data: { spoken: args.text }, message: args.text }),
    ask: args => {
      // 问句同步上屏——显示是机制，模型只负责把问题念出来。
      // 但候选列表卡已经在场时（如导航搜索多结果）屏幕上不用再动：
      // 选项在列表里摆着，模型的问句常是一整段，塞进标题反而挤掉列表。
      const candidates = deps.desk?.findByKey(CANDIDATES)
      if (candidates) { /* 屏幕已经在展示候选，不再开卡也不改标题 */ }
      // ttl 用 untilTaskEnd 而非秒数：用户下一句一开口，这问题要么被回答要么被跳过，
      // 卡片就该走。挂满 60 秒是白占位置。
      else autoCard({ key: 'ask', template: 'confirm', size: 'wide', kind: 'system', ttl: 'untilTaskEnd',
        // 标题跟形态走：带选项是"选一个"，开放问题是"说想法"——写「请选择」会误导
        data: { title: args.options?.length ? '请选择' : '想听听你的想法',
          question: args.question, options: args.options ?? [] } })
      return { status: 'ok', data: { asked: args.question, options: args.options }, message: args.question }
    },

    /* ── 能力目录：Tool 按域聚合成"给人看的能力"（CAPABILITY_DOMAINS），
       能力增减仍自动同步——域内工具全下线域才标 off。函数名不许漏给用户
       （实拍："现在感觉像个工程化界面"），管道工具（card/voice）不进目录 ── */
    capabilityList: args => {
      const avail = list()
      const isOff = (t: ToolDef) =>
        t.requires ? store.signals.find(s => s.alias === t.requires)?.equipped === false : false
      const items = CAPABILITY_DOMAINS
        .filter(d => !args?.domain || d.match.includes(args.domain))
        .map(d => {
          const tools = avail.filter(t => d.match.some(m => t.name.startsWith(`${m}.`)))
          return tools.length
            ? { icon: d.icon, label: d.label, desc: d.blurb, off: tools.every(isOff) }
            : null
        })
        .filter((x): x is NonNullable<typeof x> => x !== null)
      // 能力目录是**内容**不是问题，不该定时消失 —— 用户正对着屏念
      // "你还会什么"的时候它自己关掉最气人。挤掉它的应该是下一张卡，不是秒表。
      // 尺寸 1/2 走桌面："你会什么"是内容不是告警，不配盖住整个屏（覆盖层）
      autoCard({ key: 'capabilities', template: 'capability', size: 'court', kind: 'task',
        ttl: 'untilDismissed', data: { title: '我能做的事', items } })
      return { status: 'ok', data: { items } }
    },

    /* ── 卡片调度：把 desk 的结果翻译成统一返回契约 ── */
    cardShow: args => {
      const tmpl = CARD_TEMPLATES.find(t => t.id === args.template)
      if (tmpl?.systemOnly)
        return {
          status: 'rejected', code: 'SYSTEM_TEMPLATE',
          message: `${tmpl.label}由系统按车辆状态自动出，不用你建`,
          suggestion: '需要的话调对应的业务工具（如 navigation.setDestination），卡片会自己出现',
        }
      // 尺寸闸已下沉到 desk（三条建卡路一个闸）；这里只留形状——模型契约在模型入口把关
      const shapeErr = tmpl && checkDataShape(tmpl, args.data ?? {}, { partial: false })
      if (shapeErr) return shapeErr
      return toResult(need().show({
        template: args.template, size: args.size, ttl: parseTtl(args.ttl),
        key: args.key, data: args.data, kind: args.kind, urgency: args.urgency,
      }))
    },
    cardUpdate: args => {
      const card = need().get(args.cardId)
      const tmpl = card && CARD_TEMPLATES.find(t => t.id === card.template)
      const shapeErr = tmpl && checkDataShape(tmpl, args.data ?? {}, { partial: true })
      if (shapeErr) return shapeErr
      return toResult(need().update(args.cardId, args.data))
    },
    // 尺寸闸在 desk（三条建卡路一个闸，见 cards/contract.ts）——这里以前
    // 取出 card/tmpl 却一行没用，注释还宣称"这里也得认"，是段说谎的空壳：
    // 读的人以为闸在 registry，真闸在 desk.resize 里的 resizeGate
    cardResize: args => toResult(need().resize(args.cardId, args.size)),
    // byUser：模型撤卡是在替用户执行"把它收起来"——规则卡被抑制，
    // 不许下一秒被 reconcile 补回（诈尸），直到 watch 信号重新断言
    cardDismiss: args => toResult(need().dismiss(args.cardId, { byUser: true })),
    cardFocus: args => toResult(need().focus(args.cardId)),
    deskLayout: () => {
      const l = need().layout()
      const brief = (c: any) => ({ id: c.id, key: c.key, template: c.template, size: c.size,
        title: titleOf(c) })   // 标题兜底的唯一实现在 cards/summary.ts
      return {
        status: 'ok',
        data: {
          cards: l.cards.map(brief),
          overlay: l.overlay ? brief(l.overlay) : null,
          // 台下排队的卡（2026-08-13）：模型召回要靠这里的 id——
          // 用户说"看天气"时它 focus 这个 id，卡就上台
          staged: (l.staged ?? []).map(brief),
          // 给模型的是"还放得下几张小卡"，不是内部单元数 ——
          // 48 单元下报 16 它没法换算成"能不能再上一张"，只会瞎猜
          // 跟 desk.summary() 用同一个换算 —— 写死数字的话换栅格就是两套账
          slots: Math.floor(l.free / cellsOfTier('box')),
        },
      }
    },

    /**
     * ── 语音配置：音色与语速 ──
     * 写的是跟控制面板音色下拉框**同一个 localStorage key** —— 单一事实，
     * 车机屏靠 storage 事件跨窗口即时生效（先例就是那个下拉框）。
     * 不进信号 store：语音配置不是车辆状态，VSS 里塞 TTS 音色是硬凑。
     */
    /**
     * 壁纸（2026-08-18）。图片内容进 localStorage，信号只写「来源:版本戳」——
     * dataURL 几百 KB，塞进信号会被 bus 全量广播背着走。屏端收到信号变化
     * 再从同源 localStorage 取图。
     */
    wallpaperSet: async (args: any): Promise<ToolResult> => {
      const W = 'cockpit-sim:wallpaper'
      if (args.source === 'none') {
        store.set('hmi.wallpaper', '')
        return { status: 'ok', message: '壁纸恢复默认了' }
      }
      if (args.source === 'preset') {
        if (!args.name) return { status: 'rejected', code: 'INVALID_PARAMS', message: '要选哪张预设？aurora/dusk/forest' }
        store.set('hmi.wallpaper', `preset:${args.name}`)
        return { status: 'ok', message: '壁纸换好了' }
      }
      if (!deps.image) return { status: 'unavailable', code: 'NO_CP', message: '图像生成没配（要 OpenRouter Key）' }
      if (!args.prompt) return { status: 'rejected', code: 'INVALID_PARAMS', message: '要生成什么样的壁纸？' }
      try {
        const g = await deps.image.generate({ prompt:
          `车机桌面壁纸，宽幅横构图，画面简洁留有大面积呼吸空间，避免居中主体和文字：${args.prompt}` })
        if (!g?.dataUrl) return { status: 'failed', code: 'GEN_EMPTY', message: '壁纸没生成出来' }
        deps.storage?.set(W, g.dataUrl)
        store.set('hmi.wallpaper', `custom:${clock().toString(36)}`)
        return { status: 'ok', message: '壁纸画好换上了（约 3 毛）' }
      } catch (e) {
        return { status: 'failed', code: 'GEN_ERROR', message: `壁纸没生成出来：${e instanceof Error ? e.message : e}` }
      }
    },

    voiceConfig: (args: any): ToolResult => {
      if (!deps.voices)
        return { status: 'unavailable', code: 'NOT_WIRED', message: '这个环境里拿不到音色清单，设不了' }
      const voices = deps.voices()
      // 不传任何参数 = 查询。模型先看有什么可选，再替用户挑
      if (args?.voice === undefined && args?.rate === undefined)
        return { status: 'ok', data: {
          current: { voice: deps.storage?.get('cockpit-sim:tts:voice') ?? null,
                     rate: Number(deps.storage?.get('cockpit-sim:tts:rate') ?? 0.92) },
          voices,
        } }
      if (args.voice !== undefined) {
        // 清单外的名字明确拒 —— 写进去一个不存在的音色等于把朗读弄哑
        if (!voices.some(v => v.name === args.voice))
          return { status: 'rejected', code: 'NOT_FOUND',
            message: `没有叫「${args.voice}」的音色`, data: { voices },
            suggestion: '从返回的 voices 里挑一个，名字要一字不差' }
        deps.storage?.set('cockpit-sim:tts:voice', args.voice)
      }
      if (args.rate !== undefined) deps.storage?.set('cockpit-sim:tts:rate', String(args.rate))
      return { status: 'ok', message: '换好了，下一句就用新的' }
    },

    /* ── 导航 + 天气：真实逻辑在 navHandlers.ts，这里只是并进同一张白名单 ── */
    ...createNavHandlers(store, () => needAmap(), () => sizedDesk(), () => currentRound, deps.storage, deps.openmeteo),
    ...createMemoryHandlers(() => deps.prefs, () => sizedDesk()),
    /* ── 路上的故事：真实逻辑在 storyHandlers.ts ── */
    ...createStoryHandlers(store, () => sizedDesk(), () => needStory(), () => needImage()),
    ...createGenHandlers(store, () => deps.orvideo, () => deps.ormusic),
    ...createAutomationHandlers(() => sizedDesk(), () => deps.automation,
      n => tools.some(t => t.name === n),
      validateArgs,
      p => store.signals.find(sg => sg.alias === p)?.label,
      clock),
    ...createTravelHandlers({
      store: () => deps.travel!, desk: () => sizedDesk(),
      sources: () => deps.travelSources ?? {}, clock,
      weather: () => deps.travelWeather,
    }),
    ...createLifeHandlers(() => sizedDesk(), () => deps.stocks, () => deps.holiday, () => deps.poem, clock),
    ...createMediaHandlers(store, () => sizedDesk(), { itunes: () => needCp('itunes'), radio: () => needCp('radio'), podcast: () => needCp('podcast'), news: () => needCp('news'), pexels: () => needCp('pexels'), websearch: () => needCp('websearch'), state: deps.state, lyrics: deps.lyrics }),
  }

  /**
   * 模板已经声明了自己支持哪些尺寸，其中最小的那个就是显示下限——
   * 列表卡缩到 1/6 只剩个标题、选项全丢。统一在这补，不让每个建卡的地方手写。
   */
  const sizedDesk = (): Desk | undefined => {
    const d = deps.desk
    if (!d) return undefined
    return {
      ...d,
      render: (input: Parameters<Desk['render']>[0]) => {
        if (input.minSize) return d.render(input)
        const tmpl = CARD_TEMPLATES.find(t => t.id === input.template)
        const sizes = tmpl ? (tmpl.sizes ?? COMMON_SIZES) : []
        const min = [...sizes].sort((a, b) => d.cellsOf(a as any) - d.cellsOf(b as any))[0]
        return d.render(min ? { ...input, minSize: min as any } : input)
      },
    } as Desk
  }

  const need = (): Desk => {
    if (!deps.desk) throw new Error('卡片能力未装配：createRegistry 缺少 desk')
    return deps.desk
  }
  /** 查询/交互结果自动上屏。desk 未装配或桌面满都不影响 Tool 主流程 */
  const autoCard = (input: Parameters<Desk['render']>[0]) => {
    try { sizedDesk()?.render(input) } catch { /* 显示失败不拖累执行 */ }
  }
  /** 三方能力未装配时给一句人话，而不是让 undefined 一路炸到堆栈里 */
  const needCp = <K extends 'itunes' | 'radio' | 'news' | 'pexels' | 'websearch' | 'podcast'>(k: K): NonNullable<RegistryDeps[K]> => {
    const c = deps[k]
    if (!c) throw new Error(`${k} 能力未装配：createRegistry 缺少 ${k}`)
    return c
  }
  const needAmap = (): AmapClient => {
    if (!deps.amap) throw new Error('高德能力未装配：createRegistry 缺少 amap')
    return deps.amap
  }
  /** ttl 在 schema 里是字符串（模型友好），这里转回内部类型 */
  const parseTtl = (v: any) => {
    if (v === undefined || v === null) return undefined
    const n = Number(v)
    return Number.isFinite(n) && String(v).trim() !== '' ? n : v
  }
  const toResult = (r: any): ToolResult =>
    r.status === 'ok'
      ? { status: 'ok', data: { cardId: r.cardId, ...(r.staged && { staged: true }), ...(r.level && { level: r.level }) },
          ...(r.shrunk && { code: 'CARD_SHRUNK' }),
          // staged 优先于 shrunk 当 code：对模型来说"排队去了"比"变小了"更该知道
          ...(r.staged && { code: 'CARD_STAGED' }),
          ...(r.note ? { message: r.note }
            : r.staged ? { message: `桌面满了，先排在台下，有空位自动显示；想立刻看就${recallHint()}` } : {}) }
      : { status: 'rejected', code: r.code, message: r.message }


  /**
   * 校验 data 是否匹配模板声明的 fields。没声明 fields（如 generic）就放行。
   * partial=true（card.update，局部更新）只查"传了的字段类型对不对"，不强制补全必填；
   * partial=false（card.show，首次创建）必填字段必须都在。
   * 跟 SIZE_NOT_SUPPORTED 一个思路：格式不对也要给可读原因，不能让它悄悄渲染成空白。
   */
  const checkDataShape = (tmpl: CardTemplate, data: Record<string, any>, opts: { partial: boolean }): ToolResult | null => {
    if (!tmpl.fields) return null
    const isType = (v: any, t: string) =>
      t === 'array' ? Array.isArray(v) : t === 'object' ? (typeof v === 'object' && v !== null && !Array.isArray(v)) : typeof v === t
    for (const [key, spec] of Object.entries(tmpl.fields)) {
      const v = data[key]
      if (v === undefined || v === null) {
        if (spec.required && !opts.partial)
          return {
            status: 'rejected', code: 'DATA_SHAPE_MISMATCH',
            message: `${tmpl.label}缺少必填字段 data.${key}（类型应为 ${spec.type}）`,
          }
        continue
      }
      if (!isType(v, spec.type))
        return {
          status: 'rejected', code: 'DATA_SHAPE_MISMATCH',
          message: `${tmpl.label}的 data.${key} 类型不对，应为 ${spec.type}`,
        }
    }
    return null
  }

  const authorized = (name: string, allow?: string[]) =>
    !allow || allow.some(p => globMatch(p, name))

  /**
   * Tool 名对内是点分层级（window.set），对外（LLM 看到的 schema）必须是
   * wire-safe 形式——Anthropic 的 tool.name 校验正则 `^[a-zA-Z0-9_-]{1,128}$`
   * 不接受点号，会直接 400。这里只做点号↔下划线的可逆替换，不改内部命名。
   */
  const wireName = (name: string) => name.replace(/\./g, '_')
  const resolve = (name: string): ToolDef | undefined =>
    byName.get(name) ?? byName.get(name.replace(/_/g, '.'))
  /** 把 provider 可能返回的 wire 形式统一转回内部点号形式，供追踪面板显示 */
  const canonicalName = (name: string) => resolve(name)?.name ?? name

  /** 动态权限：基础等级 + escalate 规则 */
  function permissionOf(name: string): Permission | undefined {
    const t = resolve(name)
    if (!t) return undefined
    let perm = t.permission
    for (const e of t.escalate ?? []) {
      const [path, op, val] = e.when
      if (compare(store.get(path), op, val)) perm = e.to
    }
    return perm
  }

  /**
   * 把声明了 `default` 而这次没传的参数填上。**在校验之前** ——
   * 之后的校验、展开、写入都当它是用户传的，不用每处各判一次。
   */
  function applyDefaults(t: ToolDef, args: Record<string, any>) {
    for (const [key, def] of Object.entries(t.params) as [string, ParamDef][])
      if (def.default !== undefined && (args[key] === undefined || args[key] === null))
        args[key] = def.default
  }

  function validate(t: ToolDef, args: Record<string, any>): string | null {
    // 缺参一次报全（实拍：story.continue 缺 idea 报一个、补了又报缺 pages——
    // 挤牙膏式报错，每个缺参多烧一轮 LLM）
    const missing = (Object.entries(t.params) as [string, ParamDef][])
      .filter(([k, d]) => d.required && (args?.[k] === undefined || args?.[k] === null))
      .map(([k]) => k)
    if (missing.length) return `缺少必填参数 ${missing.join('、')}`
    for (const [key, def] of Object.entries(t.params) as [string, ParamDef][]) {
      let v = args?.[key]
      if (v === undefined || v === null) continue
      if (def.type === 'number') {
        // 宽容数值字符串：实测模型常送 "24"，硬拒等于让用户多等一整轮往返。
        // 宽容不是不校验——转不成数的照拒
        if (typeof v === 'string' && v.trim() !== '' && !Number.isNaN(Number(v))) {
          v = Number(v); args[key] = v
        }
        if (typeof v !== 'number' || Number.isNaN(v)) return `${key} 需要数值`
        if (def.range && (v < def.range[0] || v > def.range[1]))
          return `${key} 需在 ${def.range[0]}~${def.range[1]} 之间`
      }
      if (def.type === 'enum' && !def.values?.includes(v)) return `${key} 不支持取值 ${v}`
      if (def.type === 'boolean' && typeof v !== 'boolean') return `${key} 需要布尔值`
      if (def.type === 'array' && !Array.isArray(v)) {
        // 宽容单元素退化（{item:单对象} 经 unwrapItem 剥壳后就是这个形状，
        // 实拍第三次撞见）：期望数组收到单个对象 → 包成单元素数组。
        // 跟 "24"→24 同族：协议适配不是意图分支，判据只看数据形状
        if (v && typeof v === 'object') { args[key] = [v]; v = args[key] }
        else return `${key} 需要数组`
      }
      if (def.type === 'array' && Array.isArray(v)) {
        // 双层数组退化 [[...]]（实拍：pages:{item:{item:[[…]]}}，unwrapItem
        // 剥完两层 {item} 剩这个形状）——单元素且元素也是数组就剥一层
        while (v.length === 1 && Array.isArray(v[0])) { v = v[0]; args[key] = v }
        /**
         * 元素必填字段校验（2026-08-19 实拍）：items 里声明了 required
         * 却从没执行——模型用 {text,image} 替 {line,scene} 静默入仓，
         * 正文空白上屏、朗读没词可念。报出收到的键，模型才知道怎么改。
         */
        const req: string[] = (def.items as any)?.required ?? []
        if (req.length) for (let i = 0; i < v.length; i++) {
          const el = v[i]
          if (!el || typeof el !== 'object') return `${key}[${i}] 需要对象`
          const miss = req.filter(k2 => el[k2] === undefined || el[k2] === null)
          if (miss.length)
            return `${key}[${i}] 缺少字段 ${miss.join('、')}（收到的键：${Object.keys(el).join('、') || '无'}）`
        }
      }
    }
    return null
  }

  /**
   * 干验证（2026-08-19，自动化的 create 用）：只校验不执行。
   * 比运行时校验**更严**——多查未知参数名：运行时对模型多塞的键宽容
   * （拒了要多等一轮往返），但写进自动任务的错参是定时哑弹，
   * 三点一到才炸远比现在拒掉贵。
   */
  function validateArgs(name: string, args: Record<string, any> = {}): string | null {
    const t = resolve(name)
    if (!t) return `没有 ${name} 这个工具`
    const copy = unwrapItem({ ...args })
    for (const k of Object.keys(copy))
      if (!(k in t.params)) return `没有 ${k} 这个参数（可用：${Object.keys(t.params).join('/')}）`
    applyDefaults(t, copy)
    return validate(t, copy)
  }

  /**
   * 由 writes 声明自动生成的写入逻辑。
   * writes 是数组：climate.set 这类 Tool 一次调用要写多个不同信号，
   * 每条目独立判断对应的 from 字段本次有没有传——没传就跳过，不是必填。
   */
  function applyWrites(t: ToolDef, args: Record<string, any>): ToolResult {
    const jobs: Array<{ path: string; value: Value }> = []

    for (const w of t.writes!) {
      const raw = args[w.from]
      if (raw === undefined || raw === null) continue // 可选字段这次没传，跳过

      // 参数展开：window=all → 四扇。只在路径模板真的用到该占位符时才展开
      let variants: Record<string, any>[] = [args]
      for (const [key, table] of Object.entries(t.expand ?? {})) {
        if (!w.path.includes(`{${key}}`)) continue
        const list = table[args[key]]
        if (list) variants = list.map(v => ({ ...args, [key]: v }))
      }

      const value: Value = w.map ? w.map[String(raw)] : raw
      for (const v of variants)
        jobs.push({ path: w.path.replace(/\{(\w+)\}/g, (_, k) => String(v[k])), value })
    }

    if (!jobs.length)
      return { status: 'rejected', code: 'NO_FIELDS', message: '至少要传一个要修改的字段' }

    // 先全量试算（不写入）：任一被拒则整体拒绝，杜绝部分写入
    for (const { path, value } of jobs) {
      const probe = store.canSet(path, value)
      if (probe.status !== 'ok') return probe as ToolResult
    }

    let code: string | undefined, message: string | undefined
    const changed: string[] = []
    for (const { path, value } of jobs) {
      const r = store.set(path, value)
      changed.push(path)
      if (r.status === 'ok' && r.code) { code = r.code; message = r.message }
    }
    return { status: 'ok', changed, ...(code && { code, message }) }
  }

  /**
   * `{item:[…]}` → `[…]`，递归。
   *
   * 模型把数组序列化成 XML 式的 `<items><item>…</item></items>` 是常见退化，
   * 实拍撞了两次：`story.begin` 的 pages、`card.show` 的 data.items ——
   * 后者**连着重试 9 轮、40 秒、一句话没说**。`card.show` 的 data 是自由对象，
   * schema 管不到里面，只能在这一层收。
   *
   * 跟宽容 `"24"` → 24 是同一类：**协议适配，不是意图分支** ——
   * 判据只看数据形状（对象**只有** item 一个键），不看是哪个工具、什么语义。
   * 多一个键就说明那是真数据，一个字节都不动。
   */
  const unwrapItem = (v: any): any => {
    if (Array.isArray(v)) return v.map(unwrapItem)
    if (!v || typeof v !== 'object') return v
    const keys = Object.keys(v)
    if (keys.length === 1 && keys[0] === 'item') return unwrapItem(v.item)
    const out: Record<string, any> = {}
    for (const k of keys) out[k] = unwrapItem(v[k])
    return out
  }

  async function invoke(name: string, args: Record<string, any> = {}, ctx: InvokeCtx = {}): Promise<ToolResult> {
    currentRound = ctx.round ?? ++autoRound
    args = unwrapItem(args)
    const t = resolve(name)
    if (!t) return { status: 'unavailable', code: 'UNKNOWN_TOOL', message: `没有名为 ${name} 的能力` }
    name = t.name // 归一化成内部点号形式：鉴权白名单、token 绑定都按这个来

    /**
     * 黑闸必须查**动态**权限。以前这里查的是静态 t.permission、下面的灰闸查的是
     * permissionOf()（含 escalate 折算）——一个 escalate 到 '黑' 的工具
     * （类型完全允许，语义即"行驶中彻底禁用"）静态等级不是黑就过了黑闸，
     * 动态等级是黑又 !== '灰' 于是也过了灰闸：最该被禁的状态下反而免确认直接执行。
     * 当前配置只用到 to:'灰' 所以没引爆，但加一条数据就触发——正撞上"加能力=加数据"。
     */
    const level = permissionOf(name)
    if (t.permission === '黑' || level === '黑')
      return t.permission === '黑'
        ? { status: 'unavailable', code: 'BLOCKED', message: `${name} 属于安全禁区，不对 AI 开放` }
        : { status: 'rejected', code: 'FORBIDDEN', message: `当前状态下 ${name} 被禁用`,
            suggestion: '等条件变了再试' }

    if (!authorized(name, ctx.allow))
      return { status: 'unavailable', code: 'NOT_AUTHORIZED', message: `当前 Agent 无权调用 ${name}` }

    applyDefaults(t, args)      // 填缺省值：在校验之前，之后各环节都当它是用户传的
    const bad = validate(t, args)
    if (bad) return { status: 'rejected', code: 'INVALID_PARAMS', message: bad }

    // ── MRTR 二次确认 ──
    // token 既可由 ctx 传入（程序化调用），也可由模型作为 confirmToken 参数回传（标准 MRTR）
    // 空字符串按未提供处理：部分模型会主动补一个空的 confirmToken
    const supplied = ctx.confirmToken || (args.confirmToken as string | undefined) || undefined
    if (level === '灰' && !ctx.force) {
      const tk = supplied && tokens.get(supplied)
      const valid = tk && tk.tool === name && tk.expires > clock()
      if (!valid) {
        const token = `ct_${(++seq).toString(36)}_${clock().toString(36)}`
        // 顺手清掉过期的：只在成功消费时 delete 的话，Map 在长会话里无界增长，
        // pendingConfirm 每次还要全量扫一遍
        for (const [k, v] of tokens) if (v.expires <= clock()) tokens.delete(k)
        tokens.set(token, { tool: name, expires: clock() + CONFIRM_TTL })
        const message = t.confirmPrompt ?? `即将执行 ${name}，确认吗？`
        // 确认卡自动上屏（需求书 §4.5 P0 模板）——用户在屏上能看到自己在确认什么。
        // ttl 用 untilTaskEnd：Agent 可能看完 message 直接决定拒绝（行驶中开门就是），
        // 那这张卡就是孤儿，语音在说"不行"、屏幕在问"确认吗"。用户下一句一开口就该散
        autoCard({ key: 'confirm', template: 'confirm', size: 'wide', kind: 'system',
          ttl: 'untilTaskEnd',
          data: { title: '需要确认', question: message, options: ['确认', '取消'] } })
        return { status: 'inputRequired', code: 'CONFIRM_REQUIRED', message, token }
      }
      tokens.delete(supplied!) // 一次性
      // 确认完成，确认卡使命结束
      const c = deps.desk?.findByKey('confirm')
      if (c) deps.desk!.dismiss(c.id)
    }

    try {
      if (t.writes) return applyWrites(t, args)
      const h = t.handler && handlers[t.handler]
      if (h) {
        // 通用超时闸：CP 各自的超时是第一道，这里是最后一道
        const ms = deps.toolTimeoutMs ?? 60_000
        let timer!: ReturnType<typeof setTimeout>
        const timeout = new Promise<ToolResult>(res => {
          timer = setTimeout(() => res({
            status: 'failed', code: 'TOOL_TIMEOUT',
            message: `${name} 超过 ${Math.round(ms / 1000)} 秒没有响应，已放弃`,
            suggestion: '稍后再试一次',
          }), ms)
        })
        const r = await Promise.race([Promise.resolve(h(args)), timeout])
        clearTimeout(timer)
        return r
      }
      return { status: 'failed', code: 'NO_HANDLER', message: `${name} 尚未实现` }
    } catch (e) {
      return { status: 'failed', code: 'HANDLER_ERROR', message: String(e) }
    }
  }

  const list = (allow?: string[]) =>
    tools.filter(t => t.permission !== '黑' && authorized(t.name, allow))

  const jsonType = (d: ParamDef) =>
    d.type === 'enum' ? 'string' : d.type === 'array' ? 'array' : d.type

  function schemas(format: 'openai' | 'anthropic' | 'mcp' = 'openai', allow?: string[]): any[] {
    return list(allow).map(t => {
      const properties: Record<string, any> = {}
      const required: string[] = []
      for (const [k, d] of Object.entries(t.params)) {
        properties[k] = { type: jsonType(d), description: d.desc }
        if (d.values) properties[k].enum = d.values
        // items 可以是类型名（老写法）也可以是一整段 JSON Schema（数组装对象时）
        if (d.items) properties[k].items = typeof d.items === 'string' ? { type: d.items } : d.items
        if (d.required) required.push(k)
      }
      // 可能需要二次确认的 Tool，把 MRTR 令牌作为显式参数暴露给模型，
      // 这样运行时不需要判断"用户是否在确认" —— 保持代码零意图分支
      if (t.permission === '灰' || t.escalate?.some(e => e.to === '灰'))
        properties.confirmToken = {
          type: 'string',
          description: '二次确认令牌。首次调用不要传；若返回 CONFIRM_REQUIRED，在用户明确同意后用返回的 token 再次调用本工具。',
        }
      const parameters = { type: 'object', properties, required }
      const name = wireName(t.name)
      if (format === 'openai')
        return { type: 'function', function: { name, description: t.desc, parameters } }
      if (format === 'anthropic')
        return { name, description: t.desc, input_schema: parameters }
      return { name, description: t.desc, inputSchema: parameters }
    })
  }

  /**
   * 工具目录：一行一工具的速览，常驻慢层 system 代替全量 schema（省 ~85% token）。
   * 目录 = 非黑、非 meta、有 brief 的工具——由数据自动生成，加工具目录自己长。
   */
  /**
   * 工具目录（每个工具一行 brief）。注册表的纯投影，整个会话内不变，
   * 却在每轮 LLM 调用前被重拼一次（~50 个工具的字符串拼接 × 每轮）。
   * 按 allow 白名单缓存——白名单本身在一次会话里只有寥寥几种组合。
   */
  const catalogCache = new Map<string, string>()
  const briefCatalog = (allow?: string[]) => {
    const key = allow ? allow.join(',') : '*'
    let v = catalogCache.get(key)
    if (v === undefined) {
      v = list(allow)
        .filter(t => !t.meta && t.brief)
        .map(t => `- ${t.name}: ${t.brief}`)
        .join('\n')
      catalogCache.set(key, v)
    }
    return v
  }

  /**
   * 一组工具声明会读写哪些信号（writes 路径展开占位符 + requires）。
   * 状态注入按这个裁剪：挂了车窗工具就注入车窗信号，50 行 → ~12 行。
   */
  function signalsFor(names: string[]): string[] {
    const out = new Set<string>()
    for (const n of names) {
      const t = resolve(n)
      if (!t) continue
      if (t.requires) out.add(t.requires)
      for (const w of t.writes ?? []) {
        const m = w.path.match(/\{(\w+)\}/)
        if (!m) { out.add(w.path); continue }
        // 占位符按参数枚举展开；expand 的别名（all）指向的是已有枚举值，跳过即可
        const p = t.params[m[1]]
        const expandKeys = new Set(Object.keys(t.expand?.[m[1]] ?? {}))
        for (const v of p?.values ?? [])
          if (!expandKeys.has(v)) out.add(w.path.replace(m[0], v))
      }
    }
    return [...out]
  }

  /**
   * 是否有未过期的 MRTR 确认在等用户答复。过滤器架构下用户的"确认/算了"
   * 必须直达慢层（快层不知道有确认在挂着，接了必错）——这是状态分支不是意图分支。
   */
  const pendingConfirm = (): { tool: string } | null => {
    for (const [, t] of tokens) if (t.expires > clock()) return { tool: t.tool }
    return null
  }

  /**
   * 作废所有待确认。用户放弃了这次确认（说"算了"、开口聊别的）就该立刻清掉——
   * 不清的话那个未过期的 token 会继续劫持输入路由满 60 秒：pipeline 见到
   * pending 就跳过快层直送慢层，用户会觉得"怎么突然每句话都变慢了"。
   */
  const clearConfirms = () => tokens.clear()

  return { list, schemas, invoke, permissionOf, canonicalName, tools, briefCatalog, signalsFor, pendingConfirm, clearConfirms }
}

export type Registry = ReturnType<typeof createRegistry>
