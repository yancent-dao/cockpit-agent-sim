import { CARD_TEMPLATES, COMMON_SIZES } from '../config/cards'
import { formOf, suggestSize } from '../config/forms'
import { checkSize } from './contract'
import { summarize, titleOf } from './summary'
import { GRID, LADDER as TIER_LADDER, type TierName, listCapacity, dimsOf, cellsOfTier, normalizeTier } from '../config/grid'
import { type Urgency, priorityOf as prioOf, evictableAt, minTierFor, normalizeUrgency, channelOf } from '../config/priority'

/**
 * 卡片桌面（无APP化）—— 2026-08-10 重设计，见 docs/superpowers/specs/2026-08-10-card-orchestration-design.md
 *
 * 统一 48 单元画布（12列×4行，2026-08-12 从 3×2 换过来），无分区、无常驻卡，
 * 默认为空，一切按需出现。每个档位只允许一种形状 —— 布局问题保持可枚举，
 * **可预测优先于最优**：同一场景每次演示长得一样。
 *
 * 换栅格是为了消掉几何死局：3×2 下一张 2/3 卡占掉左 2 列，右边剩一条宽 1 的竖缝，
 * 横向的 1/3 卡（宽 2）永远放不进去，整张卡出不来。12×4 之后档位宽度一律偶数、
 * 列起点只取偶数，空隙必为偶数宽，最小档 chip（宽 2）永远填得上。
 * 栅格与档位常量的唯一出处是 src/config/grid.ts。
 *
 * 仲裁全部确定性：
 *   放置顺序 = 2/3 卡最先（唯一合法位置）→ 优先级降序 → 创建时间升序
 *   空间不够 = 降低优先级卡的尺寸 → 降新卡自己的尺寸 → LRU 挤出 → 拒绝
 *   evictable:false 永不被挤（导航中的导航卡）
 *   挤出必须告知（note 带人话标题），静默消失不可接受
 */

/**
 * 尺寸。老名字（1/6…）和新档位名（chip / strip / bar / card / wide / panel / banner /
 * tower / stage / full）都认，内部一律归一到档位名 —— 见 src/config/grid.ts 的 ALIAS。
 */
export type Size = '1/6' | '1/3' | '1/2' | '2/3' | 'full' | TierName
export type Kind = 'task' | 'rule' | 'system'
export type Ttl = 'untilDismissed' | 'untilTaskEnd' | number

const ROWS = GRID.rows, COLS = GRID.cols
const shapeOf = (size: string) => { const [w, h] = dimsOf(size); return { w, h } }
/**
 * 阶梯降尺寸，七档 —— 出处是 grid.ts，不在这儿抄第二份。
 *
 * 之前这里写死了老的三档（1/6·1/3·1/2），缩到 1/6 就缩无可缩。
 * 而 6 张 1/6 正好填满 48 单元，所以第 7 张卡一来必挤掉一张 ——
 * 用户看到的现象就是「超过六个就把音乐播放器关了」。
 * chip(2×1) 这些小档存在的意义正是「还想留着但没那么多地方」。
 *
 * tower/stage/full 是专用档不进阶梯：导航卡退成 tower 会变成一条竖缝。
 */
const LADDER: Size[] = [...TIER_LADDER]

/** 卡片尺寸相关的最小可辨识信息。仲裁和按钮共用同一份判据 */
type Sizable = { size?: Size; minSize?: Size; urgency?: Urgency; template?: string }

/**
 * 这张卡允许出现的全部档位，按占用单元数从小到大。
 *
 * **唯一的降级阶梯。** 以前仲裁自带一套七档 LADDER，与模板契约声明的
 * `sizes` 并行存在——后果是一张声明了 ['1/6','1/3','1/2'] 的天气卡，
 * 会被仲裁自动压成它从没声明过的 'strip'，模板契约形同虚设，
 * 车机屏还得为全部 10 档各备一套 CSS。现在仲裁降级和右上角按钮
 * 读的是同一张表：**卡片只会出现在自己声明过的档位上**。
 *
 * 三条下限取最严的：调用方的 minSize、模板声明的最小档、紧急度下限
 * （critical 缩到只剩一个标题等于没显示）。
 */
function allowedSizes(c: Sizable): Size[] {
  const tmpl = c.template ? CARD_TEMPLATES.find(t => t.id === c.template) : undefined
  const pool = (tmpl?.sizes ?? COMMON_SIZES) as readonly string[]
  const floorCells = Math.max(
    c.minSize ? cellsOfTier(c.minSize) : 0,
    cellsOfTier(minTierFor(c.urgency)),
  )
  const seen = new Set<string>()
  return pool
    .filter(s => cellsOfTier(s) >= floorCells)
    .filter(s => { const k = normalizeTier(s); if (seen.has(k)) return false; seen.add(k); return true })
    .sort((a, b) => cellsOfTier(a) - cellsOfTier(b)) as Size[]
}

/**
 * 比 cur 小一档是哪档；没有更小的就返回 undefined。
 * cur 不在表里（历史数据/被别处改过）时退而求其次：取表里比它小的最大档。
 */
function smallerSize(c: Sizable, cur: Size): Size | undefined {
  const allowed = allowedSizes(c)
  const i = allowed.findIndex(s => normalizeTier(s) === normalizeTier(cur))
  if (i >= 0) return i > 0 ? allowed[i - 1] : undefined
  const curCells = cellsOfTier(cur)
  const smaller = allowed.filter(s => cellsOfTier(s) < curCells)
  return smaller.length ? smaller[smaller.length - 1] : undefined
}
/**
 * 优先级 = kind 权重 + urgency 权重，表在 src/config/priority.ts。
 * kind 描述「谁建的卡」，urgency 描述「这事有多急」—— 两个维度正交。
 * 只看 kind 的话，车门没关且已起步的安全告警跟天气卡同为 rule，
 * 抢位时按 LRU 决定谁活。
 */
