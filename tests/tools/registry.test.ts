import { describe, it, expect, beforeEach } from 'vitest'
import { createStore } from '../../src/core/store'
import { createRegistry } from '../../src/tools/registry'
import { SIGNALS } from '../../src/config/signals'
import { CONSTRAINTS } from '../../src/config/constraints'
import { TOOLS } from '../../src/config/tools'

let store: ReturnType<typeof createStore>
let reg: ReturnType<typeof createRegistry>
let now = 1_000_000

beforeEach(() => {
  now = 1_000_000
  store = createStore(SIGNALS, CONSTRAINTS)
  reg = createRegistry(store, TOOLS, () => now)
})

/* ────────────────────────── 注册表与 Schema ────────────────────────── */
describe('注册表', () => {
  it('「黑」级 Tool 永不暴露给 Agent —— 永久禁区', () => {
    const names = reg.list().map(t => t.name)
    expect(names).not.toContain('brake.apply')
    expect(TOOLS.some(t => t.name === 'brake.apply')).toBe(true) // 配置里有，但不暴露
  })

  it('调用「黑」级 Tool 直接 unavailable / BLOCKED', () => {
    const r = reg.invoke('brake.apply', { force: 1 })
    expect(r.status).toBe('unavailable')
    expect(r.code).toBe('BLOCKED')
  })

  it('导出 OpenAI function calling 格式', () => {
    const s = reg.schemas('openai').find(x => x.function.name === 'window.set')!
    expect(s.type).toBe('function')
    expect(s.function.description).toBeTruthy()
    expect(s.function.parameters.type).toBe('object')
    expect(s.function.parameters.properties.position.type).toBe('number')
    expect(s.function.parameters.properties.window.enum).toContain('all')
    expect(s.function.parameters.required).toContain('window')
  })

  it('能力授权：白名单外的 Tool 不暴露且不可调用', () => {
    const names = reg.list(['window.*', 'vehicle.getState']).map(t => t.name)
    expect(names).toContain('window.set')
    expect(names).not.toContain('door.set')
    const r = reg.invoke('door.set', { door: 'driver', action: 'open' }, { allow: ['window.*'] })
    expect(r.status).toBe('unavailable')
    expect(r.code).toBe('NOT_AUTHORIZED')
  })

  it('未知 Tool 返回 unavailable / UNKNOWN_TOOL', () => {
    expect(reg.invoke('teleport.now', {}).code).toBe('UNKNOWN_TOOL')
  })
})

/* ────────────────────────── 零代码 handler ────────────────────────── */
describe('由 writes 声明自动生成的 handler', () => {
  it('彩级直接执行并写入 store', () => {
    const r = reg.invoke('window.set', { window: 'driver', position: 60 })
    expect(r.status).toBe('ok')
    expect(store.getTarget('cabin.window.driver.position')).toBe(60)
    expect(r.changed).toEqual(['cabin.window.driver.position'])
  })

  it('all 自动展开为四扇窗，一次调用四条 changed', () => {
    const r = reg.invoke('window.set', { window: 'all', position: 100 })
    expect(r.status).toBe('ok')
    expect(r.changed).toHaveLength(4)
    expect(store.getTarget('cabin.window.rearRight.position')).toBe(100)
  })

  it('参数缺失返回 rejected / INVALID_PARAMS', () => {
    expect(reg.invoke('window.set', { window: 'driver' }).code).toBe('INVALID_PARAMS')
  })

  it('参数越界返回 rejected / INVALID_PARAMS', () => {
    expect(reg.invoke('window.set', { window: 'driver', position: 300 }).code).toBe('INVALID_PARAMS')
    expect(reg.invoke('window.set', { window: 'roof', position: 10 }).code).toBe('INVALID_PARAMS')
  })
})

/* ────────────────────────── 约束透传 ────────────────────────── */
describe('约束结果透传到 ToolResult', () => {
  it('限位场景：ok + code + 人话 message（Golden Case 7）', () => {
    store.setDirect('vehicle.speed', 120)
    const r = reg.invoke('window.set', { window: 'driver', position: 100 }, { confirmToken: undefined, force: true })
    expect(r.status).toBe('ok')
    expect(r.code).toBe('SPEED_LIMITED')
    expect(r.message).toContain('120')
  })

  it('儿童锁场景：rejected + suggestion（Golden Case 8）', () => {
    store.set('cabin.childLock', true)
    const r = reg.invoke('window.set', { window: 'rearLeft', position: 100 })
    expect(r.status).toBe('rejected')
    expect(r.code).toBe('CHILD_LOCK_ON')
    expect(r.suggestion).toBeTruthy()
  })

  it('未选装：unavailable / NOT_EQUIPPED，绝不假装成功（Golden Case 9）', () => {
    const r = reg.invoke('sunroof.set', { position: 100 })
    expect(r.status).toBe('unavailable')
    expect(r.code).toBe('NOT_EQUIPPED')
  })

  it('批量展开中任一被拒 → 整体 rejected，不做部分写入', () => {
    store.set('cabin.childLock', true)
    const before = store.getTarget('cabin.window.driver.position')
    const r = reg.invoke('window.set', { window: 'all', position: 100 })
    expect(r.status).toBe('rejected')
    expect(store.getTarget('cabin.window.driver.position')).toBe(before)
  })
})

