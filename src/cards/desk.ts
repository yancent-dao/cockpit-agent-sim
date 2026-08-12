import { CARD_TEMPLATES } from '../config/cards'
import { formOf, suggestSize } from '../config/forms'
import { checkSize } from './contract'
import { GRID, LADDER as TIER_LADDER, type TierName, listCapacity, dimsOf, cellsOfTier, normalizeTier } from '../config/grid'
import { type Urgency, priorityOf as prioOf, evictableAt, minTierFor, normalizeUrgency } from '../config/priority'

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
/** 阶梯里的位置。老名字先归一，否则 '1/6' 查不到 */
const rung = (s: Size) => LADDER.indexOf(normalizeTier(s))
/** 卡片能缩到的最低档；没声明 minSize 就一路缩到 1/6 */
/**
 * 能缩到的最低档。显式 minSize 优先；没写就按 urgency 兜底 ——
 * critical 缩到只剩一个标题等于没显示。
 */
const floorIdx = (c: { minSize?: Size; urgency?: Urgency; template?: string }) => {
  const rungs: number[] = [0]
  // ① 调用方显式声明的下限
  if (c.minSize) rungs.push(rung(c.minSize))
  // ② 模板自己的下限：列表类缩到 chip 只剩标题、选项全丢，那一格还不如让给别人
  const tmpl = c.template ? CARD_TEMPLATES.find(t => t.id === c.template) : undefined
  if (tmpl?.sizes?.length) {
    const smallest = tmpl.sizes.reduce((a, b) => (cellsOfTier(a) <= cellsOfTier(b) ? a : b))
    const i = LADDER.indexOf(normalizeTier(smallest))
    if (i >= 0) rungs.push(i)
  }
  // ③ 紧急度下限：critical 缩到只剩一个标题等于没显示
  const i2 = LADDER.findIndex(t => cellsOfTier(t) >= cellsOfTier(minTierFor(c.urgency)))
  if (i2 >= 0) rungs.push(i2)
  // 三个都是"不能再小"，取最严的那个
  return Math.max(...rungs)
}
const canShrink = (c: { size: Size; minSize?: Size; urgency?: Urgency; template?: string }) => rung(c.size) > floorIdx(c)
/**
 * 优先级 = kind 权重 + urgency 权重，表在 src/config/priority.ts。
 * kind 描述「谁建的卡」，urgency 描述「这事有多急」—— 两个维度正交。
 * 只看 kind 的话，车门没关且已起步的安全告警跟天气卡同为 rule，
 * 抢位时按 LRU 决定谁活。
 */
const PRIO = (c: { kind: Kind; urgency?: Urgency }) => prioOf(c.kind, c.urgency)

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
}

export interface DeskResult {
  status: 'ok' | 'rejected'
  cardId?: string
  code?: string
  message?: string
  /** 为了腾位被降过尺寸的卡（含新卡自己） */
  shrunk?: string[]
  /** 被挤出的卡 —— 必须告知用户 */
  evicted?: string[]
  /** 人话，供 Agent 播报 */
  note?: string
  level?: 'L1' | 'L2' | 'L3'
}


/**
 * 列表类卡片一条内容都没有 —— **空卡比不显示更糟**。
 *
 * 跑批（nav-cross-province）撞出来的：川藏线上搜服务区返回 0 条，
 * handler 照样建卡，屏上留着一张「附近的服务区」标题下面什么都没有的空壳。
 * 用户看到标题会以为在加载；Agent 那边还占着一个格子。
 *
 * 这不是"贴心逻辑"（那是 Tool 内不许有的东西），是**卡片契约**：
 * 一张列表卡的意思就是"这里有几条东西"，0 条时这句话是假的。
 */
const isEmptyList = (template: string, data: any) =>
  (template === 'list' || template === 'capability')
  && Array.isArray(data?.items) && data.items.length === 0

const titleOf = (c: Card) =>
  c.data?.title ?? CARD_TEMPLATES.find(t => t.id === c.template)?.label ?? c.template

