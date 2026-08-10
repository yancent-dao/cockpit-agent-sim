/**
 * 卡片桌面（无APP化）
 *
 * 栅格 3 列 × 2 行：上行 Agent 区，下行固定区。
 * 每个尺寸只允许一种形状 → 布局退化为一维排布，不做二维装箱。
 * 卡片按插入顺序左对齐，不产生碎片 —— **可预测优先于最优**。
 */

export type Size = '1/6' | '1/3' | '1/2' | 'full'
export type Zone = 'agent' | 'fixed'
export type Kind = 'persistent' | 'task' | 'system'
export type Ttl = 'persistent' | 'untilDismissed' | 'untilTaskEnd' | number

const WIDTH: Record<Size, number> = { '1/6': 1, '1/3': 2, '1/2': 3, full: 3 }
const LADDER: Size[] = ['1/6', '1/3', '1/2']
const COLS = 3
const PRIORITY: Record<Kind, number> = { persistent: 1, task: 2, system: 4 }

export interface Card {
  id: string
  key?: string
  template: string
  size: Size
  zone: Zone
  kind: Kind
  data: any
  ttl: Ttl
  preemptable: boolean
  createdAt: number
  touchedAt: number
}

export interface ShowInput {
  id?: string
  key?: string
  template: string
  size?: Size
  zone?: Zone
  kind?: Kind
  data?: any
  ttl?: Ttl
  preemptable?: boolean
}

export interface DeskResult {
  status: 'ok' | 'rejected'
  cardId?: string
  code?: string
  message?: string
  /** 被降尺寸的卡 */
  shrunk?: string[]
  /** 被挤出的卡 —— 必须告知用户，静默消失不可接受 */
  evicted?: string[]
  /** 人话，供 Agent 播报 */
  note?: string
  level?: 'L1' | 'L2' | 'L3'
}

const titleOf = (c: Card) => c.data?.title ?? c.template