const PRIO = (c: { kind: Kind; urgency?: Urgency }) => prioOf(c.kind, c.urgency)

/**
 * 两个排序族，各有唯一实现。
 *
 * 以前这两条公式在 desk 里抄了四份（evictFromStage、fit 的 byPriorityLRU、
 * tick 的上台队列、layout 的 staged 输出），"队列顺序即上台顺序"这条不变量
 * 全靠复制粘贴维持——谁改了 tick 里的 tie-break 而没动 layout，
 * 边缘条显示的排队顺序就和真实上台顺序错位。
 */
/** 谁先让位：优先级低的先走，同级最久没碰的先走 */
const byVictimOrder = (a: Card, b: Card) => PRIO(a) - PRIO(b) || a.touchedAt - b.touchedAt
/** 谁先上台：优先级高的先来，同级先到先得 */
const byStageOrder = (a: Card, b: Card) => PRIO(b) - PRIO(a) || a.createdAt - b.createdAt

/**
 * 腾位模式。取代原来 4 个准正交布尔标志的组合爆炸——
 * 每种模式对应一个真实场景，语义在 fit() 的文档注释里一处说清。
 */
export type FitMode = 'assert' | 'reconcile' | 'recall' | 'grow'

export interface Card {
  id: string
  key?: string
  template: string
  size: Size
  kind: Kind
  /**
   * 这事有多急。正交于 kind —— kind 说「谁建的」，urgency 说「有多急」。
   * 影响三件事：抢位优先级、能不能被挤、能缩到多小。默认 normal。
   */
  urgency?: Urgency
  /**
   * 卡片家族：同名实体的身份策略。key 带实体后缀（weather:510100），
   * family 是族名（weather）。同一**轮次**的族卡并存（"哪个县最凉快"并行五张），
   * 新一轮到达时旧批退场（北京来了，成都走）。批号 = runtime 调用轮次，
   * 不用时间窗魔数——轮次是真实边界（同一轮 = 同一个意图的并行展开）。
   */
  family?: string
  round?: number
  /** 靠边锚定：right 从右往左找位（时钟撑右场），缺省行为不变 */
  anchor?: 'left' | 'right'
  data: any
  ttl: Ttl
  evictable: boolean
  minSize?: Size
  /**
   * 用户显式 resize 过。规则驱动的重刷不再碰它的尺寸——
   * 桌面是 f(车辆状态)，导航中 ETA 每变一次就重刷一次，
   * 不锁的话用户说"地图小一点"，下一秒就弹回默认。
   * 优先级：物理（仲裁缩放）> 意愿（这个锁）> 建议（模板默认值）
   */
  sizeLocked?: boolean
  /**
   * 该有的大小（恢复目标）。仲裁压缩只改 size 不改它——
   * 压力消失后 reconcile 照着它回落。用户显式 resize 会更新它（意愿层）。
   */
  desiredSize?: Size
  /**
   * 上次真实落位。tryPlace 先试记忆位，占不了才重排 ——
   * 布局对时间序列稳定，不再"一张卡进出、全桌重新发牌"。
   */
  prevPos?: { row: number; col: number }
  createdAt: number
  touchedAt: number
}

export interface PlacedCard extends Card {
  row: number
  col: number
  rowSpan: number
  colSpan: number
}

export interface ShowInput {
  id?: string
  key?: string
  template: string
  size?: Size
  kind?: Kind
  urgency?: Urgency
  family?: string
  round?: number
  data?: any
  ttl?: Ttl
  evictable?: boolean
  /**
   * 可缩到的最小尺寸。列表类卡缩到 1/6 只剩标题、选项全丢，
   * 那一格还不如让给别人。默认 1/6（不设下限）。
   */
  minSize?: Size
  /** 事件卡活动期间刷新寿命（重置 createdAt），避免连续活动中被 ttl 误杀 */
  refreshTtl?: boolean
  anchor?: 'left' | 'right'
}

export interface DeskResult {
  status: 'ok' | 'rejected'
  cardId?: string
  code?: string
  message?: string
  /** 为了腾位被降过尺寸的卡（含新卡自己） */
  shrunk?: string[]
  /** 被挤出的卡 —— 进等位区，不算消失，但仍要告知用户"先收后台了" */
  evicted?: string[]
  /** 人话，供 Agent 播报 */
  note?: string
  level?: 'L1' | 'L2' | 'L3'
  /**
   * 放不下不再是失败——它进了等位区，空间释放后自动上台（2026-08-13）。
   * status 仍是 'ok'：调用方（模型/规则）不用改一行建卡代码。
   */
  staged?: boolean
}

/** 等位区上限。超限淘汰优先级最低+最老的一张——只有淘汰才算真消失 */
const STAGE_CAP = 8


/**
 * 列表类卡片一条内容都没有 —— **空卡比不显示更糟**。
 *
 * 跑批（nav-cross-province）撞出来的：川藏线上搜服务区返回 0 条，
 * handler 照样建卡，屏上留着一张「附近的服务区」标题下面什么都没有的空壳。
 * 用户看到标题会以为在加载；Agent 那边还占着一个格子。
 *
 * 这不是"贴心逻辑"（那是 Tool 内不许有的东西），是**卡片契约**：
 * 一张列表卡的意思就是"这里有几条东西"，0 条时这句话是假的。
 * 判据来自模板自己声明的 requireItems——仲裁引擎不认识具体模板名，
 * 新增列表类模板只要加那一个字段（以前得回这里补 || 分支，漏了就是空卡上屏）。
 */