export function createDesk(clock: () => number = Date.now) {
  const cards = new Map<string, Card>()
  let overlay: string | undefined
  let seq = 0
  const listeners: Array<() => void> = []
  const emit = () => listeners.forEach(l => l())
  /**
   * 挤出告知。desk 只发**事实**（这几张卡被收起来了、人话怎么说），
   * 怎么显示由 UI 决定 —— 走横幅还是走播报不是桌面该管的事。
   * 静默消失不可接受：用户刚看的天气卡没了得有个交代。
   */
  const noticeListeners: Array<(n: { note: string; titles: string[] }) => void> = []

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
    for (const c of order) {
      const shape = shapeOf(c.size)
      let placed: PlacedCard | null = null
      // 列起点只取偶数 —— 配合「档位宽度一律偶数」，空隙必为偶数宽，chip 永远填得上
      const cols: number[] = []
      for (let i = 0; i + shape.w <= COLS; i += 2) cols.push(i)
      // 行起点按自身高度对齐：半高档只落 0/2，不会错位出一条高 1 的横缝
      const rowStep = shape.h >= 2 ? 2 : 1
      outer: for (let r = 0; r + shape.h <= ROWS; r += rowStep) {
        for (const c0 of cols) {
          let free = true
          for (let dr = 0; dr < shape.h; dr++)
            for (let dc = 0; dc < shape.w; dc++) if (grid[r + dr][c0 + dc]) { free = false; break }
          if (!free) continue
          for (let dr = 0; dr < shape.h; dr++)
            for (let dc = 0; dc < shape.w; dc++) grid[r + dr][c0 + dc] = true
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
   * 腾位循环：① 原尺寸直接放 ② 降一张低优先级卡的尺寸 ③ 降新卡自己的尺寸
   * ④ LRU 挤出一张低优先级卡 ⑤ 几何死局的最后手段：降高优先级卡的尺寸
   * （绝不挤出高优先级卡）⑥ 都不行才拒绝。每步之后从头再试。
   */
  function fit(candidate: Card): DeskResult {
    const shrunk: string[] = []
    const evicted: string[] = []
    const titles: string[] = []
    const existing = others()
    let size = candidate.size

    // urgent 以上不可挤 —— 安全告警被 LRU 挤掉是事故，等着用户回应的问题卡也一样。
    // 显式 evictable:false 仍然优先（导航中的导航卡）
    const alive = () => existing.filter(c => c.evictable && evictableAt(c.urgency) && !shrunkOut.has(c.id))
    const byPriorityLRU = (a: Card, b: Card) => PRIO(a) - PRIO(b) || a.touchedAt - b.touchedAt
    const victims = () => alive()
      .filter(c => PRIO(c) <= PRIO(candidate))
      .sort(byPriorityLRU)
    const shrunkOut = new Set<string>() // 已挤出的不再参与

    for (;;) {
      const trial = { ...candidate, size }
      const pool = existing.filter(c => !shrunkOut.has(c.id))
      if (tryPlace([...pool, trial])) {
        if (size !== candidate.size) shrunk.push(candidate.id)
        candidate.size = size
        for (const id of evicted) cards.delete(id)
        cards.set(candidate.id, candidate)
        const note = titles.length ? `我把${titles.map(t => `「${t}」`).join('、')}收起来了` : undefined
        if (note) noticeListeners.forEach(l => l({ note, titles: [...titles] }))
        emit()
        return {
          status: 'ok', cardId: candidate.id,
          ...(shrunk.length && { shrunk }),
          ...(evicted.length && { evicted, note }),
        }
      }
      // ② 降一张已有低优先级卡
      const shrinkable = victims().find(canShrink)
      if (shrinkable) { shrinkable.size = LADDER[rung(shrinkable.size) - 1]; shrunk.push(shrinkable.id); continue }
      // ③ 降新卡自己
      const selfIdx = rung(size)
      if (selfIdx > floorIdx(candidate)) { size = LADDER[selfIdx - 1]; continue }
      // ④ LRU 挤出（只挤优先级不高于来者的）
      const victim = victims()[0]
      if (victim) {
        shrunkOut.add(victim.id)
        evicted.push(victim.id)
        titles.push(titleOf(victim))
        size = candidate.size // 腾出空间后恢复原始期望尺寸重试
        continue
      }
      // ⑤ 几何死局最后手段：高优先级卡也可降尺寸（如 2/3 导航到来时 system 1/3 放不进右列）
      const highShrinkable = alive().filter(canShrink).sort(byPriorityLRU)[0]
      if (highShrinkable) {
        // 必须走 rung()：LADDER 存的是新档位名，直接 indexOf('1/3') 是 -1，
        // 再减一取到 LADDER[-2] = undefined，卡片的 size 就没了
        highShrinkable.size = LADDER[rung(highShrinkable.size) - 1]
        shrunk.push(highShrinkable.id)
        continue
      }
      return { status: 'rejected', code: 'DESKTOP_FULL', message: '桌面已满，且没有可以让位的卡片' }
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
      cards.set(id, card)
      overlay = id
      emit()
      return { status: 'ok', cardId: id }
    }
    if (size === 'full') return toOverlay()
    const r = fit(card)
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
    if (r.status === 'rejected' && card.urgency === 'critical') return toOverlay()
    return r
  }

  function update(id: string, data: any): DeskResult {
    const c = cards.get(id)
    if (!c) return { status: 'rejected', code: 'NO_SUCH_CARD', message: `找不到卡片 ${id}` }
    c.data = { ...c.data, ...data }
    c.touchedAt = clock()
    emit()
    return { status: 'ok', cardId: id }
  }

  /**
   * @param byUser 是不是用户的意愿。true 会给卡片上尺寸锁，之后规则重刷不再改它。
   *   render() 内部的放大传 false——那是系统在恢复默认值，不是用户要求的
   */
  function resizeGate(id: string, size: Size): DeskResult | null {
    const c = cards.get(id)
    if (!c) return null
    const err = checkSize(c.template, size)
    return err ? { status: 'rejected', ...err } : null
  }

  function resize(id: string, size: Size, byUser = true): DeskResult {
    const c = cards.get(id)
    if (!c) return { status: 'rejected', code: 'NO_SUCH_CARD', message: `找不到卡片 ${id}` }
    const gateErr = resizeGate(id, size)
    if (gateErr) return gateErr
    const prev = c.size
    c.size = size
    if (!tryPlace(others())) {
      c.size = prev
      return { status: 'rejected', code: 'NO_ROOM', message: '这个尺寸放不下了' }
    }
    if (byUser) c.sizeLocked = true
    c.touchedAt = clock()
    emit()
    return { status: 'ok', cardId: id }
  }

  function dismiss(id: string): DeskResult {
    if (!cards.has(id)) return { status: 'rejected', code: 'NO_SUCH_CARD', message: `找不到卡片 ${id}` }
    cards.delete(id)
    if (overlay === id) overlay = undefined
    emit()
    return { status: 'ok', cardId: id }
  }

  const focus = (id: string): DeskResult => {
    const c = cards.get(id)
    if (!c) return { status: 'rejected', code: 'NO_SUCH_CARD', message: `找不到卡片 ${id}` }
    c.touchedAt = clock()
    emit()
    return { status: 'ok', cardId: id }
  }

  /** 反馈级联核心：优先复用已有卡(L1) → 放大(L2) → 最后才新建(L3) */
  function render(i: ShowInput & { key: string }): DeskResult {
    const exist = [...cards.values()].find(c => c.key === i.key)
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

  /** ttl 到期清理 */
  function tick() {
    const t = clock()
    for (const c of [...cards.values()])
      if (typeof c.ttl === 'number' && t - c.createdAt >= c.ttl * 1000) dismiss(c.id)
  }

  function endTask() {
    for (const c of [...cards.values()]) if (c.ttl === 'untilTaskEnd') dismiss(c.id)
  }

  function layout() {
    const placed = tryPlace(others()) ?? []
    return {
      cards: placed,
      free: GRID.cols * GRID.rows - placed.reduce((n, c) => n + cellsOfTier(c.size), 0),
      overlay: overlay ? cards.get(overlay) : undefined,
    }
  }

  /** 注入 system prompt 的紧凑描述 */
  function summary(): string {
    const l = layout()
    const lines: string[] = []
    if (l.overlay) lines.push(`全屏卡：${titleOf(l.overlay)}（占据整屏，关闭后自动还原）`)
    // 摘要是给**模型**看的。48 单元下说"剩余 16 格"它没法换算成
    // "还能不能再上一张卡"，只会瞎猜。按基准卡（1/6）张数说人话
    const slots = Math.floor(l.free / cellsOfTier('1/6'))
    const room = slots > 0 ? `还放得下 ${slots} 张小卡` : `已经放满了，再上卡就得收起一张`
    lines.push(l.cards.length
      ? `桌面卡片：${l.cards.map(c => `${titleOf(c)}(${c.size})`).join('、')}，${room}`
      : `桌面为空，${room}`)
    // 截断信息必须回给 Agent。只做 UI 的话模型以为屏上有 12 条、
    // 张口就说"第 10 个"，而用户根本看不到第 5 条之后的东西
    for (const c of l.cards) {
      // 可见条数由**形态函数**给——跟车机屏画的是同一个数（公理 2：
      // 世界观由结构保证）。之前这里用 listCapacity 自己重算，
      // 能力目录 @1/2 出过 summary 说 12、屏幕画 4 的分裂
      const total = Array.isArray(c.data?.items) ? c.data.items.length : 0
      const visible = formOf(c.template, ...dimsOf(c.size)).maxItems ?? total
      const n = Number(c.data?.moreCount ?? Math.max(0, total - visible))
      if (n > 0) lines.push(`「${titleOf(c)}」屏上只显示了前 ${total - n} 条，还有 ${n} 条没显示——别提没显示的那些`)
    }
    return lines.join('\n')
  }

  return {
    show, update, resize, dismiss, focus, render, tick, endTask, layout, summary,
    get: (id: string) => cards.get(id),
    findByKey: (key: string) => [...cards.values()].find(c => c.key === key),
    cellsOf: (s: Size) => cellsOfTier(s),
    ladder: () => [...LADDER],
    priorityOf: (k: Kind, u?: Urgency) => prioOf(k, u),
    subscribe: (cb: () => void) => { listeners.push(cb); return () => listeners.splice(listeners.indexOf(cb), 1) },
    onNotice: (cb: (n: { note: string; titles: string[] }) => void) => {
      noticeListeners.push(cb); return () => noticeListeners.splice(noticeListeners.indexOf(cb), 1)
    },
  }
}

export type Desk = ReturnType<typeof createDesk>
