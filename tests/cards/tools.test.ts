import { describe, it, expect, beforeEach } from 'vitest'
import { createStore } from '../../src/core/store'
import { createRegistry } from '../../src/tools/registry'
import { createDesk } from '../../src/cards/desk'
import { SIGNALS } from '../../src/config/signals'
import { CONSTRAINTS } from '../../src/config/constraints'
import { TOOLS } from '../../src/config/tools'

let now = 1000
let store: ReturnType<typeof createStore>
let desk: ReturnType<typeof createDesk>
let reg: ReturnType<typeof createRegistry>

beforeEach(() => {
  now = 1000
  store = createStore(SIGNALS, CONSTRAINTS)
  desk = createDesk(() => now)
  reg = createRegistry(store, TOOLS, () => now, { desk })
})

const show = (o: any = {}) =>
  reg.invoke('card.show', { template: 'feedback', size: '1/6', ttl: 'untilDismissed', ...o })

describe('卡片调度 Tool', () => {
  it('card.show 创建卡片并返回 cardId', () => {
    const r = show({ data: { title: '车窗' } })
    expect(r.status).toBe('ok')
    expect((r.data as any).cardId).toBeTruthy()
    expect(desk.layout().agent).toHaveLength(1)
  })

  it('card.show 缺 ttl 被拒 —— 防卡片堆积', () => {
    const r = reg.invoke('card.show', { template: 'feedback', size: '1/6' })
    expect(r.status).toBe('rejected')
    expect(r.code).toBe('INVALID_PARAMS')
  })

  it('card.show 模板必须在白名单内', () => {
    expect(show({ template: 'whatever' }).code).toBe('INVALID_PARAMS')
  })

  it('挤出时把 note 透传给 Agent，让它能告诉用户', () => {
    show({ data: { title: '搜索结果' } }); now += 10
    show(); now += 10; show(); now += 10
    const r = show()
    expect(r.status).toBe('ok')
    expect(r.message).toContain('搜索结果')
  })

  // 注意：Tool 层不给 Agent「这张卡不许被挤掉」的开关 —— 那是 desktop.pin（灰级、需用户确认）的职责。
  // 能否让位由卡片 kind 的优先级决定，避免 Agent 把自己的卡全部标成不可挤。
  it('桌面满且无可让位时返回 rejected + 可读原因', () => {
    for (let i = 0; i < 3; i++) { show({ kind: 'system' }); now += 10 }
    const r = show({ kind: 'task' })
    expect(r.status).toBe('rejected')
    expect(r.code).toBe('DESKTOP_FULL')
    expect(r.message).toBeTruthy()
  })

  it('card.update / card.resize / card.focus / card.dismiss', () => {
    const id = (show().data as any).cardId
    expect(reg.invoke('card.update', { cardId: id, data: { title: '新标题' } }).status).toBe('ok')
    expect(desk.get(id)!.data.title).toBe('新标题')
    expect(reg.invoke('card.resize', { cardId: id, size: '1/3' }).status).toBe('ok')
    expect(desk.get(id)!.size).toBe('1/3')
    expect(reg.invoke('card.focus', { cardId: id }).status).toBe('ok')
    expect(reg.invoke('card.dismiss', { cardId: id }).status).toBe('ok')
    expect(desk.layout().agent).toHaveLength(0)
  })

  it('操作不存在的卡片返回可读错误，不抛异常', () => {
    expect(reg.invoke('card.dismiss', { cardId: 'nope' }).code).toBe('NO_SUCH_CARD')
  })
})

describe('desktop.getLayout —— Agent 必须能读桌面才能编排', () => {
  it('返回各区卡片与剩余容量', () => {
    show({ data: { title: 'A' }, size: '1/3' })
    const r = reg.invoke('desktop.getLayout', {})
    expect(r.status).toBe('ok')
    const d = r.data as any
    expect(d.agent[0].title).toBe('A')
    expect(d.agent[0].size).toBe('1/3')
    expect(d.agentFree).toBe(1)
    expect(d.fixed).toEqual([])
  })

  it('空桌面也返回结构完整的结果', () => {
    const d = reg.invoke('desktop.getLayout', {}).data as any
    expect(d.agentFree).toBe(3)
    expect(d.fixedFree).toBe(3)
  })
})

describe('desktop.pin 是灰级 —— 固定区归用户，入驻需确认', () => {
  it('首次调用返回 CONFIRM_REQUIRED，且未入驻', () => {
    const id = (show().data as any).cardId
    const r = reg.invoke('desktop.pin', { cardId: id })
    expect(r.status).toBe('inputRequired')
    expect(desk.layout().fixed).toHaveLength(0)
  })

  it('带 token 重调后入驻固定区', () => {
    const id = (show().data as any).cardId
    const first = reg.invoke('desktop.pin', { cardId: id })
    const r = reg.invoke('desktop.pin', { cardId: id, confirmToken: first.token })
    expect(r.status).toBe('ok')
    expect(desk.layout().fixed.map(c => c.id)).toContain(id)
  })

  it('desktop.unpin 同样是灰级', () => {
    expect(reg.permissionOf('desktop.unpin')).toBe('灰')
  })
})

describe('已作废的 App 类 Tool 不应存在', () => {
  it('无APP化后 app.launch / app.close / screen.setLayout 全部移除', () => {
    const names = reg.list().map(t => t.name)
    expect(names).not.toContain('app.launch')
    expect(names).not.toContain('app.close')
    expect(names).not.toContain('screen.setLayout')
    expect(names).not.toContain('screen.showCard')
  })
})
