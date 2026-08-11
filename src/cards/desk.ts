import { CARD_TEMPLATES } from '../config/cards'

/**
 * 卡片桌面（无APP化）—— 2026-08-10 重设计，见 docs/superpowers/specs/2026-08-10-card-orchestration-design.md
 *
 * 统一 6 格画布（3列×2行），无分区、无常驻卡，默认为空，一切按需出现。
 * 每个尺寸只允许一种形状；2/3 只允许左锚定 —— 布局问题保持可枚举，
 * **可预测优先于最优**：同一场景每次演示长得一样。
 *
 * 仲裁全部确定性：
 *   放置顺序 = 2/3 卡最先（唯一合法位置）→ 优先级降序 → 创建时间升序
 *   空间不够 = 降低优先级卡的尺寸 → 降新卡自己的尺寸 → LRU 挤出 → 拒绝
 *   evictable:false 永不被挤（导航中的导航卡）
 *   挤出必须告知（note 带人话标题），静默消失不可接受
 */

export type Size = '1/6' | '1/3' | '1/2' | '2/3' | 'full'
export type Kind = 'task' | 'rule' | 'system'
export type Ttl = 'untilDismissed' | 'untilTaskEnd' | number

const ROWS = 2, COLS = 3
const SHAPES: Record<Exclude<Size, 'full'>, { w: number; h: number }> = {
  '1/6': { w: 1, h: 1 }, '1/3': { w: 2, h: 1 }, '1/2': { w: 3, h: 1 }, '2/3': { w: 2, h: 2 },
}
const CELLS: Record<Size, number> = { '1/6': 1, '1/3': 2, '1/2': 3, '2/3': 4, full: 6 }
/** 阶梯降尺寸。2/3 不参与——只有规则导航卡用它且不可挤 */
const LADDER: Size[] = ['1/6', '1/3', '1/2']
/** 卡片能缩到的最低档；没声明 minSize 就一路缩到 1/6 */
const floorIdx = (c: { minSize?: Size }) => Math.max(0, LADDER.indexOf(c.minSize ?? '1/6'))
const canShrink = (c: { size: Size; minSize?: Size }) => LADDER.indexOf(c.size) > floorIdx(c)
const PRIORITY: Record<Kind, number> = { task: 2, rule: 3, system: 4 }

export interface Card {
  id: string
  key?: string
  template: string
  size: Size
  kind: Kind
  data: any
  ttl: Ttl
  evictable: boolean
  minSize?: Size
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

const titleOf = (c: Card) =>
  c.data?.title ?? CARD_TEMPLATES.find(t => t.id === c.template)?.label ?? c.template

export function createDesk(clock: () => number = Date.now) {
  const cards = new Map<string, Card>()
  let overlay: string | undefined
  let seq = 0
  const listeners: Array<() => void> = []
  const emit = () => listeners.forEach(l => l())

  /** 确定性放置：2/3 最先，然后优先级降序、创建时间升序，行优先扫第一个合法位置 */
  function tryPlace(list: Card[]): PlacedCard[] | null {
    const order = [...list].sort((a, b) => {
      const a23 = a.size === '2/3' ? 1 : 0, b23 = b.size === '2/3' ? 1 : 0
      if (a23 !== b23) return b23 - a23
      const pa = PRIORITY[a.kind], pb = PRIORITY[b.kind]
      if (pa !== pb) return pb - pa
      return a.createdAt - b.createdAt
    })
    const grid: boolean[][] = [[false, false, false], [false, false, false]]
    const out: PlacedCard[] = []
    for (const c of order) {
      const shape = SHAPES[c.size as Exclude<Size, 'full'>]
      let placed: PlacedCard | null = null
      const cols = c.size === '2/3' ? [0] : Array.from({ length: COLS - shape.w + 1 }, (_, i) => i)
      outer: for (let r = 0; r + shape.h <= ROWS; r++) {
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

    const alive = () => existing.filter(c => c.evictable && !shrunkOut.has(c.id))
    const byPriorityLRU = (a: Card, b: Card) => PRIORITY[a.kind] - PRIORITY[b.kind] || a.touchedAt - b.touchedAt
    const victims = () => alive()
      .filter(c => PRIORITY[c.kind] <= PRIORITY[candidate.kind])
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
        emit()
        return {
          status: 'ok', cardId: candidate.id,
          ...(shrunk.length && { shrunk }),
          ...(evicted.length && { evicted, note }),
        }
      }
      // ② 降一张已有低优先级卡
      const shrinkable = victims().find(canShrink)
      if (shrinkable) { shrinkable.size = LADDER[LADDER.indexOf(shrinkable.size) - 1]; shrunk.push(shrinkable.id); continue }
      // ③ 降新卡自己
      const selfIdx = LADDER.indexOf(size)
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
        highShrinkable.size = LADDER[LADDER.indexOf(highShrinkable.size) - 1]
        shrunk.push(highShrinkable.id)
        continue
      }
      return { status: 'rejected', code: 'DESKTOP_FULL', message: '桌面已满，且没有可以让位的卡片' }
    }
  }

