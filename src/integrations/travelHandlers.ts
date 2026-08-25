/**
 * 旅行助手七工具的 handlers（2026-08-20）。
 *
 * 机制归这里：校验 → 写仓 → 采样 → 上卡 → 人话回执。
 * **决策归模型**：建不建任务、盯什么、到价了该不该劝用户下手，一个都不在这。
 * 这里连一句"用户说了什么"的解析都没有——有测试盯着。
 *
 * 跟 automationHandlers 同构：handler 不碰 pipeline，采样的定时器在装配层。
 */
import type { Desk } from '../cards/desk'
import type { ToolResult } from '../tools/registry'
import type { TravelStore, TravelWatch, WatchKind } from '../state/travel'
import { analyze } from '../core/trend'
import { sampleRound, type SourceMap, type PriceQuote } from './travelSources'

export interface TravelDeps {
  store: () => TravelStore
  desk: () => Desk | undefined
  sources: () => SourceMap
  clock: () => number
  /** 逐日天气（v3）：城市 → 16 天预报。没装配就没有天气，行程照常 */
  weather?: () => ((city: string, days: number) => Promise<Array<{
    date: string; weather: string; hi: number; lo: number }>>) | undefined
}

const TRIP_KEY = 'travel-trip'
const trendKey = (watchId: string) => `travel-trend:${watchId}`

/** 建任务要的关键项。缺了照建（待定态），但要在返回里说清缺什么 */
const REQUIRED_SOON = ['departDate'] as const

const KIND_LABEL: Record<WatchKind, string> = {
  flight: '机票', hotel: '酒店', fx: '汇率', news: '新闻',
}

/** 各类的默认采样节奏。是**数据**——改节奏改这张表，不改调度器 */
const DEFAULT_RHYTHM: Record<WatchKind, { everyMs?: number; onBoot?: boolean }> = {
  flight: { everyMs: 3_600_000, onBoot: true },
  hotel: { everyMs: 3_600_000, onBoot: true },
  fx: { everyMs: 86_400_000, onBoot: true },
  news: { everyMs: 86_400_000 },
}

let seq = 0
const newId = (p: string) => `${p}${++seq}_${Math.random().toString(36).slice(2, 6)}`

/**
 * 内核。两个出口共用它——**采样与建卡只有一份代码**：
 *   · createTravelHandlers → 给 registry 的七个 handler
 *   · createTravelEngine   → 给装配层的定时采样（只采到期的那几项，
 *     不是每次全采：机酒的免费额度很小，多采一次就少一次）
 */
