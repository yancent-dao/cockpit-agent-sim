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
import { sampleRound, type SourceMap } from './travelSources'

export interface TravelDeps {
  store: () => TravelStore
  desk: () => Desk | undefined
  sources: () => SourceMap
  clock: () => number
}

const PLAN_KEY = 'travel-plan'
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

  /** 行程单卡 = f(仓)。每次增删改跑完重画，同编排器「桌面 = f(状态)」 */
  const paintPlan = () => {
    const d = deps.desk()
    if (!d) return
    const tasks = S().tasks().filter(t => t.status !== 'archived')
    if (!tasks.length) { const c = d.findByKey(PLAN_KEY); if (c) d.dismiss(c.id); return }
    const ws = S().watches()
    d.render({
      key: PLAN_KEY, template: 'progress', kind: 'task', ttl: 'untilDismissed',
      data: {
        title: tasks.length === 1 ? tasks[0].title : `${tasks.length} 个行程`,
        items: tasks.flatMap(t => {
          const mine = ws.filter(w => w.taskId === t.id)
          return [{
            label: `${t.title} · ${t.destination}`,
            state: t.status === 'draft' ? 'running' : 'done',
            detail: t.departDate ? `${t.departDate} 出发` : '日期待定',
          }, ...mine.map(w => ({
            label: KIND_LABEL[w.kind],
            state: w.status === 'fired' ? 'done' : w.status === 'active' ? 'running' : 'failed',
            detail: w.lastValue !== undefined ? `${w.lastValue}` : '还没取到数',
          }))]
        }),
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

  const handlers = {
    /* ── 建任务。信息不全照建，缺什么在返回里说 ── */
    travelCreate: async (args: any): Promise<ToolResult> => {
      const destination = String(args?.destination ?? '').trim()
      if (!destination)
        return { status: 'rejected', code: 'INVALID_PARAMS',
          message: '还不知道要去哪儿', suggestion: '问一句目的地，其它的可以边聊边补' }
      const pending = REQUIRED_SOON.filter(k => !args?.[k])
      const id = newId('task')
      S().addTask({
        id, title: String(args?.title ?? destination).trim(), destination,
        departDate: args?.departDate, returnDate: args?.returnDate,
        travelers: args?.travelers,
        status: pending.length ? 'draft' : 'active',
        createdAt: deps.clock(),
      })
      // 监控项可以一次配上——PRD 要求建任务 ≤2 轮对话，分两次调用就超了
      const watchIds = (Array.isArray(args?.watch) ? args.watch : [])
        .filter((w: any) => w?.kind in KIND_LABEL)
        .map((w: any) => {
          const wid = newId('w')
          S().addWatch({
            id: wid, taskId: id, kind: w.kind,
            label: w.label ?? `${destination}${KIND_LABEL[w.kind as WatchKind]}`,
            threshold: w.threshold, direction: w.direction ?? 'below',
            status: 'active', ...DEFAULT_RHYTHM[w.kind as WatchKind],
          })
          return wid
        })
      paintPlan()
      return { status: 'ok', data: { taskId: id, watchIds, pending },
        message: `任务建好了${pending.length ? `（还缺 ${pending.join('、')}，可以边聊边补）` : ''}` +
          `${watchIds.length ? `，${watchIds.length} 项已经开始盯了` : ''}` }
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
      paintPlan()
      return { status: 'ok', data: { watchId: id },
        message: args?.threshold !== undefined
          ? `盯上了：${KIND_LABEL[kind]}${args.direction === 'above' ? '高于' : '低于'} ${args.threshold} 就提醒`
          : `盯上了：${KIND_LABEL[kind]}，有明显变化我说一声` }
    },

    /* ── 撤销委托。样本留着——曲线还能看 ── */
    travelUnwatch: async (args: any): Promise<ToolResult> => {
      const w = S().cancelWatch(String(args?.watchId ?? ''))
      if (!w) return { status: 'rejected', code: 'NOT_FOUND', message: '没有这条委托' }
      paintPlan()
      return { status: 'ok', data: { watchId: w.id }, message: `不盯${KIND_LABEL[w.kind]}了` }
    },

    /* ── 立即采一轮。演示时不等采样周期，用户问"现在什么价"也走这儿 ── */
    travelRefresh: async (args: any): Promise<ToolResult> => {
      const st = S()
      const scope = args?.taskId
        ? st.activeWatches(deps.clock()).filter(w => w.taskId === args.taskId)
        : st.activeWatches(deps.clock())
      const fired = await sampleRound(st, scope.map(w => w.id), deps.sources())
      // 触发了的才上卡：「无更新不开口」的卡片版
      for (const f of fired) paintTrend(st.watches().find(w => w.id === f.watch.id)!, f.note)
      paintPlan()
      return { status: 'ok',
        data: {
          sampled: scope.length,
          fired: fired.map(f => ({
            watchId: f.watch.id, kind: f.watch.kind, label: f.watch.label,
            value: f.value, threshold: f.watch.threshold, note: f.note,
            trend: factsOf(st.watches().find(w => w.id === f.watch.id)!),
          })),
        },
        message: fired.length
          ? `${fired.length} 项到你说的价了，趋势卡已上屏`
          : '都更新了，没有到提醒线的' }
    },

    /* ── 全景。问答的数据底座，也是行程单卡的来源 ── */
    travelList: async (args: any): Promise<ToolResult> => {
      const st = S()
      const tasks = args?.taskId ? st.tasks().filter(t => t.id === args.taskId) : st.tasks()
      const watches = st.watches()
        .filter(w => tasks.some(t => t.id === w.taskId))
        .map(w => ({ ...w, kindLabel: KIND_LABEL[w.kind], trend: factsOf(w) }))
      paintPlan()
      return { status: 'ok', data: { tasks, watches },
        message: tasks.length
          ? '行程和盯着的项都在这儿了，卡片也上屏了——口头挑重点说就行'
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
      // 受影响的监控项：这个任务下的全部——日期变了它们的判断依据就全变了
      const affected = st.watches().filter(w => w.taskId === before.id).map(w => ({
        watchId: w.id, kind: w.kind, kindLabel: KIND_LABEL[w.kind],
        lastValue: w.lastValue, trend: factsOf(w),
      }))
      paintPlan()
      return { status: 'ok', data: { taskId: before.id, changed, affected },
        message: changed.length
          ? `改好了，${affected.length} 项监控跟着重算了——把「改了什么→影响哪几项→每项新结论」说给用户`
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
      paintPlan()
      return { status: 'ok',
        data: { taskId: t.id, stopped: stopped.map(w => ({ kind: w.kind, kindLabel: KIND_LABEL[w.kind] })) },
        message: `「${t.title}」删了${stopped.length
          ? `，${stopped.map(w => KIND_LABEL[w.kind]).join('、')}的监控都停了` : ''}——把停了哪些告诉用户` }
    },
  }

  return { handlers, paintTrend, paintPlan, factsOf }
}

/** 给 registry 的七个 handler */
export function createTravelHandlers(deps: TravelDeps) {
  return core(deps).handlers
}

/**
 * 给装配层的采样引擎。跟 core/monitor 的分工：monitor 说"谁到期了"，
 * 这里负责真去取数、建卡，并把**触发了的**交回去让装配层叫醒模型。
 *
 * 只采点名的那几项——不是每次全采。机酒的免费额度很小（RapidAPI 免费层
 * 50 次/月），多采一次就少一次；汇率虽然免费，一天该采一次就别一小时一次。
 */
export function createTravelEngine(deps: TravelDeps) {
  const { handlers, paintTrend, paintPlan, factsOf } = core(deps)
  void handlers
  return {
    /** monitor 的 onDue 回调。返回触发了的，装配层据此建交付素材 */
    async sampleDue(ids: string[]) {
      const st = deps.store()
      const fired = await sampleRound(st, ids, deps.sources())
      for (const f of fired) {
        const w = st.watches().find(x => x.id === f.watch.id)
        if (w) paintTrend(w, f.note)
      }
      if (fired.length) paintPlan()
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