  function show(input: ShowInput): DeskResult {
    if (input.ttl === undefined || input.ttl === null)
      return { status: 'rejected', code: 'TTL_REQUIRED', message: '卡片必须声明 ttl，否则会在桌面堆积' }

    const size = input.size ?? '1/6'
    const id = input.id ?? `card_${++seq}`
    const card: Card = {
      id, key: input.key, template: input.template, size, kind: input.kind ?? 'task',
      data: input.data ?? {}, ttl: input.ttl, evictable: input.evictable ?? true,
      minSize: input.minSize,
      createdAt: clock(), touchedAt: clock(),
    }

    if (size === 'full') { // 整屏覆盖：不占栅格，退出还原
      cards.set(id, card)
      overlay = id
      emit()
      return { status: 'ok', cardId: id }
    }
    return fit(card)
  }

  function update(id: string, data: any): DeskResult {
    const c = cards.get(id)
    if (!c) return { status: 'rejected', code: 'NO_SUCH_CARD', message: `找不到卡片 ${id}` }
    c.data = { ...c.data, ...data }
    c.touchedAt = clock()
    emit()
    return { status: 'ok', cardId: id }
  }

  function resize(id: string, size: Size): DeskResult {
    const c = cards.get(id)
    if (!c) return { status: 'rejected', code: 'NO_SUCH_CARD', message: `找不到卡片 ${id}` }
    const prev = c.size
    c.size = size
    if (!tryPlace(others())) {
      c.size = prev
      return { status: 'rejected', code: 'NO_ROOM', message: '这个尺寸放不下了' }
    }
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
    const want = i.size ?? '1/6'
    if (exist) {
      if (i.refreshTtl) exist.createdAt = clock()
      if (CELLS[exist.size] >= CELLS[want]) {
        const r = update(exist.id, i.data ?? {})
        return { ...r, level: 'L1' }
      }
      const r = resize(exist.id, want)
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
      free: 6 - placed.reduce((n, c) => n + CELLS[c.size], 0),
      overlay: overlay ? cards.get(overlay) : undefined,
    }
  }

  /** 注入 system prompt 的紧凑描述 */
  function summary(): string {
    const l = layout()
    const lines: string[] = []
    if (l.overlay) lines.push(`全屏卡：${titleOf(l.overlay)}（占据整屏，关闭后自动还原）`)
    lines.push(l.cards.length
      ? `桌面卡片：${l.cards.map(c => `${titleOf(c)}(${c.size})`).join('、')}，剩余 ${l.free} 格`
      : `桌面为空，剩余 6 格`)
    return lines.join('\n')
  }

  return {
    show, update, resize, dismiss, focus, render, tick, endTask, layout, summary,
    get: (id: string) => cards.get(id),
    findByKey: (key: string) => [...cards.values()].find(c => c.key === key),
    cellsOf: (s: Size) => CELLS[s],
    priorityOf: (k: Kind) => PRIORITY[k],
    subscribe: (cb: () => void) => { listeners.push(cb); return () => listeners.splice(listeners.indexOf(cb), 1) },
  }
}

export type Desk = ReturnType<typeof createDesk>