function core(deps: TravelDeps) {
  const S = () => deps.store()

  /** 一条委托的趋势事实。**只有事实，没有推荐**——买不买归模型 */
  const factsOf = (w: TravelWatch) => {
    const now = deps.clock()
    return analyze(S().samples(w.id, now), w.lastValue,
      { threshold: w.threshold, direction: w.direction })
  }

  /** 各类的单位。光秃秃一个 1850 谁也不知道是钱还是韩元 */
  const UNIT: Record<WatchKind, (v: number) => string> = {
    flight: v => `¥${v.toLocaleString()}`,
    hotel: v => `¥${v.toLocaleString()} / 晚`,
    fx: v => `100 CNY ≈ ${v.toLocaleString()}`,
    news: v => `${v} 条`,
  }

  /** 距出发还有几天。没定日期就没有 D-day——不编一个 */
  const ddayOf = (departDate?: string): string | undefined => {
    if (!departDate) return undefined
    const days = Math.ceil((Date.parse(departDate + 'T00:00:00') - deps.clock()) / 86_400_000)
    return Number.isFinite(days) ? (days > 0 ? `D-${days}` : days === 0 ? '今天出发' : '已出发') : undefined
  }

  /**
   * 融合旅行卡 = f(仓)（2026-08-25，替代 itinerary 的 paintPlan）。
   * 一张卡 = 一次旅行的家：攻略 / 盯价 / 到价同 key 原地生长，阶段判据
   * 全是数据形状——有 days 画轮播，有监控画价格块，有 fired 画决策条。
   *
   * render() 同 key 是**合并**语义，所以会消失的字段（decide/flight/stays/
   * dayIdx）每次都显式给值（undefined 也算给）——绘本定妆照残留的教训。
   */
  const paintTrip = () => {
    const d = deps.desk()
    if (!d) return
    const tasks = S().tasks().filter(t => t.status !== 'archived')
    if (!tasks.length) { const c = d.findByKey(TRIP_KEY); if (c) d.dismiss(c.id); return }
    const t = tasks[tasks.length - 1]                      // 最新的那次旅行是主角
    const ws = S().watches().filter(w => w.taskId === t.id && w.status !== 'cancelled')
    const alive = ws.filter(w => w.status === 'active' || w.status === 'fired')
    const flightW = alive.find(w => w.kind === 'flight')
    const hotelWs = alive.filter(w => w.kind === 'hotel')
    // 到价的那条 → 决策条。只挑一条：两个决策一起问，用户不知道先答哪个
    const hit = alive.find(w => w.status === 'fired')
    const now = deps.clock()
    const flight = flightW ? {
      label: `机票 · ${flightW.label}`,
      text: flightW.lastValue !== undefined ? UNIT.flight(flightW.lastValue) : '等第一次取数',
      delta: factsOf(flightW).changeFromPrev,
      points: S().samples(flightW.id, now).map(x => x.value),
    } : undefined
    const stays = hotelWs.length ? hotelWs.map(w => ({
      label: w.stay ? `${w.stay.city}` : w.label,
      range: w.stay ? `D${w.stay.dayFrom}–${w.stay.dayTo}` : '',
      text: w.lastValue !== undefined ? UNIT.hotel(w.lastValue) : '等第一次取数',
      delta: factsOf(w).changeFromPrev,
      points: S().samples(w.id, now).map(x => x.value),
      watchId: w.id,
    })) : undefined
    const others = tasks.length - 1
    d.render({
      key: TRIP_KEY, template: 'trip', kind: 'task', ttl: 'untilDismissed',
      // 到价 = 用户点名要盯的事有了结果，不该被常规刷新挤回等位区
      urgency: hit ? 'urgent' : undefined,
      data: {
        title: t.title, dest: t.destination,
        sub: t.departDate
          ? `${t.departDate} 出发${t.days?.length ? ` · ${t.days.length} 天` : ''}${t.travelers ? ` · ${t.travelers} 人` : ''}`
          : t.days?.length ? `${t.days.length} 天怎么玩 · 攻略给你摆好了` : '日期还没定',
        badge: t.days?.length ? `${t.days.length} 天 · ${t.destination}` : undefined,
        dday: ddayOf(t.departDate),
        prep: t.prep, days: t.days, lines: t.days?.length ? undefined : t.lines,
        wx: t.wx, flight, stays,
        decide: hit ? {
          question: `${KIND_LABEL[hit.kind]}到你说的价了（${UNIT[hit.kind](hit.lastValue!)}），现在定吗？`,
          options: [`看看${KIND_LABEL[hit.kind]}的价格趋势`, '先不定，继续盯着'],
        } : undefined,
        foot: alive.length
          ? `盯着 ${alive.filter(w => w.status === 'active').length} 项${others > 0 ? ` · 还有 ${others} 个行程` : ''}`
          : t.summary ?? (t.days?.length ? '说"就按这个来"，机票酒店我就帮你盯起来' : undefined),
      },
    })
  }

  /** 趋势卡。**verdict 不填**——那是模型的判断，代码只给事实 */
  const paintTrend = (w: TravelWatch, note?: string) => {
    const d = deps.desk()
    if (!d) return
    const now = deps.clock()
    const pts = S().samples(w.id, now)
    const f = factsOf(w)
    d.render({
      key: trendKey(w.id), family: 'travel-trend', template: 'trend',
      kind: 'task', ttl: 'untilDismissed',
      // 用户点名要盯的事到价了，不该被后续常规刷新挤回等位区（同进展卡的教训）
      urgency: 'urgent',
      data: {
        title: `${KIND_LABEL[w.kind]} · ${w.label}`,
        current: w.lastValue, changeFromPrev: f.changeFromPrev,
        min: f.min, max: f.max, median: f.median, percentile: f.percentile,
        points: pts.map(p => ({ at: p.at, value: p.value })),
        threshold: w.threshold,
        thresholdLabel: w.threshold !== undefined
          ? `提醒线 ${w.threshold}` : undefined,
        updatedLabel: note,
      },
    })
  }

  /**
   * 首采（2026-08-25 实拍「监控项没有图」）：源有 history 就先回填 30 天再采
   * 今天——不然刚建的监控只有 1 个点，曲线要等 30 天才长出来。源没接/报错
   * 静默跳过，watch 照建（lastAt 保持空，下一轮调度立刻采它）。
   */
  const firstSample = async (w: TravelWatch): Promise<PriceQuote | undefined> => {
    const src = deps.sources()[w.kind]
    if (!src) return undefined
    try {
      if (src.history) for (const pt of await src.history(w, 30)) S().addSample(w.id, pt.value, pt.at)
      const q = await src.quote(w)
      S().addSample(w.id, q.value, q.at)
      return q
    } catch { return undefined }
  }

  /**
   * 行程天气（v3）：有出发日 + 在 16 天预报窗内才拉，按行程日对齐存
   * task.wx；窗外的日子存 null——**不编造超窗的天气**。源没接/报错静默
   * 跳过，行程照常。改日期/改目的地后重拉（调用方负责触发）。
   */
  const refreshWx = async (taskId: string) => {
    const t = S().task(taskId)
    const fetchWx = deps.weather?.()
    if (!t?.departDate || !t.days?.length || !fetchWx) return
    const start = Date.parse(t.departDate + 'T00:00:00')
    const daysOut = (start - deps.clock()) / 86_400_000
    if (!Number.isFinite(daysOut) || daysOut > 16) return   // 整程超窗：临近再补
    try {
      const fc = await fetchWx(t.destination, 16)
      const byDate = new Map(fc.map(w => [w.date, w]))
      const wx = t.days.map((_, i) =>
        byDate.get(new Date(start + i * 86_400_000).toISOString().slice(0, 10)) ?? null)
      S().updateTask(taskId, { wx })
    } catch { /* 天气拉不到不拦行程 */ }
  }

  const handlers = {
    /* ── 攻略进仓。模型查完攻略把结构化日程交过来，trip 卡上屏 ── */
    travelPlan: async (args: any): Promise<ToolResult> => {
      const destination = String(args?.destination ?? '').trim()
      if (!destination)
        return { status: 'rejected', code: 'INVALID_PARAMS',
          message: '还不知道要去哪儿', suggestion: '先确定目的地再出攻略' }
      const days = Array.isArray(args?.days) ? args.days : []
      const lines = Array.isArray(args?.lines) ? args.lines : []
      /* ── 选线阶段（v3）：目的地宽泛先给几条线收敛，选定交 days 后 lines 自动清 ── */
      if (!days.length && lines.length) {
        const cleanLines = lines
          .filter((x: any) => x?.name && x?.route)
          .map((x: any) => ({ name: String(x.name), route: String(x.route),
            days: x.days !== undefined ? String(x.days) : undefined,
            note: x.note !== undefined ? String(x.note) : undefined }))
        if (!cleanLines.length)
          return { status: 'rejected', code: 'INVALID_PARAMS',
            message: '线路不完整', suggestion: '每条线要 name 和 route' }
        const dupL = S().tasks().find(t => t.destination === destination && t.status !== 'archived')
        const idL = dupL?.id ?? newId('task')
        if (dupL) S().updateTask(idL, { lines: cleanLines })
        else S().addTask({ id: idL, title: String(args?.title ?? destination).trim(),
          destination, status: 'draft', createdAt: deps.clock(), lines: cleanLines })
        paintTrip()
        return { status: 'ok', data: { taskId: idL, lineCount: cleanLines.length },
          message: `${cleanLines.length} 条线路上卡了——问一个偏好问题帮用户挑（点某条 = 选了它），` +
            '选定后再交 days' }
      }
      if (!days.length)
        return { status: 'rejected', code: 'INVALID_PARAMS',
          message: '没有日程也没有线路',
          suggestion: '目的地宽泛先交 lines 收敛；具体了交 days：[{title, stops:[{time?,name,note?}], trans?, stay?}]' }
      // 逐元素查必填——模型换字段名静默入仓的教训（story.begin 那次正文空白上屏）
      const bad = days.find((x: any) => !x?.title || !Array.isArray(x?.stops)
        || !x.stops.length || x.stops.some((st: any) => !st?.name))
      if (bad)
        return { status: 'rejected', code: 'INVALID_PARAMS',
          message: `有一天的日程不完整（收到的键：${Object.keys(bad ?? {}).join('、') || '空'}）`,
          suggestion: '每天要 title 和至少一个 stops，每站要 name' }
      const clean = days.map((x: any) => ({
        title: String(x.title),
        stops: x.stops.map((st: any) => ({
          time: st.time !== undefined ? String(st.time) : undefined,
          name: String(st.name),
          note: st.note !== undefined ? String(st.note) : undefined,
        })),
        trans: Array.isArray(x.trans) ? x.trans.map(String) : undefined,
        stay: x.stay !== undefined ? String(x.stay) : undefined,
        cityChange: x.cityChange === true || undefined,
      }))
      const prep = Array.isArray(args?.prep) ? args.prep.map(String) : undefined
      // 防重判据跟 create 同一条：同目的地 + 非归档 → 更新它，不新建
      const dup = S().tasks().find(t => t.destination === destination && t.status !== 'archived')
      const id = dup?.id ?? newId('task')
      const patch = { days: clean, prep, lines: undefined,   // 选择题答完就撤
        summary: args?.summary !== undefined ? String(args.summary) : undefined }
      if (dup) S().updateTask(id, patch)
      else S().addTask({
        id, title: String(args?.title ?? destination).trim(), destination,
        status: 'draft', createdAt: deps.clock(), ...patch,
      })
      await refreshWx(id)          // 已有出发日的（改行程场景）天气跟着新行程走
      paintTrip()
      return { status: 'ok', data: { taskId: id, dayCount: clean.length },
        message: `${clean.length} 天的攻略上卡了，Day 会自动轮播——口头只说一句收尾，` +
          '内容让屏幕讲，也不要反问「要不要盯价」（卡上已写了怎么继续）；' +
          '用户认可了再 travel.create 接管盯价' }
    },

    /* ── 建任务。信息不全照建，缺什么在返回里说 ── */
    travelCreate: async (args: any): Promise<ToolResult> => {
      const destination = String(args?.destination ?? '').trim()
      if (!destination)
        return { status: 'rejected', code: 'INVALID_PARAMS',
          message: '还不知道要去哪儿', suggestion: '问一句目的地，其它的可以边聊边补' }
      /**
       * 防重（2026-08-25 pilot 实拍：后台子代理查机票时自己又 create 了
       * 一个曼谷任务，屏上冒出"2 个行程"）。判据是数据形状——同目的地 +
       * 非归档已存在 → 复用，不新建；这次要盯的项照样往它身上加。
       */
      const dup = S().tasks().find(t => t.destination === destination && t.status !== 'archived')
      const merged = { ...dup, departDate: args?.departDate ?? dup?.departDate,
        returnDate: args?.returnDate ?? dup?.returnDate,
        travelers: args?.travelers ?? dup?.travelers }
      const pending = REQUIRED_SOON.filter(k => !(merged as any)[k])
      const id = dup?.id ?? newId('task')
      if (!dup)
        S().addTask({
          id, title: String(args?.title ?? destination).trim(), destination,
          departDate: args?.departDate, returnDate: args?.returnDate,
          travelers: args?.travelers,
          status: pending.length ? 'draft' : 'active',
          createdAt: deps.clock(),
        })
      // 先 plan 后 create：同一个任务原地转正（确认即接管），攻略数据不动
      else S().updateTask(id, { departDate: merged.departDate, returnDate: merged.returnDate,
        travelers: merged.travelers, status: pending.length ? dup.status : 'active' })
      // 监控项可以一次配上——PRD 要求建任务 ≤2 轮对话，分两次调用就超了
      const watchIds = (Array.isArray(args?.watch) ? args.watch : [])
        .filter((w: any) => w?.kind in KIND_LABEL)
        .map((w: any) => {
          const wid = newId('w')
          S().addWatch({
            id: wid, taskId: id, kind: w.kind,
            label: w.label ?? (w.stay?.city
              ? `${w.stay.city}${KIND_LABEL[w.kind as WatchKind]}`
              : `${destination}${KIND_LABEL[w.kind as WatchKind]}`),
            threshold: w.threshold, direction: w.direction ?? 'below',
            // 分段住宿：多城市行程一段一条酒店监控，各盯各的价
            stay: w.stay?.city !== undefined
              ? { city: String(w.stay.city), dayFrom: Number(w.stay.dayFrom), dayTo: Number(w.stay.dayTo) }
              : undefined,
            status: 'active', ...DEFAULT_RHYTHM[w.kind as WatchKind],
          })
          return wid
        })
      /**
       * 首采价（2026-08-25 pilot 实拍：模型建完任务手里没数，宁可 delegate
       * 后台查价，用户催了三轮才拿到参考价）。建完立即采一轮，价直接带在
       * 返回里——"机票现在多少钱"在这一步就闭环。采不到（源没接/报错）
       * 就静默跳过，create 本身照样成功。
       */
      const quotes: Array<{ watchId: string; kind: WatchKind; label: string;
        value: number; text: string; note?: string }> = []
      await Promise.all(S().watches().filter(w => watchIds.includes(w.id)).map(async w => {
        const q = await firstSample(w)                 // 回填 30 天历史 + 采今天
        if (q) quotes.push({ watchId: w.id, kind: w.kind, label: KIND_LABEL[w.kind],
          value: q.value, text: UNIT[w.kind](q.value), note: q.note })
      }))
      await refreshWx(id)
      paintTrip()
      const quoteLine = quotes.length
        ? `。参考价：${quotes.map(q => `${q.label} ${q.text}`).join('、')}${quotes.some(q => q.note) ? `（${quotes.find(q => q.note)!.note}）` : ''}——用户问价直接报这个，别再转后台查`
        : ''
      return { status: 'ok', data: { taskId: id, watchIds, pending, quotes },
        message: dup
          ? `已经有「${dup.title}」这个行程了，直接用它${watchIds.length ? `，新加 ${watchIds.length} 项监控` : ''}${quoteLine}`
          : `任务建好了${pending.length ? `（还缺 ${pending.join('、')}，可以边聊边补）` : ''}` +
            `${watchIds.length ? `，${watchIds.length} 项已经开始盯了` : ''}${quoteLine}` }
    },

    /* ── 建委托 ── */
    travelWatch: async (args: any): Promise<ToolResult> => {
      const t = S().task(String(args?.taskId ?? ''))
      if (!t) return { status: 'rejected', code: 'TASK_NOT_FOUND',
        message: '没有这个行程任务', suggestion: '先建任务，或用 travel.list 看看有哪些' }
      const kind = args?.kind as WatchKind
      if (!(kind in KIND_LABEL))
        return { status: 'rejected', code: 'INVALID_PARAMS',
          message: `盯不了「${args?.kind}」`, suggestion: '只能盯 flight / hotel / fx / news 四类' }
      const id = newId('w')
      S().addWatch({
        id, taskId: t.id, kind,
        label: String(args?.label ?? `${t.destination}${KIND_LABEL[kind]}`),
        threshold: args?.threshold, direction: args?.direction ?? 'below',
        expiresAt: args?.expiresAt, status: 'active',
        everyMs: args?.everyMs ?? DEFAULT_RHYTHM[kind].everyMs,
        onBoot: args?.onBoot ?? DEFAULT_RHYTHM[kind].onBoot,
      })
      const q = await firstSample(S().watches().find(w => w.id === id)!)   // 建完就有曲线
      paintTrip()
      // 首采价直接带在返回里——"问价"在这一步就闭环，模型没理由再 refresh
      const qLine = q ? `。现价 ${UNIT[kind](q.value)}${q.note ? `（${q.note}）` : ''}——直接报给用户` : ''
      return { status: 'ok', data: { watchId: id, quote: q },
        message: (args?.threshold !== undefined
          ? `盯上了：${KIND_LABEL[kind]}${args.direction === 'above' ? '高于' : '低于'} ${args.threshold} 就提醒`
          : `盯上了：${KIND_LABEL[kind]}，有明显变化我说一声`) + qLine }
    },

    /* ── 撤销委托。样本留着——曲线还能看 ── */
    travelUnwatch: async (args: any): Promise<ToolResult> => {
      const w = S().cancelWatch(String(args?.watchId ?? ''))
      if (!w) return { status: 'rejected', code: 'NOT_FOUND', message: '没有这条委托' }
      paintTrip()
      return { status: 'ok', data: { watchId: w.id }, message: `不盯${KIND_LABEL[w.kind]}了` }
    },

    /* ── 立即采一轮。演示时不等采样周期，用户问"现在什么价"也走这儿 ── */
    travelRefresh: async (args: any): Promise<ToolResult> => {
      const st = S()
      const scope = args?.taskId
        ? st.activeWatches(deps.clock()).filter(w => w.taskId === args.taskId)
        : st.activeWatches(deps.clock())
      const fired = await sampleRound(st, scope.map(w => w.id), deps.sources())
      // 触发了的在 trip 卡上原地出决策条——不弹新卡，一张卡是一次旅行的家
      paintTrip()
      /**
       * latest 带每项最新值（2026-08-25 pilot 实拍）：以前只回"都更新了，
       * 没有到提醒线的"——模型要报价拿不到数，换着 label 连调 6 次 refresh
       * 打转，烧光轮次后只剩空收场兜底，用户问四遍一个数没听到。
       * 答案必须在返回里，模型才没有理由再调一次。
       */
      const latest = st.watches()
        .filter(w => scope.some(x => x.id === w.id) && w.lastValue !== undefined)
        .map(w => ({ watchId: w.id, kind: w.kind, kindLabel: KIND_LABEL[w.kind],
          label: w.label, value: w.lastValue!, text: UNIT[w.kind](w.lastValue!) }))
      return { status: 'ok',
        data: {
          sampled: scope.length, latest,
          fired: fired.map(f => ({
            watchId: f.watch.id, kind: f.watch.kind, label: f.watch.label,
            value: f.value, threshold: f.watch.threshold, note: f.note,
            trend: factsOf(st.watches().find(w => w.id === f.watch.id)!),
          })),
        },
        message: fired.length
          ? `${fired.length} 项到你说的价了，旅行卡上出了决策条`
          : latest.length
            ? `最新价在 latest 里：${latest.map(l => `${l.kindLabel} ${l.text}`).join('、')}` +
              '——直接报给用户，不用再调一次'
            : '都更新了，没有到提醒线的' }
    },

    /* ── 全景。问答的数据底座，也是行程单卡的来源 ── */
    travelList: async (args: any): Promise<ToolResult> => {
      const st = S()
      const tasks = args?.taskId ? st.tasks().filter(t => t.id === args.taskId) : st.tasks()
      const watches = st.watches()
        .filter(w => tasks.some(t => t.id === w.taskId))
        .map(w => ({ ...w, kindLabel: KIND_LABEL[w.kind], trend: factsOf(w) }))
      paintTrip()
      // 钻取：点价格块/用户要看走势 → 完整趋势卡（trend 的唯一入口，2026-08-25 起）
      if (args?.showTrend) {
        const w = st.watches().find(x => x.id === args.showTrend)
        if (w) paintTrend(w)
      }
      /**
       * draft 存在 = 攻略给过、还没接管（2026-08-25 pilot 实拍：用户说"就按
       * 这个来"，慢层调完 list 却跑去 web.search 查价，create 从没被调）。
       * 判据是任务状态不是话的内容——同"pending 确认直达慢层"一族。
       */
      const draft = tasks.some(t => t.status === 'draft' && !watches.some(w => w.taskId === t.id))
      return { status: 'ok', data: { tasks, watches },
        message: tasks.length
          ? `行程和盯着的项都在这儿了，卡片也上屏了——口头挑重点说就行${draft
              ? '。注意：有行程还是草稿——用户已认可攻略的话，下一个动作就是 travel.create' +
                '（转正+配监控，机票价直接在它返回的 quotes 里，不用再搜）'
              : ''}`
          : '还没有行程任务' }
    },

    /* ── 改任务。返回新旧对照，影响摘要的话由模型组织 ── */
    travelUpdate: async (args: any): Promise<ToolResult> => {
      const st = S()
      const before = st.task(String(args?.taskId ?? ''))
      if (!before) return { status: 'rejected', code: 'TASK_NOT_FOUND', message: '没有这个行程任务' }
      const fields = ['title', 'destination', 'departDate', 'returnDate', 'travelers', 'status'] as const
      const changed = fields
        .filter(f => args?.[f] !== undefined && args[f] !== (before as any)[f])
        .map(f => ({ field: f, from: (before as any)[f], to: args[f] }))
      if (changed.length)
        st.updateTask(before.id, Object.fromEntries(changed.map(c => [c.field, c.to])) as any)
      // 日期或目的地动了 → 天气跟着重拉（不动就不重拉，别浪费上游）
      if (changed.some(c => c.field === 'departDate' || c.field === 'destination'))
        await refreshWx(before.id)
      // 受影响的监控项：这个任务下的全部——日期变了它们的判断依据就全变了
      const affected = st.watches().filter(w => w.taskId === before.id).map(w => ({
        watchId: w.id, kind: w.kind, kindLabel: KIND_LABEL[w.kind],
        lastValue: w.lastValue, trend: factsOf(w),
      }))
      paintTrip()
      /**
       * 目的地变了，攻略/标题/监控还都是旧地方的（2026-08-25 实拍：三亚改
       * 海口后卡片还是三亚攻略；模型嘴上说"帮你停掉三亚酒店监控"却没调
       * unwatch）。判据是 changed 的字段名——系统状态，不是解析用户的话。
       */
      const destMoved = changed.some(c => c.field === 'destination')
      return { status: 'ok', data: { taskId: before.id, changed, affected },
        message: changed.length
          ? `改好了，${affected.length} 项监控跟着重算了——把「改了什么→影响哪几项→每项新结论」说给用户${destMoved
              ? '。注意：攻略、标题和监控还是原目的地的——用 travel.plan 重出新目的地的攻略；' +
                '不再需要的监控用 travel.unwatch 真停掉，别只嘴上说停了'
              : ''}`
          : '这几项本来就是这个值，没改动' }
    },

    /* ── 删任务。灰权限，确认流由 registry 管；这里只负责把停掉的说清楚 ── */
    travelDelete: async (args: any): Promise<ToolResult> => {
      const st = S()
      const t = st.task(String(args?.taskId ?? ''))
      if (!t) return { status: 'rejected', code: 'TASK_NOT_FOUND', message: '没有这个行程任务' }
      const stopped = st.removeTask(t.id)
      const d = deps.desk()
      if (d) {
        // 相关的卡一起撤——留着就是在显示一个不存在的行程
        for (const w of stopped) { const c = d.findByKey(trendKey(w.id)); if (c) d.dismiss(c.id) }
      }
      paintTrip()
      return { status: 'ok',
        data: { taskId: t.id, stopped: stopped.map(w => ({ kind: w.kind, kindLabel: KIND_LABEL[w.kind] })) },
        message: `「${t.title}」删了${stopped.length
          ? `，${stopped.map(w => KIND_LABEL[w.kind]).join('、')}的监控都停了` : ''}——把停了哪些告诉用户` }
    },
  }

  return { handlers, paintTrend, paintTrip, factsOf }
}