/* ────────────────────────── MRTR 二次确认（对齐 MCP 2026-07-28） ────────────────────────── */
describe('二次确认 · MCP MRTR inputRequired', () => {
  it('灰级 Tool 首次调用返回 inputRequired + token，且不执行', () => {
    const r = reg.invoke('door.set', { door: 'driver', action: 'open' })
    expect(r.status).toBe('inputRequired')
    expect(r.code).toBe('CONFIRM_REQUIRED')
    expect(r.token).toBeTruthy()
    expect(r.message).toBeTruthy()
    expect(store.getTarget('cabin.door.driver.isOpen')).toBe(false)
  })

  it('带正确 token 重调则真正执行', () => {
    const first = reg.invoke('door.set', { door: 'driver', action: 'open' })
    const r = reg.invoke('door.set', { door: 'driver', action: 'open' }, { confirmToken: first.token })
    expect(r.status).toBe('ok')
    expect(store.getTarget('cabin.door.driver.isOpen')).toBe(true)
  })

  it('token 一次性，第二次使用失效', () => {
    const first = reg.invoke('door.set', { door: 'driver', action: 'open' })
    reg.invoke('door.set', { door: 'driver', action: 'open' }, { confirmToken: first.token })
    const again = reg.invoke('door.set', { door: 'driver', action: 'close' }, { confirmToken: first.token })
    expect(again.status).toBe('inputRequired') // 需要重新确认
  })

  it('token 60s 后过期', () => {
    const first = reg.invoke('door.set', { door: 'driver', action: 'open' })
    now += 61_000
    const r = reg.invoke('door.set', { door: 'driver', action: 'open' }, { confirmToken: first.token })
    expect(r.status).toBe('inputRequired')
  })

  it('空字符串 token 视为未提供（gpt-5-nano 实测会主动传 confirmToken:""）', () => {
    const r = reg.invoke('door.set', { door: 'driver', action: 'open', confirmToken: '' })
    expect(r.status).toBe('inputRequired')
    expect(r.token).toBeTruthy()
    expect(store.getTarget('cabin.door.driver.isOpen')).toBe(false)
  })

  it('伪造 token 无效', () => {
    const r = reg.invoke('door.set', { door: 'driver', action: 'open' }, { confirmToken: 'ct_fake' })
    expect(r.status).toBe('inputRequired')
  })

  it('token 与 Tool 名绑定，不能跨 Tool 复用', () => {
    const first = reg.invoke('door.set', { door: 'driver', action: 'open' })
    const r = reg.invoke('window.set', { window: 'driver', position: 50 }, { confirmToken: first.token })
    expect(r.status).toBe('ok') // 彩级本就不需要 token，但不应因此消耗它
    const reuse = reg.invoke('door.set', { door: 'driver', action: 'open' }, { confirmToken: first.token })
    expect(reuse.status).toBe('ok')
  })
})

/* ────────────────────────── 动态权限升级 ────────────────────────── */
describe('动态权限：行驶中彩→灰', () => {
  it('静止时 window.set 为彩级，直接执行', () => {
    expect(reg.invoke('window.set', { window: 'driver', position: 50 }).status).toBe('ok')
  })

  it('行驶中 window.set 升级为灰级，需要确认', () => {
    store.setDirect('vehicle.speed', 60)
    const r = reg.invoke('window.set', { window: 'driver', position: 50 })
    expect(r.status).toBe('inputRequired')
  })

  it('permissionOf 反映当前动态等级', () => {
    expect(reg.permissionOf('window.set')).toBe('彩')
    store.setDirect('vehicle.speed', 60)
    expect(reg.permissionOf('window.set')).toBe('灰')
  })
})

/* ────────────────────────── 读取类 Tool ────────────────────────── */
describe('vehicle.getState', () => {
  it('按 paths 精确读取', () => {
    const r = reg.invoke('vehicle.getState', { paths: ['vehicle.speed', 'cabin.childLock'] })
    expect(r.status).toBe('ok')
    expect(r.data).toEqual({ 'vehicle.speed': 0, 'cabin.childLock': false })
  })

  it('不传参返回全量快照', () => {
    const r = reg.invoke('vehicle.getState', {})
    expect(Object.keys(r.data as object).length).toBe(SIGNALS.length)
  })

  it('未知 path 被忽略而非报错', () => {
    const r = reg.invoke('vehicle.getState', { paths: ['nope.nope'] })
    expect(r.status).toBe('ok')
    expect(r.data).toEqual({})
  })
})

/* ────────────────────────── 契约完整性 ────────────────────────── */
describe('Tool 契约完整性', () => {
  it('每个暴露的 Tool 都有非空 description（模型选型依据）', () => {
    for (const t of reg.list()) expect(t.desc, `${t.name} 缺少 desc`).toBeTruthy()
  })

  it('每个 Tool 都声明了 permission', () => {
    for (const t of TOOLS) expect(t.permission, `${t.name} 缺少 permission`).toBeTruthy()
  })
})
