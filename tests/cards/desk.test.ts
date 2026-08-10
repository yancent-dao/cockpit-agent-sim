import { describe, it, expect, beforeEach } from 'vitest'
import { createDesk } from '../../src/cards/desk'

let now = 1000
let desk: ReturnType<typeof createDesk>
const mk = (o: any = {}) => desk.show({ template: 'control', size: '1/6', ttl: 'untilDismissed', ...o })

beforeEach(() => { now = 1000; desk = createDesk(() => now) })

/* ══════════════ 栅格与尺寸 ══════════════ */
describe('栅格：3 列 × 2 行，每个尺寸只允许一种形状', () => {
  it('1/6 占 1 格，1/3 占 2 格，1/2 占整行 3 格', () => {
    expect(desk.widthOf('1/6')).toBe(1)
    expect(desk.widthOf('1/3')).toBe(2)
    expect(desk.widthOf('1/2')).toBe(3)
  })

  it('Agent 区容量为 3 格：可放 3 张 1/6', () => {
    mk(); mk(); mk()
    expect(desk.layout().agent).toHaveLength(3)
    expect(desk.layout().agentFree).toBe(0)
  })

  it('一张 1/3 + 一张 1/6 正好占满 Agent 区', () => {
    mk({ size: '1/3' }); mk({ size: '1/6' })
    expect(desk.layout().agentFree).toBe(0)
  })

  it('卡片按插入顺序左对齐排布，不产生碎片（可预测优先于最优）', () => {
    const a = mk({ size: '1/6' }), b = mk({ size: '1/6' })
    desk.dismiss(a.cardId!)
    const c = mk({ size: '1/3' })
    expect(c.status).toBe('ok')
    expect(desk.layout().agent.map(x => x.id)).toEqual([b.cardId, c.cardId])
  })
})

/* ══════════════ 分区 ══════════════ */
describe('分区：上行 Agent 区，下行固定区', () => {
  it('Agent 卡默认进 Agent 区', () => {
    const r = mk()
    expect(desk.layout().agent.map(x => x.id)).toContain(r.cardId)
  })

  it('Agent 不能直接往固定区放卡 —— 固定区归用户', () => {
    const r = desk.show({ template: 'control', size: '1/6', ttl: 'persistent', zone: 'fixed' })
    expect(r.status).toBe('rejected')
    expect(r.code).toBe('FIXED_ZONE_READONLY')
  })

  it('固定区通过 pin 入驻，且不受 Agent 区满载影响', () => {
    const r = mk()
    expect(desk.pin(r.cardId!).status).toBe('ok')
    mk(); mk(); mk()   // Agent 区塞满
    expect(desk.layout().fixed.map(x => x.id)).toContain(r.cardId)
  })

  it('固定区满（3 格）时 pin 失败', () => {
    for (let i = 0; i < 3; i++) desk.pin(mk().cardId!)
    const r = desk.pin(mk().cardId!)
    expect(r.status).toBe('rejected')
    expect(r.code).toBe('FIXED_ZONE_FULL')
  })

  it('unpin 把卡移回 Agent 区', () => {
    const r = mk(); desk.pin(r.cardId!)
    desk.unpin(r.cardId!)
    expect(desk.layout().agent.map(x => x.id)).toContain(r.cardId)
  })
})