const isEmptyList = (template: string, data: any) =>
  CARD_TEMPLATES.find(t => t.id === template)?.requireItems === true
  && Array.isArray(data?.items) && data.items.length === 0

export function createDesk(clock: () => number = Date.now) {
  const cards = new Map<string, Card>()
  /**
   * 等位区（2026-08-13）：放不下的新卡、被挤出的卡在这排队，不算消失。
   * 空间释放后 reconcile 静默把它们请回台上——"放不下"是状态不是失败。
   */
  const staged = new Map<string, Card>()
  let overlay: string | undefined
  let seq = 0
  const listeners: Array<() => void> = []
  const emit = () => listeners.forEach(l => l())
  const getById = (id: string) => cards.get(id) ?? staged.get(id)
  /**
   * 挤出告知。desk 只发**事实**（这几张卡被收起来了、人话怎么说），
   * 怎么显示由 UI 决定 —— 走横幅还是走播报不是桌面该管的事。
   * 静默消失不可接受：用户刚看的天气卡没了得有个交代。
   */
  const noticeListeners: Array<(n: { note: string; titles: string[] }) => void> = []
  /** 数据真变了才叫（diff 高亮的机制半边）——ETA 每秒重刷相同值不能闪个不停 */
  const dataChangeListeners: Array<(id: string) => void> = []
  /** 用户亲手关掉的规则卡 key——补回通道跳过它们，直到规则重新断言 */
  const suppressed = new Set<string>()
  /** 最近一次空间释放的时刻。尺寸回落带 2 秒迟滞：候选卡进进出出时天气不能跟着缩-涨-缩 */
  let releasedAt: number | undefined
  /** 没带轮次的家族卡按"每次都是新批"处理（顺序替换语义）——desk 内部自增 */
  let familyAutoRound = 0

  /**
   * 淘汰一张等位区里的卡：优先级最低+最老的先走。
   * 这是等位区里**唯一**会真正消失的通道，必须告知（跟挤出同一条纪律）。
   */
  function evictFromStage() {
    const victim = [...staged.values()].sort(byVictimOrder)[0]
    if (!victim) return
    staged.delete(victim.id)
    const note = `「${titleOf(victim)}」排队太久，先撤了`
    noticeListeners.forEach(l => l({ note, titles: [titleOf(victim)] }))
  }

  /** 塞进等位区，超限先淘汰。挤出/放不下都走这——不占栅格，不算消失 */
  function stage(c: Card) {
    // 已经在排队的卡再次断言（render() 重试上台失败）不算净新增——
    // 不然一张卡反复重试会把自己或别人挤出等位区
    if (!staged.has(c.id) && staged.size >= STAGE_CAP) evictFromStage()
    staged.set(c.id, c)
  }

  /** 新批落地 → 同族旧批退场（台上台下都算）。同 key 刷新不在此列（render 走 update 不新建） */
  function sweepFamily(c: Card) {
    if (!c.family) return
    let removed = false
    for (const other of [...cards.values()])
      if (other.id !== c.id && other.family === c.family && other.round !== c.round) {
        cards.delete(other.id)   // 静默退场：被新批替换是内容更迭，不是挤出，不用告知
        removed = true
      }
    for (const other of [...staged.values()])
      if (other.id !== c.id && other.family === c.family && other.round !== c.round) staged.delete(other.id)
    // 清扫也是空间释放——五张县城天气换成一张北京，腾出的位置要让
    // 被压缩的卡回落（自省补：直接 delete 绕过 dismiss 就绕过了 releasedAt）
    if (removed) releasedAt = clock()
  }

  /** 确定性放置：2/3 最先，然后优先级降序、创建时间升序，行优先扫第一个合法位置 */
  function tryPlace(list: Card[]): PlacedCard[] | null {
    const order = [...list].sort((a, b) => {
      // 高的先放。单行档最灵活，让它最后填缝——否则它会把半高档的位置切碎，
      // 一张 4×2 的卡明明有地方却因为上下都被单行档占了半格而放不下
      const ha = shapeOf(a.size).h, hb = shapeOf(b.size).h
      if (ha !== hb) return hb - ha
      const pa = PRIO(a), pb = PRIO(b)
      if (pa !== pb) return pb - pa
      return a.createdAt - b.createdAt
    })
    const grid: boolean[][] = Array.from({ length: ROWS }, () => Array(COLS).fill(false))
    const out: PlacedCard[] = []
    const fits = (r: number, c0: number, shape: { w: number; h: number }) => {
      if (r + shape.h > ROWS || c0 + shape.w > COLS) return false
      for (let dr = 0; dr < shape.h; dr++)
        for (let dc = 0; dc < shape.w; dc++) if (grid[r + dr][c0 + dc]) return false
      return true
    }
    const occupy = (r: number, c0: number, shape: { w: number; h: number }) => {
      for (let dr = 0; dr < shape.h; dr++)
        for (let dc = 0; dc < shape.w; dc++) grid[r + dr][c0 + dc] = true
    }
    for (const c of order) {
      const shape = shapeOf(c.size)
      let placed: PlacedCard | null = null
      // 位置粘性：先试上次落位（缩小后原点依然合法——偶数列起点不因变小而失效）。
      // 布局要对时间序列稳定，"我的天气卡为什么自己跑了"是反直觉的
      if (c.prevPos && fits(c.prevPos.row, c.prevPos.col, shape)) {
        occupy(c.prevPos.row, c.prevPos.col, shape)
        placed = { ...c, row: c.prevPos.row, col: c.prevPos.col, rowSpan: shape.h, colSpan: shape.w }
      }
      // 列起点只取偶数 —— 配合「档位宽度一律偶数」，空隙必为偶数宽，chip 永远填得上。
      // anchor:right 从右往左找位（时钟卡撑右场），不变量不受影响
      const cols: number[] = []
      for (let i = 0; i + shape.w <= COLS; i += 2) cols.push(i)
      if (c.anchor === 'right') cols.reverse()
      // 行起点按自身高度对齐：半高档只落 0/2，不会错位出一条高 1 的横缝
      const rowStep = shape.h >= 2 ? 2 : 1
      if (!placed) outer: for (let r = 0; r + shape.h <= ROWS; r += rowStep) {
        for (const c0 of cols) {
          if (!fits(r, c0, shape)) continue
          occupy(r, c0, shape)
          placed = { ...c, row: r, col: c0, rowSpan: shape.h, colSpan: shape.w }
          break outer
        }
      }
      if (!placed) return null
      out.push(placed)
    }
    return out
  }

  const others = () => [...cards.values()].filter(c => c.id !== overlay)

  /**
   * 腾位循环：① 原尺寸直接放 ② 降一张低优先级卡的尺寸 ③ 降候选自己的尺寸
   * ④ LRU 挤出一张低优先级卡（进等位区，不是消失）⑤ 几何死局的最后手段：
   * 降高优先级卡的尺寸（绝不挤出高优先级卡）⑥ 都不行 → 候选自己进等位区
   * （onNoSpace='reject' 时仍返回 rejected，供 critical 走覆盖层用）。
   * 每步之后从头再试。
   *
   * **四种模式，不是四个布尔开关。** 以前是 {onNoSpace, passive, recall,
   * preferEvict} 四个准正交标志堆在一起：16 种组合里只有 4 种有意义，
   * 其余组合无人测试、语义未定义，改任何一条分支都要人肉推演全部调用点。
   * 收成具名模式后每种模式的语义在一处说清：
   *   assert    新卡断言（show/render）——②③④⑤ 全开，按优先级比较
   *   reconcile 被动上台（tick 巡查等位区）——只许候选自己缩，不惊动任何人
   *   recall    用户点名召回（focus）——压过优先级比较，但不破硬约束
   *   grow      放大按钮——压过优先级比较 + 挤别人优先于缩自己 + 够不到就拒绝
   */
  function fit(candidate: Card, mode: FitMode = 'assert', onNoSpace: 'stage' | 'reject' = 'stage'): DeskResult {
    /**
     * **试算阶段一律只动副本。** 老实现直接改台上卡的 size，只有成功路径
     * 算"提交"；候选最终放不下时那些压缩既不回滚也不设 releasedAt——
     * 用户看到"加了一张根本没显示的卡，桌面却全变小了还回不来"。
     * 现在把计划记在 plan/evicted 里，成功才落到真卡上，失败什么都没动。
     */
    const plan = new Map<string, Size>()      // id → 试算中的新尺寸
    const evicted: string[] = []
    const titles: string[] = []
    const evictedSet = new Set<string>()
    // 候选可能已经在台上（放大自己）——它不该同时作为"别人"参与试放
    const existing = others().filter(c => c.id !== candidate.id)
    const wasOnstage = cards.has(candidate.id)
    let size = candidate.size

    const sizeOf = (c: Card) => plan.get(c.id) ?? c.size
    // urgent 以上不可挤/不可借 —— 安全告警被 LRU 挤掉是事故，等着用户回应的
    // 问题卡也一样。显式 evictable:false 仍然优先（导航中的导航卡）
    const alive = () => existing.filter(c => c.evictable && evictableAt(c.urgency) && !evictedSet.has(c.id))
    // recall / grow 压过优先级比较：台下卡就是挤不过台上的才排队的，
    // 召回还用同一比较必然在同样格局下永远失败；用户点名与点放大都是意愿层。
    // 但 alive() 的硬约束（evictable:false、urgent+）照旧，意愿不破物理
    const overridesPriority = mode === 'recall' || mode === 'grow'
    const victims = () => alive()
      .filter(c => overridesPriority || PRIO(c) <= PRIO(candidate))
      .sort(byVictimOrder)
    const shrinkableOf = (list: Card[]) =>
      list.find(c => smallerSize(c, sizeOf(c)) !== undefined)

    for (;;) {
      const trial = { ...candidate, size }
      const pool = existing.filter(c => !evictedSet.has(c.id)).map(c => ({ ...c, size: sizeOf(c) }))
      if (tryPlace([...pool, trial])) {
        /* ── 提交：到这一步才碰真卡 ── */
        const shrunk: string[] = []
        for (const [id, s] of plan) {
          const c = cards.get(id)
          if (c && c.size !== s) { c.size = s; shrunk.push(id) }
        }
        if (size !== candidate.size) shrunk.push(candidate.id)
        candidate.size = size
        // 被挤的卡进等位区，不是真的消失（2026-08-13）——数据全保留，
        // 空间释放后自动请回来。跟⑥自我进队一个纪律："排队按该有的大小
        // 记账"：被挤时它可能已经被压缩过好几档，不重置的话被动上台
        // 会直接从压缩后的小尺寸原地落座，永远等不到「回落」
        for (const id of evicted) {
          const victim = cards.get(id)
          cards.delete(id)
          if (victim) {
            victim.size = victim.desiredSize ?? victim.size
            victim.touchedAt = clock()   // 排队顺序按"什么时候下的台"，别拿上午的旧戳
            stage(victim)
          }
        }
        staged.delete(candidate.id)   // 若是从等位区召回成功上台，摘掉排队身份
        candidate.touchedAt = clock() // 刚上台的卡不该在下一轮 LRU 里当最老的
        cards.set(candidate.id, candidate)
        sweepFamily(candidate)
        const note = titles.length ? `${titles.map(t => `「${t}」`).join('、')}先收后台了，随时说"看${titles[0]}"叫回` : undefined
        if (note) noticeListeners.forEach(l => l({ note, titles: [...titles] }))
        emit()
        return {
          status: 'ok', cardId: candidate.id,
          ...(shrunk.length && { shrunk }),
          ...(evicted.length && { evicted, note }),
        }
      }

      // reconcile（被动上台，tick 每轮巡查等位区）只用**真空出来的空间**，
      // 不惊动任何人：不缩别人、不挤别人，只许候选自己缩
      if (mode !== 'reconcile') {
        // ② 降一张低优先级卡
        const shrinkable = shrinkableOf(victims())
        if (shrinkable) { plan.set(shrinkable.id, smallerSize(shrinkable, sizeOf(shrinkable))!); continue }
      }
      // grow（放大按钮）：候选要的是"更大"，挤别人优先于缩自己——否则 ③ 会在
      // 真正尝试挤人之前就把候选缩回原样，"放大"变成静默的原地不动
      if (mode === 'grow') {
        const victim = victims()[0]
        if (victim) {
          evictedSet.add(victim.id); evicted.push(victim.id); titles.push(titleOf(victim))
          size = candidate.size
          continue
        }
      } else {
        // ③ 降候选自己。**放大模式没有这一步**：够不到目标就如实拒绝，
        // 悄悄降回原尺寸再报 ok 就是用户实拍抱怨的"点了没反应"
        const smaller = smallerSize(candidate, size)
        if (smaller) { size = smaller; continue }
      }
      if (mode === 'reconcile') return { status: 'ok', cardId: candidate.id, staged: true }   // 真没地方，继续排队
      // ④ LRU 挤出（grow 模式上面已经挤过一轮，这里是其余模式的通道）
      if (mode !== 'grow') {
        const victim = victims()[0]
        if (victim) {
          evictedSet.add(victim.id); evicted.push(victim.id); titles.push(titleOf(victim))
          size = candidate.size   // 腾出空间后恢复原始期望尺寸重试
          continue
        }
      }
      // ⑤ 几何死局最后手段：高优先级卡也可降尺寸（如 2/3 导航到来时右列放不下）。
      // 只降不挤——evictable:false 的卡永远不会被踢下桌
      const highShrinkable = shrinkableOf(alive().sort(byVictimOrder))
      if (highShrinkable) { plan.set(highShrinkable.id, smallerSize(highShrinkable, sizeOf(highShrinkable))!); continue }

      /* ── 放弃：试算全在副本上，这里天然无需回滚 ── */
      // 放大够不到目标：卡片原样留在台上，如实告诉调用方放不下
      if (mode === 'grow' && wasOnstage)
        return { status: 'rejected', code: 'NO_ROOM', message: '放不下这个尺寸，先收起一张卡再试' }
      // critical 走覆盖层的调用方（show()）传 onNoSpace:'reject' 拦在这——
      // 它们不该出现在等位区里
      if (onNoSpace === 'reject')
        return { status: 'rejected', code: 'DESKTOP_FULL', message: '桌面已满，且没有可以让位的卡片' }
      // 已经在台上的卡（放大/重排失败）不该被自己的操作送下台，维持原状
      if (wasOnstage)
        return { status: 'rejected', code: 'NO_ROOM', message: '放不下这个尺寸' }
      // 已经排队的卡再次断言仍然没地方 → 什么都没变，不 emit。
      // render() 会在规则每次重刷时重试上台（refill 订阅了 desk 变化），
      // 失败了还硬 emit 就是自己触发自己，桌面真满的时候直接栈溢出
      const alreadyStaged = staged.has(candidate.id)
      candidate.size = candidate.desiredSize ?? candidate.size   // 排队按"该有的大小"记账
      // 家族清扫台上台下一视同仁——新一轮到了，旧批不管排没排上号都该退场
      sweepFamily(candidate)
      stage(candidate)
      if (!alreadyStaged) emit()
      return { status: 'ok', cardId: candidate.id, staged: true }
    }
  }

  function show(input: ShowInput): DeskResult {
    if (input.ttl === undefined || input.ttl === null)
      return { status: 'rejected', code: 'TTL_REQUIRED', message: '卡片必须声明 ttl，否则会在桌面堆积' }

    // 尺寸三级：显式（调用方）> 建议（内容反查）> 模板默认。
    // 有 items 的卡按条数挑最小能装下的档——3 条候选不该占半屏空一半
    const tmplDefault = CARD_TEMPLATES.find(t => t.id === input.template)?.defaultSize as Size | undefined
    const size = input.size
      ?? (Array.isArray(input.data?.items) && input.data.items.length
            ? suggestSize(input.template, input.data.items.length) as Size
            : undefined)
      ?? tmplDefault ?? '1/6'
    const sizeErr = checkSize(input.template, size)
    if (sizeErr) return { status: 'rejected', ...sizeErr }
    const id = input.id ?? `card_${++seq}`
    const card: Card = {
      id, key: input.key, template: input.template, size, kind: input.kind ?? 'task',
      desiredSize: size,   // 仲裁自降只改 size；这里记住"本来该多大"
      family: input.family, anchor: input.anchor,
      round: input.family ? (input.round ?? ++familyAutoRound) : undefined,
      urgency: normalizeUrgency(input.urgency),
      data: input.data ?? {}, ttl: input.ttl, evictable: input.evictable ?? true,
      minSize: input.minSize,
      createdAt: clock(), touchedAt: clock(),
    }

    if (isEmptyList(input.template, input.data)) return {
      status: 'rejected', code: 'EMPTY_CARD',
      message: '一条都没搜到，这张卡是空的，没往屏上放——直接开口告诉用户没找到',
    }

    const toOverlay = (): DeskResult => { // 整屏覆盖：不占栅格，退出还原
      /**
       * **进新的先退旧的。** 不清旧覆盖层的话它会留在 cards 里变成孤儿：
       * others() 只排除**当前**那张，于是这张占满 12×4 的卡参与每一次布局
       * 试放，tryPlace 恒失败被 `?? []` 吞成空数组——桌面上所有卡一起消失；
       * 紧接着 refill 看到规则卡"不在台上"就重新断言 → update → emit →
       * refill…… 同步无限递归直接爆栈，整个页面死掉。
       */
      if (overlay && overlay !== id) cards.delete(overlay)
      cards.set(id, card)
      sweepFamily(card)
      overlay = id
      emit()
      return { status: 'ok', cardId: id }
    }
    // 通道分派统一走判据表（channelOf）——它不再是带测试的死代码
    if (channelOf({ size, urgency: card.urgency }) === 'overlay' && size === 'full') return toOverlay()
    const isCritical = channelOf({ urgency: card.urgency }) === 'overlay'
    // critical 放不下时要拦在"进等位区"之前改走覆盖层——覆盖层不是垃圾桶，
    // 但 critical 更不该在后台队列里等，它必须立刻可见
    const r = fit(card, 'assert', isCritical ? 'reject' : 'stage')
    /**
     * **安全告警被拒是事故。**
     *
     * 真实几何：导航 stage（8×4，不可挤）在场时右边只剩 4×4 竖条，
     * 而 critical 的最小档是 panel（8×2）—— 桌面上真的没有它的位置。
     * 老逻辑走到这里返回 DESKTOP_FULL，车门没关这件事用户就永远不知道。
     *
     * 改走覆盖层：critical 本来就该盖住一切，这也正是三通道里
     * `channelOf()` 给 critical 的答案。只对 critical 生效 ——
     * 覆盖层不是放不下就往里扔的垃圾桶。
     */
    if (r.status === 'rejected' && isCritical) return toOverlay()
    return r
  }

  function update(id: string, data: any): DeskResult {
    const c = getById(id)
    if (!c) return { status: 'rejected', code: 'NO_SUCH_CARD', message: `找不到卡片 ${id}` }
    const next = { ...c.data, ...data }
    // 真变了才通知（JSON 比对够用：卡片 data 本来就是可序列化的投影数据）
    const changed = JSON.stringify(next) !== JSON.stringify(c.data)
    c.data = next
    c.touchedAt = clock()
    if (changed) dataChangeListeners.forEach(l => l(id))
    emit()
    return { status: 'ok', cardId: id }
  }

  /**
   * @param byUser 是不是用户的意愿。true 会给卡片上尺寸锁，之后规则重刷不再改它。
   *   render() 内部的放大传 false——那是系统在恢复默认值，不是用户要求的
   */
  function resizeGate(id: string, size: Size): DeskResult | null {
    const c = getById(id)
    if (!c) return null
    const err = checkSize(c.template, size)
    return err ? { status: 'rejected', ...err } : null
  }

  function resize(id: string, size: Size, byUser = true): DeskResult {
    const c = getById(id)
    if (!c) return { status: 'rejected', code: 'NO_SUCH_CARD', message: `找不到卡片 ${id}` }
    const gateErr = resizeGate(id, size)
    if (gateErr) return gateErr
    const prev = c.size
    c.size = size
    // 台上的卡要过几何检查；等位区里的卡不占栅格，不需要——它的尺寸
    // 在上台那一刻由 fit() 重新校验
    if (cards.has(id) && !tryPlace(others())) {
      c.size = prev
      return { status: 'rejected', code: 'NO_ROOM', message: '这个尺寸放不下了' }
    }
    if (byUser) c.sizeLocked = true
    c.desiredSize = size   // 无论谁改的，新尺寸就是新的恢复目标
    c.touchedAt = clock()
    emit()
    return { status: 'ok', cardId: id }
  }

  /**
   * 卡片右上角尺寸调节按钮的机制半边：在模板允许的尺寸表里按当前尺寸走一档。
   *
   * **不走 LADDER**——LADDER 是"自动仲裁怎么退让"的内部实现，只有七档，
   * 2/3（stage）/tower/full 这些专用档故意不进去（退成 tower 会变成一条竖缝）。
   * 按钮认的是 checkSize 那张"这个模板到底允许哪些尺寸"的表，按占用单元数
   * 从小到大排序——2/3 天然排在最后，导航卡从 1/2 grow 上去就是它。
   * 到头不是拒绝一次性能力，是按钮下一次该自己失效（越界照样返回 rejected 供调用方判断）。
   */
  /** step()/canStep() 共用：这张卡按钮能走到的尺寸表 —— 跟仲裁降级同一张表 */
  function sizeSteps(c: Card): { allowed: Size[]; pos: number } {
    const allowed = allowedSizes(c)
    const curKey = normalizeTier(c.size)
    const pos = Math.max(0, allowed.findIndex(s => normalizeTier(s) === curKey))
    return { allowed, pos }
  }

  /**
   * 放大：用户点了放大按钮就是明确表态"这张卡现在最重要"——优先级最高，
   * 需要地方就挤。硬保护不因为这是"放大"就被打破：evictableAt 的 urgent+
   * 与 evictable:false 依旧摸不到。
   *
   * **够不到就原样还原并如实拒绝。** 老实现先把卡从 cards 里摘掉再 fit，
   * 失败时它就留在了等位区——卡片被自己的放大按钮送下台，而且 sizeLocked
   * 已锁在够不到的档位上，reconcile 永远重试失败，再也回不来（实拍复现）。
   */
  function growTo(id: string, size: Size): DeskResult {
    const c = getById(id)
    if (!c) return { status: 'rejected', code: 'NO_SUCH_CARD', message: `找不到卡片 ${id}` }
    const prev = { size: c.size, desiredSize: c.desiredSize, sizeLocked: c.sizeLocked }
    c.size = size
    c.desiredSize = size
    c.sizeLocked = true
    const r = fit(c, 'grow')
    // 没长大就当无事发生：尺寸、恢复目标、尺寸锁全部还原
    if (r.status !== 'ok' || r.staged) Object.assign(c, prev)
    return r
  }

  function step(id: string, dir: 'up' | 'down'): DeskResult {
    const c = getById(id)
    if (!c) return { status: 'rejected', code: 'NO_SUCH_CARD', message: `找不到卡片 ${id}` }
    const { allowed, pos } = sizeSteps(c)
    const next = dir === 'down' ? pos - 1 : pos + 1
    if (next < 0 || next >= allowed.length)
      return { status: 'rejected', code: 'SIZE_NOT_SUPPORTED', message: dir === 'down' ? '已经是最小尺寸了' : '已经是最大尺寸了' }
    return dir === 'up' ? growTo(id, allowed[next] as Size) : resize(id, allowed[next] as Size, true)
  }

  /**
   * 按钮该不该显示/置灰查这个——车机屏（不许有业务逻辑）拿它决定渲染，
   * 不用自己重算一遍"这个模板允许哪些尺寸"。
   */
  function canStep(id: string, dir: 'up' | 'down'): boolean {
    const c = getById(id)
    if (!c) return false
    const { allowed, pos } = sizeSteps(c)
    const next = dir === 'down' ? pos - 1 : pos + 1
    return next >= 0 && next < allowed.length
  }

  function dismiss(id: string, opts?: { byUser?: boolean }): DeskResult {
    const c = getById(id)
    if (!c) return { status: 'rejected', code: 'NO_SUCH_CARD', message: `找不到卡片 ${id}` }
    // 用户亲手关的规则卡不许被 reconcile 立刻补回（诈尸）——
    // 抑制到 watch 信号下次变化（render 会清除抑制，规则重新断言）
    if (opts?.byUser && c.key) suppressed.add(c.key)
    const wasOnstage = cards.has(id)
    cards.delete(id)
    staged.delete(id)
    if (overlay === id) overlay = undefined
    if (!wasOnstage) { emit(); return { status: 'ok', cardId: id } }   // 台下卡撤走不占栅格，不触发回落
    releasedAt = clock()   // 空间释放：2 秒迟滞后尺寸回落（tick 里做）
    emit()
    return { status: 'ok', cardId: id }
  }

  const focus = (id: string): DeskResult => {
    // 台下卡的 focus = 召回：立即尝试上台，必要时挤走优先级不高于它的
    // （用户点名要看的卡，等位区规则不该让它继续等）
    const staging = staged.get(id)
    if (staging) return fit(staging, 'recall')
    const c = cards.get(id)
    if (!c) return { status: 'rejected', code: 'NO_SUCH_CARD', message: `找不到卡片 ${id}` }
    c.touchedAt = clock()
    emit()
    return { status: 'ok', cardId: id }
  }

  /** 反馈级联核心：优先复用已有卡(L1) → 放大(L2) → 最后才新建(L3) */
  function render(i: ShowInput & { key: string }): DeskResult {
    suppressed.delete(i.key)   // 规则/handler 重新断言这张卡 → 抑制解除
    // 台上台下都要认——不然刷新一张排队中的卡会被当成新卡重建，家族/轮次全丢
    const exist = [...cards.values(), ...staged.values()].find(c => c.key === i.key)
    // 刷新成空列表 = 这批内容没了，撤卡而不是留个空壳在那儿
    if (isEmptyList(i.template, i.data)) {
      if (exist) dismiss(exist.id)
      return { status: 'rejected', code: 'EMPTY_CARD', message: '一条都没有，卡撤了' }
    }
    // 刷新时的期望尺寸：显式 > 内容建议 > 维持现状。
    // 候选从 3 条刷成 10 条时要能长大，反过来（10→3）也能在 reconcile 时缩回
    const want = (i.size
      ?? (Array.isArray(i.data?.items) && i.data.items.length
            ? suggestSize(i.template, i.data.items.length) as Size : undefined)
      ?? exist?.size ?? '1/6') as Size
    if (exist) {
      if (i.refreshTtl) exist.createdAt = clock()
      if (i.family) {
        exist.family = i.family
        exist.round = i.round ?? ++familyAutoRound
        sweepFamily(exist)   // 同城再查也是新批——别的城该走了
      }
      // 排队中的卡被重新断言 = 一次上台机会，不必干等下一次 tick。
      // 规则每次重刷都会 render() 同一个 key（比如车还在放歌，player 一直被重新断言）——
      // 这正是"空间一释放自动回来"的真实路径：不靠内部定时器，靠外部信号驱动重试。
      // 直接改 data 不走 update()：update() 的 emit 会重入 refill() 订阅，
      // 桌面真满、fit() 注定失败时会跟 refill() 互相递归，栈溢出
      if (staged.has(exist.id)) {
        const next = { ...exist.data, ...(i.data ?? {}) }
        const changed = JSON.stringify(next) !== JSON.stringify(exist.data)
        exist.data = next
        exist.touchedAt = clock()
        if (changed) dataChangeListeners.forEach(l => l(exist.id))
        if (!exist.sizeLocked) exist.size = want
        return fit(exist, 'assert')   // 成功才 emit；再次失败保持静默
      }
      // 用户显式调过尺寸就只更新数据。桌面是 f(车辆状态)，导航中 ETA 每变一次
      // 就重刷一次，不认这个锁的话"地图小一点"下一秒就被弹回去
      if (exist.sizeLocked || cellsOfTier(exist.size) >= cellsOfTier(want)) {
        const r = update(exist.id, i.data ?? {})
        return { ...r, level: 'L1' }
      }
      const r = resize(exist.id, want, false)
      if (r.status !== 'ok') { update(exist.id, i.data ?? {}); return { ...r, cardId: exist.id } }
      update(exist.id, i.data ?? {})
      return { ...r, level: 'L2' }
    }
    const r = show(i)
    return r.status === 'ok' ? { ...r, level: 'L3' } : r
  }

  /** ttl 到期清理 + 尺寸回落 + 等位区上台巡查 */
  function tick() {
    const t = clock()
    for (const c of [...cards.values()])
      if (typeof c.ttl === 'number' && t - c.createdAt >= c.ttl * 1000) dismiss(c.id)
    // 等位区里秒数 ttl 照样算——没人看到的问题卡更不该继续排队等一个
    // 谁都看不见的超时（untilDismissed 的 ttl 不是 number，天然跳过这条）
    for (const c of [...staged.values()])
      if (typeof c.ttl === 'number' && t - c.createdAt >= c.ttl * 1000) staged.delete(c.id)
    // 尺寸回落：空间释放满 2 秒才动手（防抖——候选卡进进出出时天气不能跟着抖），
    // 静默进行：挤出打扰了用户所以要告知，恢复不是打扰
    if (releasedAt !== undefined && t - releasedAt >= 2000) {
      releasedAt = undefined
      const pressed = [...cards.values()]
        .filter(c => c.desiredSize && cellsOfTier(c.size) < cellsOfTier(c.desiredSize))
        // 回落序：只看优先级，不做 tie-break——谁先回落对用户没有可辨差别，
        // 刻意不复用 byStageOrder（那条的 createdAt 次序是"排队先后"，语义不同）
        .sort((a, b) => PRIO(b) - PRIO(a))
      for (const c of pressed) resize(c.id, c.desiredSize!, false)   // 失败就留在原档，下次释放再试
    }
    // 等位区上台：每 tick 依序尝试，只用真空出来的空间（被动，不惊动任何人）——
    // "放不下"是状态不是失败，空间够了它自己会回来
    const queue = [...staged.values()].sort(byStageOrder)
    for (const c of queue) if (staged.has(c.id)) fit(c, 'reconcile')
    emit()
  }

  function endTask() {
    for (const c of [...cards.values()]) if (c.ttl === 'untilTaskEnd') dismiss(c.id)
  }

  function layout() {
    const placed = tryPlace(others()) ?? []
    // 落位写回记忆——下次布局先试这里。只在真实布局（layout()）写，
    // 仲裁过程中的试算（fit 里的 tryPlace）不算数
    for (const pc of placed) { const c = cards.get(pc.id); if (c) c.prevPos = { row: pc.row, col: pc.col } }
    // 队列顺序即上台顺序——UI（边缘条/台下清单卡）和 reconcile 看到的是同一个排序
    const staging = [...staged.values()].sort(byStageOrder)
    return {
      cards: placed,
      free: GRID.cols * GRID.rows - placed.reduce((n, c) => n + cellsOfTier(c.size), 0),
      overlay: overlay ? cards.get(overlay) : undefined,
      staged: staging,
    }
  }

  /** 注入 system prompt 的紧凑描述——实现在 summary.ts（模型视角生成器独立成模块） */
  const summary = () => summarize(layout())

  return {
    show, update, resize, step, canStep, dismiss, focus, render, tick, endTask, layout, summary,
    get: (id: string) => getById(id),
    findByKey: (key: string) => [...cards.values(), ...staged.values()].find(c => c.key === key),
    isSuppressed: (key: string) => suppressed.has(key),
    cellsOf: (s: Size) => cellsOfTier(s),
    ladder: () => [...LADDER],
    priorityOf: (k: Kind, u?: Urgency) => prioOf(k, u),
    subscribe: (cb: () => void) => { listeners.push(cb); return () => listeners.splice(listeners.indexOf(cb), 1) },
    onDataChange: (cb: (id: string) => void) => {
      dataChangeListeners.push(cb); return () => dataChangeListeners.splice(dataChangeListeners.indexOf(cb), 1)
    },
    onNotice: (cb: (n: { note: string; titles: string[] }) => void) => {
      noticeListeners.push(cb); return () => noticeListeners.splice(noticeListeners.indexOf(cb), 1)
    },
  }
}

export type Desk = ReturnType<typeof createDesk>
