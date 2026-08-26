/**
 * 旅行任务域仓（旅行助手，2026-08-20）。
 *
 * 长时任务的地基是持久化：任务与委托跨上下电存续（关窗口 = 熄火，
 * 重新打开 = 上电），中间靠 localStorage 接上。跟自动化规则仓同构——
 * 存的是**用户数据**，读写、上限淘汰、坏数据兜底，没有一行业务逻辑。
 *
 * 采样样本按 **30 天滚动窗**淘汰：趋势分析本来就只看 30 天，攒更久
 * 既没人看，又会把配额吃满——绘本那次一本书 6MB 撑爆 5MB 配额、
 * 而且**写是静默失败的**，讲了一路的故事在成书那刻蒸发。别再来一次。
 */
import type { DomainStorage } from './domain'

/** 单日行程的一站。time 不强求——有的站就是"晚上随便逛" */
export interface TripStop { time?: string; name: string; note?: string }
/** 一天的行程帧。trans[i] 是第 i 站到第 i+1 站的交通衔接 */
export interface TripDay {
  title: string
  stops: TripStop[]
  trans?: string[]
  /** 当晚宿在哪段——分段住宿的判据是行程数据，不是猜 */
  stay?: string
  cityChange?: boolean
}

export interface TravelTask {
  id: string
  title: string
  destination: string
  /** 待定态允许为空：信息不全先建起来，随对话补全，不拿必填卡住用户 */
  departDate?: string
  returnDate?: string
  travelers?: number
  /** draft 待定 · active 监控中 · archived 已归档（可查、可当模板复用） */
  status: 'draft' | 'active' | 'archived'
  createdAt: number
  /** 最近一次被操作（plan/create/update/watch）的时刻。trip 卡的主角按它挑——
      「最近在聊的」不是「最近创建的」（2026-08-25 实拍：海南复用老任务，卡还钉在澳大利亚） */
  touchedAt?: number
  /* ── 攻略数据（2026-08-25 融合卡）：卡 = f(仓)，攻略也进仓 ── */
  days?: TripDay[]
  prep?: string[]
  summary?: string
  /** 选线阶段（v3）：目的地宽泛时先给几条线路收敛，选定交 days 后自动清 */
  lines?: Array<{ name: string; route: string; days?: string; note?: string }>
  /** 逐日天气，与 days 对齐（v3）。窗外的日子是 null——不编造 */
  wx?: Array<{ date: string; weather: string; hi: number; lo: number } | null>
}

/** 四类监控项（POC 范围）：机票价 · 酒店价 · 汇率 · 新闻 */
export type WatchKind = 'flight' | 'hotel' | 'fx' | 'news'

export interface TravelWatch {
  id: string
  taskId: string
  kind: WatchKind
  label: string
  /** 阈值与方向：低于/高于多少提醒。不填 = 只采样不提醒（趋势用） */
  threshold?: number
  direction?: 'below' | 'above'
  /** 有效期。到点自动失效，不用等谁来清 */
  expiresAt?: number
  status: 'active' | 'fired' | 'expired' | 'cancelled'
  /** 采样策略（喂给 core/monitor 的两个字段）。是数据不是代码 */
  everyMs?: number
  onBoot?: boolean
  lastValue?: number
  lastAt?: number
  /** 分段住宿（hotel 专用）：这条监控盯的是行程里哪一段的酒店 */
  stay?: { city: string; dayFrom: number; dayTo: number }
}

export interface TravelSample { watchId: string; at: number; value: number }

const KEY = 'cockpit-sim:travel'
const WINDOW = 30 * 86_400_000

interface Shape { tasks: TravelTask[]; watches: TravelWatch[]; samples: TravelSample[] }