/* ══════════════ Agent 区满载策略 ══════════════ */
describe('满载：降尺寸优先 → 降无可降再挤出 → 必须告知', () => {
  it('一张 1/2 占满整行时，新卡先把它降到 1/3 腾位', () => {
    const big = mk({ size: '1/2' })
    now += 10
    const r = mk({ size: '1/6' })
    expect(r.status).toBe('ok')
    expect(r.shrunk).toContain(big.cardId)
    expect(desk.layout().agent.find(c => c.id === big.cardId)!.size).toBe('1/3')
  })

  it('降尺寸能腾出空间时不挤卡', () => {
    const big = mk({ size: '1/2' })
    now += 10
    const r = mk({ size: '1/6' })
    expect(r.evicted).toBeUndefined()
    expect(desk.layout().agent).toHaveLength(2)
  })

  it('三张 1/6 已无可降 → 挤出最久未交互的，并返回 evicted', () => {
    const a = mk(); now += 10; mk(); now += 10; mk(); now += 10
    const r = mk()
    expect(r.status).toBe('ok')
    expect(r.evicted).toEqual([a.cardId])
    expect(desk.layout().agent.map(x => x.id)).not.toContain(a.cardId)
  })

  it('挤出必须可被告知用户 —— 结果带人话 note', () => {
    mk({ data: { title: '搜索结果' } }); now += 10; mk(); now += 10; mk(); now += 10
    const r = mk()
    expect(r.note).toBeTruthy()
    expect(r.note).toContain('搜索结果')
  })

  it('update / focus 会刷新 LRU，避免刚用过的卡被挤掉', () => {
    const a = mk(); now += 10; const b = mk(); now += 10; mk(); now += 10
    desk.focus(a.cardId!)          // a 变成最近交互
    now += 10
    const r = mk()
    expect(r.evicted).toEqual([b.cardId])   // 挤掉的是 b 而不是 a
  })

  it('preemptable:false 的卡不会被挤出', () => {
    const keep = mk({ preemptable: false }); now += 10
    mk(); now += 10; mk(); now += 10
    const r = mk()
    expect(r.evicted).not.toContain(keep.cardId)
  })

  it('全部不可挤且无可降时，明确拒绝而不是静默丢弃', () => {
    for (let i = 0; i < 3; i++) { mk({ preemptable: false }); now += 10 }
    const r = mk()
    expect(r.status).toBe('rejected')
    expect(r.code).toBe('DESKTOP_FULL')
  })
})

/* ══════════════ 生命周期 ══════════════ */
describe('生命周期：ttl 为必填', () => {
  it('缺少 ttl 直接拒绝 —— 防止卡片堆积', () => {
    const r = desk.show({ template: 'control', size: '1/6' } as any)
    expect(r.status).toBe('rejected')
    expect(r.code).toBe('TTL_REQUIRED')
  })

  it('秒数型 ttl 到期后自动移除', () => {
    const r = desk.show({ template: 'feedback', size: '1/6', ttl: 8 })
    now += 7000; desk.tick()
    expect(desk.layout().agent).toHaveLength(1)
    now += 2000; desk.tick()
    expect(desk.layout().agent).toHaveLength(0)
  })

  it('persistent 与 untilDismissed 不会过期', () => {
    desk.show({ template: 'control', size: '1/6', ttl: 'persistent' })
    desk.show({ template: 'control', size: '1/6', ttl: 'untilDismissed' })
    now += 3_600_000; desk.tick()
    expect(desk.layout().agent).toHaveLength(2)
  })

  it('untilTaskEnd 在任务结束时统一清理', () => {
    desk.show({ template: 'list', size: '1/3', ttl: 'untilTaskEnd' })
    desk.show({ template: 'control', size: '1/6', ttl: 'persistent' })
    desk.endTask()
    expect(desk.layout().agent).toHaveLength(1)
  })
})

/* ══════════════ 优先级与抢占 ══════════════ */
describe('优先级与抢占', () => {
  it('系统卡（来电/告警）可以抢占任务卡', () => {
    const t = mk({ kind: 'task' }); now += 10
    mk({ kind: 'task' }); now += 10; mk({ kind: 'task' }); now += 10
    const sys = desk.show({ template: 'notice', size: '1/6', ttl: 20, kind: 'system' })
    expect(sys.status).toBe('ok')
    expect(sys.evicted).toEqual([t.cardId])
  })

  it('任务卡不能抢占系统卡', () => {
    for (let i = 0; i < 3; i++) { desk.show({ template: 'notice', size: '1/6', ttl: 20, kind: 'system' }); now += 10 }
    const r = mk({ kind: 'task' })
    expect(r.status).toBe('rejected')
  })

  it('full 尺寸临时征用整屏，dismiss 后固定区自动还原', () => {
    const pinned = mk(); desk.pin(pinned.cardId!)
    const a = mk()
    const full = desk.show({ template: 'capability', size: 'full', ttl: 'untilDismissed' })
    expect(desk.layout().overlay?.id).toBe(full.cardId)
    desk.dismiss(full.cardId!)
    expect(desk.layout().overlay).toBeUndefined()
    expect(desk.layout().fixed.map(x => x.id)).toContain(pinned.cardId)
    expect(desk.layout().agent.map(x => x.id)).toContain(a.cardId)
  })
})