export function createDesk(clock: () => number = Date.now) {
  const cards = new Map<string, Card>()
  let agent: string[] = []          // 上行，按插入顺序
  let fixed: string[] = []          // 下行
  let overlay: string | undefined   // full 尺寸临时征用
  let saved: { agent: string[]; fixed: string[] } | undefined
  let seq = 0
  const listeners: Array<() => void> = []
  const emit = () => listeners.forEach(l => l())

  const used = (row: string[]) =>
    row.reduce((n, id) => n + WIDTH[cards.get(id)!.size], 0)
  const free = (row: string[]) => COLS - used(row)

  /** 腾位：降尺寸优先 → 降无可降再按 LRU 挤出 */
  function makeRoom(need: number, incomingKind: Kind): DeskResult | { shrunk: string[]; evicted: string[]; titles: string[] } {
    const shrunk: string[] = []
    const evicted: string[] = []
    const titles: string[] = []

    const oldestFirst = () =>
      agent.map(id => cards.get(id)!).sort((a, b) => a.touchedAt - b.touchedAt)

    // 1) 降尺寸
    while (free(agent) < need) {
      const target = oldestFirst().find(c => LADDER.indexOf(c.size) > 0)
      if (!target) break
      target.size = LADDER[LADDER.indexOf(target.size) - 1]
      shrunk.push(target.id)
    }

    // 2) 挤出：只能挤优先级不高于来者、且允许被挤的卡
    while (free(agent) < need) {
      const victim = oldestFirst().find(
        c => c.preemptable && PRIORITY[c.kind] <= PRIORITY[incomingKind])
      if (!victim) return { status: 'rejected', code: 'DESKTOP_FULL', message: '桌面已满，且没有可以让位的卡片' }
      agent = agent.filter(x => x !== victim.id)
      evicted.push(victim.id)
      titles.push(titleOf(victim))   // 标题必须在删除前抓取，否则无法告知用户
      cards.delete(victim.id)
    }
    return { shrunk, evicted, titles }
  }

  function show(input: ShowInput): DeskResult {
    if (input.ttl === undefined || input.ttl === null)
      return { status: 'rejected', code: 'TTL_REQUIRED', message: '卡片必须声明 ttl，否则会在桌面堆积' }
    if (input.zone === 'fixed')
      return { status: 'rejected', code: 'FIXED_ZONE_READONLY', message: '固定区归用户所有，需要用户确认后才能入驻' }

    const size = input.size ?? '1/6'
    const kind = input.kind ?? 'task'
    const id = input.id ?? `card_${++seq}`

    // full：临时征用整屏，退出自动还原
    if (size === 'full') {
      if (!saved) saved = { agent: [...agent], fixed: [...fixed] }
      overlay = id
      cards.set(id, mkCard(id, input, size, kind))
      emit()
      return { status: 'ok', cardId: id }
    }

    const need = WIDTH[size]
    let shrunk: string[] = [], evicted: string[] = [], titles: string[] = [], note: string | undefined

    if (free(agent) < need) {
      const room = makeRoom(need, kind)
      if ('status' in room) return room
      shrunk = room.shrunk; evicted = room.evicted; titles = room.titles
    }

    // 静默消失不可接受 —— 挤掉了什么必须能被 Agent 说出来
    if (titles.length) note = `我把${titles.map(t => `「${t}」`).join('、')}收起来了`

    cards.set(id, mkCard(id, input, size, kind))
    agent.push(id)
    emit()

    // note 里换成可读标题（此时被挤的卡已删，标题在挤出前抓取）
    return {
      status: 'ok', cardId: id,
      ...(shrunk.length && { shrunk }),
      ...(evicted.length && { evicted, note }),
    }
  }

  const mkCard = (id: string, i: ShowInput, size: Size, kind: Kind): Card => ({
    id, key: i.key, template: i.template, size, kind,
    zone: 'agent', data: i.data ?? {}, ttl: i.ttl!,
    preemptable: i.preemptable ?? true,
    createdAt: clock(), touchedAt: clock(),
  })

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
    if (c.zone === 'agent') {
      const delta = WIDTH[size] - WIDTH[c.size]
      if (delta > 0 && free(agent) < delta) {
        const others = agent.filter(x => x !== id)
        const backup = agent
        agent = others
        const room = makeRoom(WIDTH[size], c.kind)
        if ('status' in room) { agent = backup; return room }
        agent = [...agent, id]
      }
    }
    c.size = size
    c.touchedAt = clock()
    emit()
    return { status: 'ok', cardId: id }
  }

  const enlarge = (id: string): DeskResult => {
    const c = cards.get(id)
    if (!c) return { status: 'rejected', code: 'NO_SUCH_CARD', message: `找不到卡片 ${id}` }
    const i = LADDER.indexOf(c.size)
    if (i < 0 || i === LADDER.length - 1) return { status: 'ok', cardId: id }
    return resize(id, LADDER[i + 1])
  }

  function dismiss(id: string): DeskResult {
    if (overlay === id) {
      overlay = undefined
      cards.delete(id)
      if (saved) { agent = saved.agent; fixed = saved.fixed; saved = undefined }
      emit()
      return { status: 'ok', cardId: id }
    }
    if (!cards.has(id)) return { status: 'rejected', code: 'NO_SUCH_CARD', message: `找不到卡片 ${id}` }
    agent = agent.filter(x => x !== id)
    fixed = fixed.filter(x => x !== id)
    cards.delete(id)
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

  /** 入驻固定区 —— 灰级，需用户确认（由 Tool 层拦截） */
  function pin(id: string, ): DeskResult {
    const c = cards.get(id)
    if (!c) return { status: 'rejected', code: 'NO_SUCH_CARD', message: `找不到卡片 ${id}` }
    if (fixed.includes(id)) return { status: 'ok', cardId: id }
    if (free(fixed) < WIDTH[c.size])
      return { status: 'rejected', code: 'FIXED_ZONE_FULL', message: '固定区已经满了，先移走一张再固定' }
    agent = agent.filter(x => x !== id)
    fixed.push(id)
    c.zone = 'fixed'
    c.ttl = 'persistent'
    emit()
    return { status: 'ok', cardId: id }
  }

  function unpin(id: string): DeskResult {
    const c = cards.get(id)
    if (!c || !fixed.includes(id))
      return { status: 'rejected', code: 'NO_SUCH_CARD', message: `${id} 不在固定区` }
    fixed = fixed.filter(x => x !== id)
    c.zone = 'agent'
    c.ttl = 'untilDismissed'
    if (free(agent) < WIDTH[c.size]) {
      const room = makeRoom(WIDTH[c.size], c.kind)
      if ('status' in room) return room
    }
    agent.push(id)
    emit()
    return { status: 'ok', cardId: id }
  }

  /**
   * 反馈四级的核心：**优先复用桌面上已有的卡 → 其次放大 → 最后才新建**
   * 这既是防卡片爆炸的工程规则，也是 Agent 编排能力的直接体现。
   */
  function render(i: ShowInput & { key: string }): DeskResult {
    const exist = [...cards.values()].find(c => c.key === i.key)
    const want = i.size ?? '1/6'
    if (exist) {
      if (WIDTH[exist.size] >= WIDTH[want]) {
        const r = update(exist.id, i.data ?? {})
        return { ...r, level: 'L1' }
      }
      const r = resize(exist.id, want)
      if (r.status !== 'ok') return r
      update(exist.id, i.data ?? {})
      return { ...r, level: 'L2' }
    }
    const r = show(i)
    return r.status === 'ok' ? { ...r, level: 'L3' } : r
  }

  /** ttl 到期清理 */
  function tick() {
    const t = clock()
    let changed = false
    for (const c of [...cards.values()]) {
      if (typeof c.ttl === 'number' && t - c.createdAt >= c.ttl * 1000) {
        dismiss(c.id); changed = true
      }
    }
    if (changed) emit()
  }

  /** 一轮任务结束：清掉 untilTaskEnd 的卡 */
  function endTask() {
    for (const c of [...cards.values()]) if (c.ttl === 'untilTaskEnd') dismiss(c.id)
  }

  const layout = () => ({
    agent: agent.map(id => cards.get(id)!),
    fixed: fixed.map(id => cards.get(id)!),
    overlay: overlay ? cards.get(overlay) : undefined,
    agentFree: free(agent),
    fixedFree: free(fixed),
  })

  /** 注入 system prompt 的紧凑描述 */
  function summary(): string {
    const l = layout()
    const fmt = (c: Card) => `${titleOf(c)}(${c.size})`
    const lines: string[] = []
    if (l.overlay) lines.push(`全屏卡：${fmt(l.overlay)}（占据整屏，关闭后自动还原）`)
    lines.push(`固定区（用户所有，你不能改）：${l.fixed.length ? l.fixed.map(fmt).join('、') : '空'}`)
    lines.push(`Agent 区（你可自由编排）：${l.agent.length ? l.agent.map(fmt).join('、') : '空'}，剩余 ${l.agentFree} 格`)
    return lines.join('\n')
  }

  return {
    show, update, resize, enlarge, dismiss, focus, pin, unpin, render,
    tick, endTask, layout, summary,
    get: (id: string) => cards.get(id),
    findByKey: (key: string) => [...cards.values()].find(c => c.key === key),
    widthOf: (s: Size) => WIDTH[s],
    subscribe: (cb: () => void) => { listeners.push(cb); return () => listeners.splice(listeners.indexOf(cb), 1) },
  }
}

export type Desk = ReturnType<typeof createDesk>
