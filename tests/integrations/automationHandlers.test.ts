import { describe, it, expect, beforeEach } from 'vitest'
import { createStore } from '../../src/core/store'
import { createRegistry } from '../../src/tools/registry'
import { createDesk } from '../../src/cards/desk'
import { createAutomationStore } from '../../src/state/automation'
import { SIGNALS } from '../../src/config/signals'
import { CONSTRAINTS } from '../../src/config/constraints'
import { TOOLS } from '../../src/config/tools'

/**
 * 自动化五工具（create/list/toggle/delete/run）。
 * handler 只做机制：校验→写仓→上卡→人话回执。执行动作在装配层
 * （run 经注入的 execute 回调），handler 不碰 pipeline。
 */

const mem = () => { const m = new Map<string, string>(); return { get: (k: string) => m.get(k) ?? null, set: (k: string, v: string) => m.set(k, v) } }

let store: ReturnType<typeof createStore>
let desk: ReturnType<typeof createDesk>
let auto: ReturnType<typeof createAutomationStore>
let executed: string[]

beforeEach(() => {
  store = createStore(SIGNALS, CONSTRAINTS)
  desk = createDesk()
  auto = createAutomationStore(mem())
  executed = []
})

const mk = () => createRegistry(store, TOOLS, Date.now, {
  desk, automation: { store: auto, execute: async (r: any) => { executed.push(r.name); return '干完了' } },
} as any)

describe('automation.create', () => {
  it('建一条定时规则：进仓、上卡、回执说人话', async () => {
    const r = await mk().invoke('automation.create', {
      name: '四点开空调',
      when: [{ kind: 'time', at: '16:00' }],
      do: [{ tool: 'climate.set', args: { power: true } }],
    })
    expect(r.status).toBe('ok')
    expect(r.message).toContain('四点开空调')
    expect(auto.list()).toHaveLength(1)
    expect(auto.list()[0].when).toEqual([['time', '16:00']])
    const card = desk.layout().cards.find(c => c.template === 'automation')
    expect(card, '自动任务卡该上屏').toBeTruthy()
    expect(card!.data.items[0].label).toContain('四点开空调')
  })

  it('信号条件走三元组；工具名不存在的动作拒绝', async () => {
    const ok = await mk().invoke('automation.create', {
      name: '开车报股票',
      when: [{ kind: 'signal', path: 'vehicle.gear', op: '==', value: 'd' }],
      do: [{ prompt: '推荐当天值得关注的股票' }],
    })
    expect(ok.status).toBe('ok')
    const bad = await mk().invoke('automation.create', {
      name: 'x', when: [], do: [{ tool: 'ghost.tool', args: {} }],
    })
    expect(bad.status).toBe('rejected')
    expect(bad.message).toContain('ghost.tool')
  })

  it('条件里的信号路径必须真实存在', async () => {
    const bad = await mk().invoke('automation.create', {
      name: 'x', when: [{ kind: 'signal', path: 'ghost.path', op: '==', value: 1 }], do: [{ prompt: 'y' }],
    })
    expect(bad.status).toBe('rejected')
    expect(bad.message).toContain('ghost.path')
  })
})

describe('list / toggle / delete / run', () => {
  const seed = async (reg: ReturnType<typeof mk>) => {
    await reg.invoke('automation.create', { name: '雨天模式',
      when: [{ kind: 'signal', path: 'env.weather', op: '==', value: 'rain' }],
      do: [{ tool: 'wiper.set', args: { mode: 'slow' } }] })
    await reg.invoke('automation.create', { name: '手动晨报', when: [], do: [{ prompt: '来段晨报' }] })
  }

  it('list：数据就是任务码（可导出 JSON）', async () => {
    const reg = mk(); await seed(reg)
    const r = await reg.invoke('automation.list', {})
    expect(r.status).toBe('ok')
    expect((r.data as any).rules).toHaveLength(2)
    expect(r.message).toContain('2')
  })

  it('toggle 不带 on 就翻转（点卡片那条路）', async () => {
    const reg = mk(); await seed(reg)
    const id = auto.list()[0].id
    await reg.invoke('automation.toggle', { id })
    expect(auto.list()[0].enabled).toBe(false)
    await reg.invoke('automation.toggle', { id })
    expect(auto.list()[0].enabled).toBe(true)
  })

  it('run：手动任务经装配层 execute 执行', async () => {
    const reg = mk(); await seed(reg)
    const r = await reg.invoke('automation.run', { name: '手动晨报' })
    expect(r.status).toBe('ok')
    expect(executed).toEqual(['手动晨报'])
  })

  it('delete 收尾，卡片跟着刷新', async () => {
    const reg = mk(); await seed(reg)
    const id = auto.list()[0].id
    await reg.invoke('automation.delete', { id })
    expect(auto.list()).toHaveLength(1)
    const card = desk.layout().cards.find(c => c.template === 'automation')
    expect(card!.data.items).toHaveLength(1)
  })
})

/**
 * ══════════ 实拍三修（2026-08-19 日志）══════════
 */
describe('实拍修复', () => {
  it('{item:单对象} 的数组退化也要收——第三次撞见这个形状了', async () => {
    const r = await mk().invoke('automation.create', {
      name: '下午三点开空调',
      when: { item: { kind: 'time', at: '15:00' } },
      do: { item: { tool: 'climate.set', args: { power: true } } },
    })
    expect(r.status, '单对象包 item 应被展平成单元素数组').toBe('ok')
    expect(auto.list()[0].when).toEqual([['time', '15:00']])
  })

  it('动作参数在 create 时干验证——三点才发现参数错是定时哑弹', async () => {
    const r = await mk().invoke('automation.create', {
      name: 'x', when: [{ kind: 'time', at: '15:00' }],
      do: [{ tool: 'climate.set', args: { on: 'true' } }],   // climate.set 没有 on 这个参数形态
    })
    expect(r.status).toBe('rejected')
    expect(r.message).toContain('climate.set')
  })
})
