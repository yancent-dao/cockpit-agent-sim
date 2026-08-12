import { describe, it, expect, beforeEach } from 'vitest'
import { createStore } from '../../src/core/store'
import { createRegistry } from '../../src/tools/registry'
import { createDesk } from '../../src/cards/desk'
import { CARD_TEMPLATES } from '../../src/config/cards'
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

const show = async (o: any = {}) =>
  await reg.invoke('card.show', { template: 'feedback', size: '1/6', ttl: 'untilDismissed', ...o })

describe('卡片调度 Tool', () => {
  it('card.show 创建卡片并返回 cardId', async () => {
    const r = await show({ data: { title: '临时提醒', text: 'x' } })
    expect(r.status).toBe('ok')
    expect((r.data as any).cardId).toBeTruthy()
    expect(desk.layout().cards).toHaveLength(1)
  })

  it('card.show 缺 ttl 被拒 —— 防卡片堆积', async () => {
    const r = await reg.invoke('card.show', { template: 'feedback', size: '1/6' })
    expect(r.status).toBe('rejected')
    expect(r.code).toBe('INVALID_PARAMS')
  })

  it('card.show 模板必须在白名单内', async () => {
    expect((await show({ template: 'whatever' })).code).toBe('INVALID_PARAMS')
  })

  it('card.show 尺寸必须是该模板支持的形状之一', async () => {
    // 天气卡在通用池里，拿不到 2/3（那档是导航卡专属）
    const r = await show({ template: 'weather', size: '2/3', data: { now: { weather: '晴', temperature: 25 } } })
    expect(r.status).toBe('rejected')
    expect(r.code).toBe('SIZE_NOT_SUPPORTED')
  })

  // 导航卡由 orchestrator 按车辆状态驱动。Agent 手动建会出现两张、
  // 而且数据是它编的不是来自信号。以前是靠"尺寸枚举里没有 2/3"这个副作用
  // 拦住的，现在尺寸放开了，得有显式机制
  it('Agent 手动建不了导航卡，任何尺寸都不行', async () => {
    for (const size of ['1/6', '1/3', '1/2', '2/3']) {
      const r = await show({ template: 'nav', size, data: { destination: 'x' } })
      expect(r.status, `nav ${size}`).toBe('rejected')
      expect(r.code).toBe('SYSTEM_TEMPLATE')
      expect(r.message).toBeTruthy()
    }
  })

  it('data 缺少模板必填字段时拒绝，不是静默渲染空白', async () => {
    const r = await show({ template: 'capability', size: 'full', data: {} })
    expect(r.status).toBe('rejected')
    expect(r.code).toBe('DATA_SHAPE_MISMATCH')
    expect(r.message).toContain('items')
  })

  it('天气卡缺 now 字段时拒绝', async () => {
    const r = await show({ template: 'weather', size: '1/3', data: { forecast: [] } })
    expect(r.status).toBe('rejected')
    expect(r.code).toBe('DATA_SHAPE_MISMATCH')
  })

  it('天气卡字段齐全时正常创建', async () => {
    const r = await show({ template: 'weather', size: '1/3', data: { now: { weather: '晴', temperature: 25 } } })
    expect(r.status).toBe('ok')
  })

  it('通用兜底卡不做形状校验——它本来就是给"没有合适模板"用的逃生舱', async () => {
    const r = await show({ template: 'generic', size: '1/6', data: { whatever: 123 } })
    expect(r.status).toBe('ok')
  })

  it('card.update 只校验实际传入字段的类型（局部更新语义）', async () => {
    const id = ((await show({ template: 'weather', size: '1/3', data: { now: { weather: '晴', temperature: 25 } } })).data as any).cardId
    const r = await reg.invoke('card.update', { cardId: id, data: { now: 'not-an-object' } })
    expect(r.status).toBe('rejected')
    expect(r.code).toBe('DATA_SHAPE_MISMATCH')
  })

  it('挤出时把 note 透传给 Agent，让它能告诉用户', async () => {
    await show({ data: { title: '搜索结果' } }); now += 10
    for (let i = 0; i < 5; i++) { await show(); now += 10 }
    const r = await show({ kind: 'system', data: { title: '来电' } })
    expect(r.status).toBe('ok')
    expect(r.message).toContain('搜索结果')
  })

  it('桌面满且无可让位时返回 rejected + 可读原因', async () => {
    for (let i = 0; i < 6; i++) { await show({ kind: 'system' }); now += 10 }
    const r = await show({ kind: 'task' })
    expect(r.status).toBe('rejected')
    expect(r.code).toBe('DESKTOP_FULL')
    expect(r.message).toBeTruthy()
  })

  it('card.update / card.resize / card.focus / card.dismiss', async () => {
    // 用车控卡：feedback 只声明了 1/6，resize 到 1/3 现在会被模板校验挡住
    const id = ((await show({ template: 'control', data: { items: [{ label: '温度', value: 24 }] } })).data as any).cardId
    expect((await reg.invoke('card.update', { cardId: id, data: { title: '新标题' } })).status).toBe('ok')
    expect(desk.get(id)!.data.title).toBe('新标题')
    expect((await reg.invoke('card.resize', { cardId: id, size: '1/3' })).status).toBe('ok')
    expect(desk.get(id)!.size).toBe('1/3')
    expect((await reg.invoke('card.focus', { cardId: id })).status).toBe('ok')
    expect((await reg.invoke('card.dismiss', { cardId: id })).status).toBe('ok')
    expect(desk.layout().cards).toHaveLength(0)
  })

  // resize 一样要认模板：反馈卡只有 1/6 是它的默认，但它在通用池里，
  // 真正拿不到的是 2/3 那种专属档
  it('card.resize 也认模板的可用档位', async () => {
    const id = ((await show({ template: 'weather', data: { now: { weather: '晴', temperature: 25 } } })).data as any).cardId
    expect((await reg.invoke('card.resize', { cardId: id, size: '1/2' })).status).toBe('ok')
    const r = await reg.invoke('card.resize', { cardId: id, size: '2/3' })
    expect(r.status).toBe('rejected')
    expect(r.code).toBe('SIZE_NOT_SUPPORTED')
  })

  it('card.resize 的参数枚举得含 2/3，否则连表达都表达不了', async () => {
    const size = TOOLS.find(t => t.name === 'card.resize')!.params!.size
    expect(size.values).toContain('2/3')
  })

  /* ── 尺寸池：不声明 sizes 的模板通吃 1/6 · 1/3 · 1/2 ── */
  it('通用池三档任何模板都能用——白名单越窄，桌面几何死角越多', async () => {
    for (const size of ['1/6', '1/3', '1/2']) {
      const r = await show({ template: 'weather', size,
        data: { now: { weather: '晴', temperature: 25 } } })
      expect(r.status, `weather 应该支持 ${size}`).toBe('ok')
    }
  })

  it('2/3 是稀缺档，只有导航卡能用——全桌面只有一个合法位置，两张必冲突', async () => {
    const r = await show({ template: 'weather', size: '2/3',
      data: { now: { weather: '晴', temperature: 25 } } })
    expect(r.status).toBe('rejected')
    expect(r.code).toBe('SIZE_NOT_SUPPORTED')
  })

  it('full 是覆盖层不是尺寸，别的卡拿不到——天气盖住导航是安全问题', async () => {
    const r = await show({ template: 'weather', size: 'full',
      data: { now: { weather: '晴', temperature: 25 } } })
    expect(r.status).toBe('rejected')
  })

  it('导航卡可以被调小到通用池的档位', async () => {
    const id = desk.show({ template: 'nav', size: '2/3', kind: 'rule',
      ttl: 'untilDismissed', data: { destination: '春熙路' } }).cardId!
    for (const size of ['1/2', '1/3', '2/3']) {
      const r = await reg.invoke('card.resize', { cardId: id, size })
      expect(r.status, `nav 应该支持 ${size}`).toBe('ok')
      expect(desk.get(id)!.size).toBe(size)
    }
  })

  it('每个模板都有 defaultSize', () => {
    for (const t of CARD_TEMPLATES) expect(t.defaultSize, t.id).toBeTruthy()
  })

  it('操作不存在的卡片返回可读错误，不抛异常', async () => {
    expect((await reg.invoke('card.dismiss', { cardId: 'nope' })).code).toBe('NO_SUCH_CARD')
  })
})

describe('desktop.getLayout —— Agent 必须能读桌面才能编排', () => {
  it('返回卡片列表与剩余格数（统一画布，无分区）', async () => {
    await show({ data: { title: 'A', items: [] }, size: '1/3', template: 'control' })
    const r = await reg.invoke('desktop.getLayout', {})
    expect(r.status).toBe('ok')
    const d = r.data as any
    expect(d.cards[0].title).toBe('A')
    expect(d.cards[0].size).toBe('1/3')
    expect(d.slots).toBe(4)   // (48-16)/8，还放得下四张小卡
  })

  it('空桌面也返回结构完整的结果', async () => {
    const d = (await reg.invoke('desktop.getLayout', {})).data as any
    expect(d.cards).toEqual([])
    expect(d.slots).toBe(6)
  })
})

describe('已作废的 Tool 不应存在', () => {
  it('无APP化后 app.* 移除；无常驻卡后 desktop.pin/unpin 移除', async () => {
    const names = reg.list().map(t => t.name)
    expect(names).not.toContain('app.launch')
    expect(names).not.toContain('screen.setLayout')
    expect(names).not.toContain('desktop.pin')
    expect(names).not.toContain('desktop.unpin')
  })
})