/* ══════════════ 反馈四级：复用 → 放大 → 新建 ══════════════ */
describe('render()：优先复用已有卡 → 其次放大 → 最后新建', () => {
  it('桌面已有对应卡且尺寸够 → L1 卡内更新，不新建', () => {
    const first = desk.render({ key: 'windows', template: 'control', size: '1/6', ttl: 'persistent', data: { v: 1 } })
    expect(first.level).toBe('L3')
    const again = desk.render({ key: 'windows', template: 'control', size: '1/6', ttl: 'persistent', data: { v: 2 } })
    expect(again.level).toBe('L1')
    expect(again.cardId).toBe(first.cardId)
    expect(desk.layout().agent).toHaveLength(1)
    expect(desk.get(first.cardId!)!.data.v).toBe(2)
  })

  it('已有卡但尺寸不足 → L2 放大一级，仍不新建', () => {
    const first = desk.render({ key: 'nav', template: 'nav', size: '1/6', ttl: 'persistent' })
    const bigger = desk.render({ key: 'nav', template: 'nav', size: '1/3', ttl: 'persistent' })
    expect(bigger.level).toBe('L2')
    expect(bigger.cardId).toBe(first.cardId)
    expect(desk.get(first.cardId!)!.size).toBe('1/3')
  })

  it('桌面无对应卡 → L3 新建', () => {
    expect(desk.render({ key: 'media', template: 'media', size: '1/6', ttl: 30 }).level).toBe('L3')
  })

  it('固定区里的卡也算"已在桌面"，同样走 L1 而不是新建', () => {
    const c = desk.render({ key: 'windows', template: 'control', size: '1/6', ttl: 'persistent' })
    desk.pin(c.cardId!)
    const again = desk.render({ key: 'windows', template: 'control', size: '1/6', ttl: 'persistent', data: { v: 9 } })
    expect(again.level).toBe('L1')
    expect(desk.layout().agent).toHaveLength(0)
    expect(desk.get(c.cardId!)!.data.v).toBe(9)
  })
})

/* ══════════════ 交互 ══════════════ */
describe('交互：点击逐级放大', () => {
  it('1/6 → 1/3 → 1/2，到顶不再放大', () => {
    const c = mk()
    desk.enlarge(c.cardId!); expect(desk.get(c.cardId!)!.size).toBe('1/3')
    desk.enlarge(c.cardId!); expect(desk.get(c.cardId!)!.size).toBe('1/2')
    desk.enlarge(c.cardId!); expect(desk.get(c.cardId!)!.size).toBe('1/2')
  })

  it('放大导致空间不足时会自动腾位', () => {
    const a = mk(); now += 10; const b = mk(); now += 10
    const r = desk.enlarge(b.cardId!)
    expect(desk.get(b.cardId!)!.size).toBe('1/3')
    expect(r.status).toBe('ok')
    expect(desk.layout().agentFree).toBe(0)
    expect(a.cardId).toBeTruthy()
  })
})

/* ══════════════ 上下文注入 ══════════════ */
describe('桌面摘要（注入 system prompt）', () => {
  it('列出当前卡片、尺寸、区域与剩余容量', () => {
    const c = desk.render({ key: 'windows', template: 'control', size: '1/6', ttl: 'persistent', data: { title: '车窗' } })
    desk.pin(c.cardId!)
    desk.render({ key: 'nav', template: 'nav', size: '1/3', ttl: 30, data: { title: '导航' } })
    const s = desk.summary()
    expect(s).toContain('车窗')
    expect(s).toContain('固定区')
    expect(s).toContain('Agent 区')
    expect(s).toContain('1/3')
    expect(s).toMatch(/剩余\s*1\s*格/)
  })

  it('摘要保持紧凑，不超过 8 行', () => {
    mk(); mk(); mk()
    expect(desk.summary().split('\n').length).toBeLessThanOrEqual(8)
  })

  it('空桌面也给出明确描述', () => {
    expect(desk.summary()).toContain('剩余 3 格')
  })
})