export function createTravelStore(storage: DomainStorage) {
  let db: Shape = { tasks: [], watches: [], samples: [] }
  try {
    const raw = storage.get(KEY)
    const p = raw ? JSON.parse(raw) : null
    if (p && Array.isArray(p.tasks) && Array.isArray(p.watches))
      db = { tasks: p.tasks, watches: p.watches, samples: Array.isArray(p.samples) ? p.samples : [] }
  } catch { /* 坏数据兜底成空仓 */ }

  const persist = () => { try { storage.set(KEY, JSON.stringify(db)) } catch { /* 配额满静默 */ } }
  /** 触碰时间戳单调递增：同毫秒内两次操作也分得出先后（排序判据不许并列） */
  let lastTouch = Math.max(0, ...db.tasks.map(t => t.touchedAt ?? 0))
  const touch = () => (lastTouch = Math.max(Date.now(), lastTouch + 1))
  /** 淘汰过期样本。每次写样本时顺手做，不用单开一个清理任务 */
  const prune = (now: number) => { db.samples = db.samples.filter(s => now - s.at <= WINDOW) }

  return {
    /* ── 任务 ── */
    tasks: (): TravelTask[] => db.tasks.map(t => ({ ...t })),
    task: (id: string): TravelTask | undefined => {
      const t = db.tasks.find(x => x.id === id)
      return t && { ...t }
    },
    // 防御性拷贝：外部引用不许穿透进仓——共享对象被调用方改一下，
    // 仓里的"事实"就悄悄变了（自动化规则仓真踩到过）
    addTask(t: TravelTask) { db.tasks.push({ ...t, touchedAt: touch() }); persist() },
    updateTask(id: string, patch: Partial<TravelTask>) {
      const t = db.tasks.find(x => x.id === id)
      if (t) { Object.assign(t, patch, { touchedAt: touch() }); persist() }
      return t && { ...t }
    },
    /** 删任务连它的委托一起删，返回被停掉的那些——收场话术要念出来 */
    removeTask(id: string): TravelWatch[] {
      const orphans = db.watches.filter(w => w.taskId === id).map(w => ({ ...w }))
      db.watches = db.watches.filter(w => w.taskId !== id)
      db.samples = db.samples.filter(s => !orphans.some(w => w.id === s.watchId))
      db.tasks = db.tasks.filter(t => t.id !== id)
      persist()
      return orphans
    },

    /* ── 委托 ── */
    watches: (): TravelWatch[] => db.watches.map(w => ({ ...w })),
    /** 此刻真正生效中的：状态是 active 且没过有效期 */
    activeWatches: (now: number = Date.now()): TravelWatch[] =>
      db.watches.filter(w => w.status === 'active' && (w.expiresAt === undefined || w.expiresAt > now))
        .map(w => ({ ...w })),
    addWatch(w: TravelWatch) {
      db.watches.push({ ...w })
      const t = db.tasks.find(x => x.id === w.taskId)
      if (t) t.touchedAt = touch()   // 给任务加监控也是在聊它
      persist()
    },
    markFired(id: string, value: number, at: number) {
      const w = db.watches.find(x => x.id === id)
      if (w) { w.status = 'fired'; w.lastValue = value; w.lastAt = at; persist() }
      return w && { ...w }
    },
    cancelWatch(id: string) {
      const w = db.watches.find(x => x.id === id)
      if (w) { w.status = 'cancelled'; persist() }
      return w && { ...w }
    },

    /* ── 采样 ── */
    /** 记一次采样，顺带更新委托的 lastAt——调度器靠它算下次什么时候采 */
    addSample(watchId: string, value: number, at: number) {
      db.samples.push({ watchId, value, at })
      const w = db.watches.find(x => x.id === watchId)
      if (w) { w.lastValue = value; w.lastAt = at }
      prune(at)
      persist()
    },
    /** 某条委托的 30 天样本，按时间正序——画曲线不用调用方自己排 */
    samples: (watchId: string, now: number = Date.now()): TravelSample[] =>
      db.samples.filter(s => s.watchId === watchId && now - s.at <= WINDOW)
        .sort((a, b) => a.at - b.at).map(s => ({ ...s })),
  }
}

export type TravelStore = ReturnType<typeof createTravelStore>