/**
 * 给 registry 的七个 handler。
 *
 * 包一层装配守卫（2026-08-25 pilot 实拍）：pilot 的 registry 没接 travel 仓，
 * 模型调 travel.list 直接炸 HANDLER_ERROR: Cannot read properties of
 * undefined——裸 TypeError 进了模型上下文，它只能瞎编一句"后台抽风"。
 * 拒绝必须携带机器可读原因 + 人话（核心原则第 4 条），**没装配也一样**。
 */
export function createTravelHandlers(deps: TravelDeps) {
  const { handlers } = core(deps)
  const NOT_WIRED: ToolResult = {
    status: 'unavailable', code: 'NOT_WIRED',
    message: '行程功能在这个环境里没装配',
    suggestion: '如实告诉用户行程管家暂时用不了，别猜原因',
  }
  return Object.fromEntries(Object.entries(handlers).map(([name, fn]) => [
    name,
    async (args: any): Promise<ToolResult> => deps.store() ? fn(args) : NOT_WIRED,
  ])) as typeof handlers
}

/**
 * 给装配层的采样引擎。跟 core/monitor 的分工：monitor 说"谁到期了"，
 * 这里负责真去取数、建卡，并把**触发了的**交回去让装配层叫醒模型。
 *
 * 只采点名的那几项——不是每次全采。机酒的免费额度很小（RapidAPI 免费层
 * 50 次/月），多采一次就少一次；汇率虽然免费，一天该采一次就别一小时一次。
 */
export function createTravelEngine(deps: TravelDeps) {
  const { handlers, paintTrend, paintTrip, factsOf } = core(deps)
  void handlers
  return {
    /** monitor 的 onDue 回调。返回触发了的，装配层据此建交付素材 */
    async sampleDue(ids: string[]) {
      const st = deps.store()
      const fired = await sampleRound(st, ids, deps.sources())
      // 到价 → trip 卡原地出决策条，不弹新卡（趋势卡只走钻取）
      if (fired.length) paintTrip()
      return fired.map(f => {
        const w = st.watches().find(x => x.id === f.watch.id)
        return {
          watchId: f.watch.id, kind: f.watch.kind, label: f.watch.label,
          value: f.value, threshold: f.watch.threshold, note: f.note,
          trend: w ? factsOf(w) : undefined,
        }
      })
    },
    /** 喂给 core/monitor 的条目表：生效中的委托 + 各自的采样节奏 */
    items() {
      return deps.store().activeWatches(deps.clock())
        .map(w => ({ id: w.id, everyMs: w.everyMs, onBoot: w.onBoot, lastAt: w.lastAt }))
    },
  }
}
