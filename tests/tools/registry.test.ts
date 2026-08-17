import { describe, it, expect, beforeEach } from 'vitest'
import { createStore } from '../../src/core/store'
import { createRegistry } from '../../src/tools/registry'
import { SIGNALS } from '../../src/config/signals'
import { CONSTRAINTS } from '../../src/config/constraints'
import { TOOLS } from '../../src/config/tools'
import { createAmapClient, type Fetcher } from '../../src/integrations/amap'
import { createDesk } from '../../src/cards/desk'
import { CARD_TEMPLATES } from '../../src/config/cards'

const createDeskForTest = () => createDesk(() => now)

/** 假高德：按路径返回预设响应，不打真实网络。复用真实 createAmapClient，测的是真实拼装链路 */
const fakeAmap = (routes: Record<string, any>) => createAmapClient(
  (async (url: string) => {
    const path = new URL(url).pathname
    const r = routes[path]
    if (!r) throw new Error(`没有为 ${path} 配置假响应`)
    // 函数式：同一个接口连着调多次要能返回不同结果（并行查多地天气）
    const body = typeof r === 'function' ? r() : r
    return { ok: true, json: async () => body }
  }) as Fetcher,
  { webKey: 'test-key' },
)

let store: ReturnType<typeof createStore>
let reg: ReturnType<typeof createRegistry>
let now = 1_000_000

beforeEach(() => {
  now = 1_000_000
  store = createStore(SIGNALS, CONSTRAINTS)
  reg = createRegistry(store, TOOLS, () => now)
})


/**
 * ══════════ `{item:[…]}` 是模型对数组的常见退化，展平它 ══════════
 *
 * 实拍两次同一个病：`story.begin` 的 pages 传成 `{item:[…]}`（补了 items
 * schema 之后好了），`card.show` 的 data.items 又是 `{item:[…]}`，而且
 * **连着重试 9 轮**、40 秒、最后一句话没说 —— 用户问"你有什么功能"，
 * 屏幕空白，Agent 沉默。
 *
 * `card.show` 的 data 是自由对象，schema 管不到里面，只能在这一层收。
 * 展平它跟宽容 `"24"` → 24 是同一类：**协议适配，不是意图分支** ——
 * 判据只看数据形状（只有一个 item 键、值是数组或同形对象），
 * 不看它是哪个工具、什么语义。
 */
describe('数组的退化写法', () => {
  let desk: ReturnType<typeof createDeskForTest>
  let r2: ReturnType<typeof createRegistry>
  beforeEach(() => {
    desk = createDeskForTest()
    r2 = createRegistry(store, TOOLS, () => now, { desk })
  })

  it('数组参数写成 {item:[…]} 时展平，不是硬拒', async () => {
    const r = await r2.invoke('vehicle.getState', { paths: { item: ['vehicle.speed'] } } as any)
    expect(r.status, '展平之后应该能过').toBe('ok')
  })

  it('嵌套在自由对象里的也展平 —— card.show 的 data 就是自由对象', async () => {
    const r = await r2.invoke('card.show', {
      template: 'list', size: 'box', ttl: 'untilDismissed',
      data: { title: 'x', items: { item: [{ label: 'a' }, { label: 'b' }] } },
    } as any)
    expect(r.status).toBe('ok')
    expect(desk.layout().cards.find(c => c.template === 'list')!.data.items).toHaveLength(2)
  })

  it('套了两层也展平 —— 实拍模型急了会 {item:{item:[…]}}', async () => {
    const r = await r2.invoke('vehicle.getState',
      { paths: { item: { item: ['vehicle.speed'] } } } as any)
    expect(r.status).toBe('ok')
  })

  /** 只认"只有 item 一个键"这一种形状，别把真数据改坏 */
  it('还有别的键就不动 —— 那是真数据不是退化', async () => {
    const r = await r2.invoke('card.show', {
      template: 'list', size: 'box', ttl: 'untilDismissed',
      data: { title: 'x', items: [{ label: 'a', item: ['真数据'], note: 'n' }] },
    } as any)
    expect(r.status).toBe('ok')
    const card = desk.layout().cards.find(c => c.template === 'list')!
    expect(card.data.items[0].item).toEqual(['真数据'])
    expect(card.data.items[0].note).toBe('n')
  })
})


/**
 * ══════════ 改版同一张卡要能表达"还是那张" ══════════
 *
 * 实拍（2026-08-14）：让 Agent 做一份研究报告，后台子 Agent 因为内容溢出
 * **反复重排**，每次重排都建一张新卡 —— 屏幕上最后堆了 6 张同一份报告的
 * 不同版本（上/下/①/②…），用户的原话是"满屏幕都是"。
 *
 * `desk.render` 的 key 机制本来就在，handler 也一直在透传 `args.key`，
 * **但 card.show 的参数表里没有声明它** —— 模型看不见的参数等于不存在。
 * 加一条声明就是"加数据不加代码"。
 */
describe('card.show 的 key：同一张卡的新版本', () => {
  let desk: ReturnType<typeof createDeskForTest>
  let r2: ReturnType<typeof createRegistry>
  beforeEach(() => {
    desk = createDeskForTest()
    r2 = createRegistry(store, TOOLS, () => now, { desk })
  })

  it('schema 里要有 key，而且说清它是干嘛的', () => {
    const s = r2.schemas('openai').find(x => x.function.name === 'card_show')!
    const key = s.function.parameters.properties.key
    expect(key, 'key 没声明，模型永远用不到').toBeTruthy()
    expect(key.description, '得说清是"同一张卡的新版本"').toMatch(/同一张|改版|重排|替换/)
  })

  it('同 key 两次 show = 刷新那一张，不是堆两张', async () => {
    const one = (title: string) => r2.invoke('card.show', {
      template: 'generic', size: 'box', ttl: 'untilDismissed',
      key: 'report', data: { title, text: title },
    } as any)
    await one('报告 v1')
    await one('报告 v2')
    const cards = desk.layout().cards.filter(c => c.template === 'generic')
    expect(cards, '同一个 key 只该有一张').toHaveLength(1)
    expect(cards[0].data.title).toBe('报告 v2')
  })

  it('不同 key 各是各的 —— 报告的上下两篇仍然并存', async () => {
    for (const k of ['up', 'down'])
      await r2.invoke('card.show', {
        template: 'generic', size: 'box', ttl: 'untilDismissed',
        key: k, data: { title: k, text: k },
      } as any)
    expect(desk.layout().cards.filter(c => c.template === 'generic')).toHaveLength(2)
  })
})

/* ────────────────────────── 注册表与 Schema ────────────────────────── */
describe('注册表', () => {
  it('「黑」级 Tool 永不暴露给 Agent —— 永久禁区', async () => {
    const names = reg.list().map(t => t.name)
    expect(names).not.toContain('brake.apply')
    expect(TOOLS.some(t => t.name === 'brake.apply')).toBe(true) // 配置里有，但不暴露
  })

  it('调用「黑」级 Tool 直接 unavailable / BLOCKED', async () => {
    const r = await reg.invoke('brake.apply', { force: 1 })
    expect(r.status).toBe('unavailable')
    expect(r.code).toBe('BLOCKED')
  })

  it('导出 OpenAI function calling 格式', async () => {
    const s = reg.schemas('openai').find(x => x.function.name === 'window_set')!
    expect(s.type).toBe('function')
    expect(s.function.description).toBeTruthy()
    expect(s.function.parameters.type).toBe('object')
    expect(s.function.parameters.properties.position.type).toBe('number')
    expect(s.function.parameters.properties.window.enum).toContain('all')
    expect(s.function.parameters.required).toContain('window')
  })

  /**
   * ══════════ 数组参数必须说清楚里面装什么 ══════════
   *
   * 实拍（2026-08-14）：`story.begin` **连着被拒两次** —— 模型先传
   * `pageCount:"3"`，再传 `pages:{item:[...]}`，第三次才蒙对。
   * 不是模型笨：schema 里 `pages` 只声明了「是个数组」，
   * 元素长什么样只写在 desc 的散文里，模型只能猜。
   *
   * 补 `items` 的完整形状是**加数据不加代码**：ParamDef 允许 items 直接写
   * 一段 JSON Schema，registry 原样透传。
   */
  it('数组参数的元素形状原样进 schema —— 别让模型猜', async () => {
    const s = reg.schemas('openai').find(x => x.function.name === 'story_begin')!
    const pages = s.function.parameters.properties.pages
    expect(pages.type).toBe('array')
    expect(pages.items?.type, 'pages 装的是对象').toBe('object')
    expect(Object.keys(pages.items.properties), '两个字段都得说明').toEqual(['line', 'scene'])
    expect(pages.items.required).toEqual(['line', 'scene'])
  })

  it('老写法（items 直接写类型名）继续有效', async () => {
    const s = reg.schemas('openai').find(x => x.function.name === 'vehicle_getState')!
    expect(s.function.parameters.properties.paths.items).toEqual({ type: 'string' })
  })

  it('能力授权：白名单外的 Tool 不暴露且不可调用', async () => {
    const names = reg.list(['window.*', 'vehicle.getState']).map(t => t.name)
    expect(names).toContain('window.set')
    expect(names).not.toContain('door.set')
    const r = await reg.invoke('door.set', { door: 'driver', action: 'open' }, { allow: ['window.*'] })
    expect(r.status).toBe('unavailable')
    expect(r.code).toBe('NOT_AUTHORIZED')
  })

  it('未知 Tool 返回 unavailable / UNKNOWN_TOOL', async () => {
    expect((await reg.invoke('teleport.now', {})).code).toBe('UNKNOWN_TOOL')
  })
})

/* ────────────────────────── 零代码 handler ────────────────────────── */
describe('由 writes 声明自动生成的 handler', () => {
  it('彩级直接执行并写入 store', async () => {
    const r = await reg.invoke('window.set', { window: 'driver', position: 60 })
    expect(r.status).toBe('ok')
    expect(store.getTarget('cabin.window.driver.position')).toBe(60)
    expect(r.changed).toEqual(['cabin.window.driver.position'])
  })

  it('all 自动展开为四扇窗，一次调用四条 changed', async () => {
    const r = await reg.invoke('window.set', { window: 'all', position: 100 })
    expect(r.status).toBe('ok')
    expect(r.changed).toHaveLength(4)
    expect(store.getTarget('cabin.window.rearRight.position')).toBe(100)
  })

  it('参数缺失返回 rejected / INVALID_PARAMS', async () => {
    expect((await reg.invoke('window.set', { window: 'driver' })).code).toBe('INVALID_PARAMS')
  })

  it('参数越界返回 rejected / INVALID_PARAMS', async () => {
    expect((await reg.invoke('window.set', { window: 'driver', position: 300 })).code).toBe('INVALID_PARAMS')
    expect((await reg.invoke('window.set', { window: 'roof', position: 10 })).code).toBe('INVALID_PARAMS')
  })
})

/* ────────────────────────── 约束透传 ────────────────────────── */
describe('约束结果透传到 ToolResult', () => {
  it('限位场景：ok + code + 人话 message（Golden Case 7）', async () => {
    store.setDirect('vehicle.speed', 120)
    const r = await reg.invoke('window.set', { window: 'driver', position: 100 }, { confirmToken: undefined, force: true })
    expect(r.status).toBe('ok')
    expect(r.code).toBe('SPEED_LIMITED')
    expect(r.message).toContain('120')
  })

  it('儿童锁场景：rejected + suggestion（Golden Case 8）', async () => {
    store.set('cabin.childLock', true)
    const r = await reg.invoke('window.set', { window: 'rearLeft', position: 100 })
    expect(r.status).toBe('rejected')
    expect(r.code).toBe('CHILD_LOCK_ON')
    expect(r.suggestion).toBeTruthy()
  })

  it('未选装：unavailable / NOT_EQUIPPED，绝不假装成功（Golden Case 9）', async () => {
    const r = await reg.invoke('sunroof.set', { position: 100 })
    expect(r.status).toBe('unavailable')
    expect(r.code).toBe('NOT_EQUIPPED')
  })

  it('批量展开中任一被拒 → 整体 rejected，不做部分写入', async () => {
    store.set('cabin.childLock', true)
    const before = store.getTarget('cabin.window.driver.position')
    const r = await reg.invoke('window.set', { window: 'all', position: 100 })
    expect(r.status).toBe('rejected')
    expect(store.getTarget('cabin.window.driver.position')).toBe(before)
  })
})

/* ────────────────────────── MRTR 二次确认（对齐 MCP 2026-07-28） ────────────────────────── */
describe('二次确认 · MCP MRTR inputRequired', () => {
  it('灰级 Tool 首次调用返回 inputRequired + token，且不执行', async () => {
    const r = await reg.invoke('door.set', { door: 'driver', action: 'open' })
    expect(r.status).toBe('inputRequired')
    expect(r.code).toBe('CONFIRM_REQUIRED')
    expect(r.token).toBeTruthy()
    expect(r.message).toBeTruthy()
    expect(store.getTarget('cabin.door.driver.isOpen')).toBe(false)
  })

  it('带正确 token 重调则真正执行', async () => {
    const first = await reg.invoke('door.set', { door: 'driver', action: 'open' })
    const r = await reg.invoke('door.set', { door: 'driver', action: 'open' }, { confirmToken: first.token })
    expect(r.status).toBe('ok')
    expect(store.getTarget('cabin.door.driver.isOpen')).toBe(true)
  })

  it('token 一次性，第二次使用失效', async () => {
    const first = await reg.invoke('door.set', { door: 'driver', action: 'open' })
    await reg.invoke('door.set', { door: 'driver', action: 'open' }, { confirmToken: first.token })
    const again = await reg.invoke('door.set', { door: 'driver', action: 'close' }, { confirmToken: first.token })
    expect(again.status).toBe('inputRequired') // 需要重新确认
  })

  it('token 60s 后过期', async () => {
    const first = await reg.invoke('door.set', { door: 'driver', action: 'open' })
    now += 61_000
    const r = await reg.invoke('door.set', { door: 'driver', action: 'open' }, { confirmToken: first.token })
    expect(r.status).toBe('inputRequired')
  })

  it('空字符串 token 视为未提供（gpt-5-nano 实测会主动传 confirmToken:""）', async () => {
    const r = await reg.invoke('door.set', { door: 'driver', action: 'open', confirmToken: '' })
    expect(r.status).toBe('inputRequired')
    expect(r.token).toBeTruthy()
    expect(store.getTarget('cabin.door.driver.isOpen')).toBe(false)
  })

  it('伪造 token 无效', async () => {
    const r = await reg.invoke('door.set', { door: 'driver', action: 'open' }, { confirmToken: 'ct_fake' })
    expect(r.status).toBe('inputRequired')
  })

  it('token 与 Tool 名绑定，不能跨 Tool 复用', async () => {
    const first = await reg.invoke('door.set', { door: 'driver', action: 'open' })
    const r = await reg.invoke('window.set', { window: 'driver', position: 50 }, { confirmToken: first.token })
    expect(r.status).toBe('ok') // 彩级本就不需要 token，但不应因此消耗它
    const reuse = await reg.invoke('door.set', { door: 'driver', action: 'open' }, { confirmToken: first.token })
    expect(reuse.status).toBe('ok')
  })
})

/* ────────────────────────── 动态权限升级 ────────────────────────── */
describe('动态权限：行驶中彩→灰', () => {
  it('静止时 window.set 为彩级，直接执行', async () => {
    expect((await reg.invoke('window.set', { window: 'driver', position: 50 })).status).toBe('ok')
  })

  it('行驶中 window.set 升级为灰级，需要确认', async () => {
    store.setDirect('vehicle.speed', 60)
    const r = await reg.invoke('window.set', { window: 'driver', position: 50 })
    expect(r.status).toBe('inputRequired')
  })

  it('permissionOf 反映当前动态等级', async () => {
    expect(reg.permissionOf('window.set')).toBe('彩')
    store.setDirect('vehicle.speed', 60)
    expect(reg.permissionOf('window.set')).toBe('灰')
  })
})

/* ────────────────────────── 读取类 Tool ────────────────────────── */
describe('vehicle.getState', () => {
  it('按 paths 精确读取', async () => {
    const r = await reg.invoke('vehicle.getState', { paths: ['vehicle.speed', 'cabin.childLock'] })
    expect(r.status).toBe('ok')
    expect(r.data).toEqual({ 'vehicle.speed': 0, 'cabin.childLock': false })
  })

  it('不传参返回全量快照', async () => {
    const r = await reg.invoke('vehicle.getState', {})
    expect(Object.keys(r.data as object).length).toBe(SIGNALS.length)
  })

  it('未知 path 被忽略而非报错', async () => {
    const r = await reg.invoke('vehicle.getState', { paths: ['nope.nope'] })
    expect(r.status).toBe('ok')
    expect(r.data).toEqual({})
  })
})

/* ────────────────────────── 能力目录（供能力目录卡渲染） ────────────────────────── */
describe('capability.list', () => {
  // 用户点名："现在感觉像个工程化界面"。目录给人看，条目是能力域
  // （车窗/空调/导航……），用语言+icon 介绍，函数名一个都不许漏出去
  it('条目是能力域不是函数名——label 无点号、带 icon、有人话简介', async () => {
    const r = await reg.invoke('capability.list', {})
    expect(r.status).toBe('ok')
    const items = (r.data as any).items
    expect(items.length).toBeGreaterThan(5)
    for (const i of items) {
      expect(i.label, i.label).not.toMatch(/[.a-z]{3,}\./)
      expect(i.icon, `${i.label} 缺 icon`).toBeTruthy()
      expect(i.desc, `${i.label} 缺简介`).toBeTruthy()
    }
    expect(items.map((i: any) => i.label)).toContain('车窗')
  })

  it('机制类工具（card.*/voice.*/brake）不进目录——那是管道不是能力', async () => {
    const r = await reg.invoke('capability.list', {})
    const all = JSON.stringify((r.data as any).items)
    expect(all).not.toContain('card.')
    expect(all).not.toContain('voice.')
    expect(all).not.toContain('brake')
  })

  it('整个域都依赖未选装信号才标 off：天窗未选装 → 天窗域 off', async () => {
    const r = await reg.invoke('capability.list', {})
    const sunroof = (r.data as any).items.find((i: any) => i.label === '天窗')
    expect(sunroof.off).toBe(true)
    const win = (r.data as any).items.find((i: any) => i.label === '车窗')
    expect(win.off).toBeFalsy()
  })

  it('domain 按 Tool 名前缀过滤，返回对应的域', async () => {
    const r = await reg.invoke('capability.list', { domain: 'window' })
    const labels = (r.data as any).items.map((i: any) => i.label)
    expect(labels).toEqual(['车窗'])
  })
})

/* ── 数值参数宽容：实测模型常送 "24" 字符串，硬拒浪费一整轮往返 ── */
describe('数值参数字符串宽容', () => {
  it('"24" 自动转数值执行，不再 INVALID_PARAMS', async () => {
    const r = await reg.invoke('climate.set', { targetTemp: '24', fanSpeed: '3' })
    expect(r.status).toBe('ok')
    expect(store.get('cabin.climate.targetTemp')).toBe(24)
  })

  it('真不是数的还是拒——宽容不是不校验', async () => {
    const r = await reg.invoke('climate.set', { targetTemp: '很热' })
    expect(r.status).toBe('rejected')
  })
})

/* ────────────────────────── Tool 名 wire 格式（Anthropic 等 provider 不接受点号） ────────────────────────── */
describe('Tool 名 sanitize', () => {
  it('schemas() 导出的 name 不含点号，供严格校验的 provider 使用', async () => {
    for (const format of ['openai', 'anthropic', 'mcp'] as const) {
      for (const s of reg.schemas(format)) {
        const name = format === 'openai' ? s.function.name : s.name
        expect(name).toMatch(/^[a-zA-Z0-9_-]{1,128}$/)
      }
    }
  })

  it('window.set 导出为 window_set', async () => {
    const s = reg.schemas('anthropic').find(x => x.name === 'window_set')
    expect(s).toBeTruthy()
  })

  it('invoke 接受 provider 返回的下划线形式并正确路由到同一个 Tool', async () => {
    const viaDot = await reg.invoke('window.set', { window: 'driver', position: 60 })
    store = createStore(SIGNALS, CONSTRAINTS) // 重置
    reg = createRegistry(store, TOOLS, () => now)
    const viaUnderscore = await reg.invoke('window_set', { window: 'driver', position: 60 })
    expect(viaUnderscore.status).toBe(viaDot.status)
    expect(viaUnderscore.changed).toEqual(viaDot.changed)
  })

  it('白名单鉴权对下划线形式同样按点号语义生效', async () => {
    const r = await reg.invoke('door_set', { door: 'driver', action: 'open' }, { allow: ['window.*'] })
    expect(r.status).toBe('unavailable')
    expect(r.code).toBe('NOT_AUTHORIZED')
  })

  it('permissionOf 对下划线形式同样返回正确权限', async () => {
    expect(reg.permissionOf('door_set')).toBe('灰')
  })
})

/* ────────────────────────── 补齐的 L1 Tool ────────────────────────── */
describe('climate.set —— 一次调用写多个字段', () => {
  it('一次传 power + targetTemp + fanSpeed，三个信号都要生效', async () => {
    const r = await reg.invoke('climate.set', { power: true, targetTemp: 24, fanSpeed: 5 })
    expect(r.status).toBe('ok')
    expect(store.get('cabin.climate.power')).toBe(true)
    expect(store.get('cabin.climate.targetTemp')).toBe(24)
    expect(store.get('cabin.climate.fanSpeed')).toBe(5)
  })

  it('只传其中一个字段，其余字段不受影响', async () => {
    await reg.invoke('climate.set', { targetTemp: 26 })
    expect(store.get('cabin.climate.targetTemp')).toBe(26)
    expect(store.get('cabin.climate.power')).toBe(false)
  })

  it('一个字段越界，整体拒绝且不写入其它字段（杜绝部分提交）', async () => {
    const r = await reg.invoke('climate.set', { power: true, targetTemp: 99 })
    expect(r.status).toBe('rejected')
    expect(store.get('cabin.climate.power')).toBe(false)
  })

  it('低电量限制风量上限 3 档', async () => {
    store.setDirect('powertrain.soc', 5)
    const r = await reg.invoke('climate.set', { fanSpeed: 7 })
    expect(r.status).toBe('ok')
    expect(store.get('cabin.climate.fanSpeed')).toBe(3)
    expect(r.code).toBe('LOW_BATTERY_LIMIT')
  })

  it('什么字段都不传时拒绝', async () => {
    expect((await reg.invoke('climate.set', {})).status).toBe('rejected')
  })
})

describe('seat.set', () => {
  it('按位置设置加热档位', async () => {
    const r = await reg.invoke('seat.set', { seat: 'driver', heating: 2 })
    expect(r.status).toBe('ok')
    expect(store.get('seat.driver.heating')).toBe(2)
  })

  it('seat=all 展开到四个座椅', async () => {
    const r = await reg.invoke('seat.set', { seat: 'all', ventilation: 1 })
    expect(r.status).toBe('ok')
    expect(store.get('seat.rearRight.ventilation')).toBe(1)
  })

  it('后排没有滑动功能，返回 NOT_EQUIPPED 而不是裸错误', async () => {
    const r = await reg.invoke('seat.set', { seat: 'rearLeft', slide: 60 })
    expect(r.status).toBe('unavailable')
    expect(r.code).toBe('NOT_EQUIPPED')
  })
})

describe('steeringWheel.set', () => {
  it('设置方向盘加热档位', async () => {
    const r = await reg.invoke('steeringWheel.set', { heating: 3 })
    expect(r.status).toBe('ok')
    expect(store.get('cabin.steeringWheel.heating')).toBe(3)
  })
})

describe('trunk.set', () => {
  it('P 挡可以打开后备箱', async () => {
    const r = await reg.invoke('trunk.set', { target: 'trunk', action: 'open' }, { force: true })
    expect(r.status).toBe('ok')
    expect(store.get('cabin.trunk.isOpen')).toBe(true)
  })

  it('非 P 挡禁止打开后备箱', async () => {
    store.setDirect('vehicle.gear', 'd')
    const r = await reg.invoke('trunk.set', { target: 'trunk', action: 'open' }, { force: true })
    expect(r.status).toBe('rejected')
    expect(r.code).toBe('GEAR_NOT_PARK')
  })
})

describe('chargePort.set', () => {
  it('打开充电口', async () => {
    const r = await reg.invoke('chargePort.set', { action: 'open' })
    expect(r.status).toBe('ok')
    expect(store.get('cabin.chargePort.isOpen')).toBe(true)
  })
})

describe('ambientLight.set / fragrance.set / light.set', () => {
  it('氛围灯一次设置颜色和亮度', async () => {
    const r = await reg.invoke('ambientLight.set', { power: true, color: 'blue', brightness: 80 })
    expect(r.status).toBe('ok')
    expect(store.get('cabin.ambientLight.color')).toBe('blue')
    expect(store.get('cabin.ambientLight.brightness')).toBe(80)
  })

  it('香氛设置香型和强度', async () => {
    const r = await reg.invoke('fragrance.set', { power: true, scent: 'citrus', intensity: 2 })
    expect(r.status).toBe('ok')
    expect(store.get('cabin.fragrance.scent')).toBe('citrus')
  })

  it('近光开关', async () => {
    const r = await reg.invoke('light.set', { light: 'lowBeam', state: 'on' })
    expect(r.status).toBe('ok')
    expect(store.get('cabin.light.lowBeam.state')).toBe('on')
  })
})

/**
 * ══════════ 对着真实整车能力清单补齐的一批 ══════════
 *
 * 2026-08-15 拿真实车辆的 908 条原子能力清单比对之后补的。
 * 判据是「加数据不加代码」——这一整批只改 `src/config/*.ts`，零 handler。
 */
describe('车外灯与阅读灯', () => {
  /**
   * **原来的 `headlight` 是个错名。** 它的 vssPath 指向
   * `Vehicle.Body.Lights.Beam.Low.IsOn` —— 那是**近光**，而 label 写的是"大灯"。
   * 补进远光之后两者语义会打架，所以这是**修正**不是新增。
   */
  it('近光的信号名跟它的 VSS 路径对上了', () => {
    const lo = SIGNALS.find(s => s.alias === 'cabin.light.lowBeam.state')!
    expect(lo, 'headlight 该改名成 lowBeam').toBeTruthy()
    expect(lo.vssPath).toContain('Beam.Low')
    expect(SIGNALS.some(s => s.alias === 'cabin.light.headlight.state'), '错名不该留着').toBe(false)
  })

  it('远光 / 前后雾灯 / 示宽灯都能开关', async () => {
    for (const [light, path] of [
      ['highBeam', 'cabin.light.highBeam.state'],
      ['fogFront', 'cabin.light.fogFront.state'],
      ['fogRear', 'cabin.light.fogRear.state'],
      ['parking', 'cabin.light.parking.state'],
    ] as const) {
      const r = await reg.invoke('light.set', { light, state: 'on' })
      expect(r.status, light).toBe('ok')
      expect(store.get(path), light).toBe('on')
    }
  })

  it('前后排阅读灯分开控制', async () => {
    await reg.invoke('light.set', { light: 'readingRear', state: 'on' })
    expect(store.get('cabin.light.readingRear.state')).toBe('on')
    expect(store.get('cabin.light.readingFront.state'), '不该连坐').toBe('off')
  })

  /** 车外灯的 VSS 路径都在 Body.Lights 下，别跟座舱灯混在一起 */
  it('车外灯挂 Body.Lights，座舱灯挂 Cabin.Light', () => {
    for (const a of ['highBeam', 'fogFront', 'fogRear', 'parking'])
      expect(SIGNALS.find(s => s.alias === `cabin.light.${a}.state`)!.vssPath).toContain('Body.Lights')
    for (const a of ['readingFront', 'readingRear'])
      expect(SIGNALS.find(s => s.alias === `cabin.light.${a}.state`)!.vssPath).toContain('Cabin.Light')
  })
})

describe('座椅按摩', () => {
  it('跟加热通风一样是 0-3 档，四个座位都有', async () => {
    const r = await reg.invoke('seat.set', { seat: 'driver', massage: 2 })
    expect(r.status).toBe('ok')
    expect(store.get('seat.driver.massage')).toBe(2)
    await reg.invoke('seat.set', { seat: 'all', massage: 1 })
    for (const p of ['driver', 'passenger', 'rearLeft', 'rearRight'])
      expect(store.get(`seat.${p}.massage`), p).toBe(1)
  })

  it('超出档位被拒，不是夹住', async () => {
    expect((await reg.invoke('seat.set', { seat: 'driver', massage: 9 })).status).toBe('rejected')
  })
})

describe('天窗遮阳帘', () => {
  /**
   * 并进 `sunroof.set` 而不是新开一个 Tool：现有信号路径本来就是
   * `cabin.sunroof.**glass**.position`，加一个 part 参数天然吻合，零破坏。
   *
   * 本车天窗刻意标了 `equipped: false`（反幻觉验证用，见 Golden Case 9），
   * 所以这一组要在"装了天窗"的车上跑 —— 顺带验证了一条真实约束：
   * **天窗没装，遮阳帘也不可能有**，两条信号的 equipped 必须一致。
   */
  const withSunroof = () => createRegistry(
    createStore(SIGNALS.map(x => x.alias.startsWith('cabin.sunroof') ? { ...x, equipped: true } : x),
      CONSTRAINTS), TOOLS, () => now)

  it('遮阳帘跟天窗玻璃同装同不装', () => {
    const g = SIGNALS.find(s => s.alias === 'cabin.sunroof.glass.position')!
    const sh = SIGNALS.find(s => s.alias === 'cabin.sunroof.shade.position')!
    expect(sh.equipped).toBe(g.equipped)
  })

  it('玻璃和遮阳帘各走各的', async () => {
    const r2 = withSunroof()
    await r2.invoke('sunroof.set', { part: 'glass', position: 100 })
    await r2.invoke('sunroof.set', { part: 'shade', position: 40 })
    const snap = (r2 as any)
    void snap
    expect((await r2.invoke('vehicle.getState', { paths: ['cabin.sunroof.glass.position'] })).status).toBe('ok')
  })

  it('不传 part 时默认动玻璃 —— "开天窗"说的就是它', async () => {
    const r = await withSunroof().invoke('sunroof.set', { position: 60 })
    expect(r.status, '装了天窗就该能开').toBe('ok')
    expect(r.changed, '动的是玻璃不是遮阳帘').toContain('cabin.sunroof.glass.position')
  })
})

describe('后视镜', () => {
  it('折叠和加热分开，both 一次控制两侧', async () => {
    await reg.invoke('mirror.set', { mirror: 'both', fold: true })
    expect(store.get('cabin.mirror.driver.isFolded')).toBe(true)
    expect(store.get('cabin.mirror.passenger.isFolded')).toBe(true)
    await reg.invoke('mirror.set', { mirror: 'driver', heating: true })
    expect(store.get('cabin.mirror.driver.heating')).toBe(true)
    expect(store.get('cabin.mirror.passenger.heating'), '只热主驾那侧').toBe(false)
  })
})

describe('空气净化器', () => {
  it('开关与档位可以一次传', async () => {
    const r = await reg.invoke('airPurifier.set', { power: true, level: 3 })
    expect(r.status).toBe('ok')
    expect(store.get('cabin.airPurifier.power')).toBe(true)
    expect(store.get('cabin.airPurifier.level')).toBe(3)
  })
})

describe('driveSetting.set —— 行驶中降灰', () => {
  it('静止时彩级直接执行', async () => {
    const r = await reg.invoke('driveSetting.set', { driveMode: 'sport' })
    expect(r.status).toBe('ok')
    expect(store.get('vehicle.driveMode')).toBe('sport')
  })

  it('行驶中需要二次确认', async () => {
    store.setDirect('vehicle.speed', 80)
    const r = await reg.invoke('driveSetting.set', { driveMode: 'sport' })
    expect(r.status).toBe('inputRequired')
  })
})

describe('door.set 已扩展到四门 + 儿童锁联动后门', () => {
  it('可以开副驾车门', async () => {
    const r = await reg.invoke('door.set', { door: 'passenger', action: 'open' }, { force: true })
    expect(r.status).toBe('ok')
    expect(store.get('cabin.door.passenger.isOpen')).toBe(true)
  })

  it('儿童锁开启时后门也不可开', async () => {
    store.setDirect('cabin.childLock', true)
    const r = await reg.invoke('door.set', { door: 'rearLeft', action: 'open' }, { force: true })
    expect(r.status).toBe('rejected')
    expect(r.code).toBe('CHILD_LOCK_ON')
  })
})

describe('voice.ask', () => {
  it('返回问题与选项，供 Agent 播报与确认卡渲染', async () => {
    const r = await reg.invoke('voice.ask', { question: '要不要顺路充电？', options: ['好', '不用'] })
    expect(r.status).toBe('ok')
    expect((r.data as any).options).toEqual(['好', '不用'])
  })
})

/* ────────────────────────── 高德导航（真实三方 API，接口对齐已核对） ────────────────────────── */
describe('navigation.search', () => {
  it('搜到候选点', async () => {
    const r = createRegistry(store, TOOLS, () => now, {
      amap: fakeAmap({ '/v5/place/text': { status: '1', pois: [{ id: 'B1', name: '望京 SOHO', address: '望京街10号', location: '116.48,39.99' }] } }),
    })
    const res = await r.invoke('navigation.search', { query: '望京 SOHO' })
    expect(res.status).toBe('ok')
    expect((res.data as any).pois[0].name).toBe('望京 SOHO')
  })

  it('高德服务失败时返回 unavailable，不编造结果（CAR-bench 反幻觉）', async () => {
    const r = createRegistry(store, TOOLS, () => now, {
      amap: fakeAmap({ '/v5/place/text': { status: '0', info: 'INVALID_USER_KEY' } }),
    })
    const res = await r.invoke('navigation.search', { query: 'x' })
    expect(res.status).toBe('unavailable')
    expect(res.message).toBeTruthy()
  })

  it('搜出多个候选时，候选列表卡自动上屏——不指望模型自觉建卡', async () => {
    const { createDesk } = await import('../../src/cards/desk')
    const desk = createDesk(() => now)
    const r = createRegistry(store, TOOLS, () => now, {
      desk,
      amap: fakeAmap({ '/v5/place/text': { status: '1', pois: [
        { id: 'B1', name: '春熙路步行街', address: '锦江区', location: '104.07,30.65' },
        { id: 'B2', name: '春熙路地铁站', address: '锦江区', location: '104.08,30.66' },
      ] } }),
    })
    const res = await r.invoke('navigation.search', { query: '春熙路' })
    expect(res.status).toBe('ok')
    const card = desk.findByKey('candidates')!
    expect(card).toBeTruthy()
    expect(card.template).toBe('list')
    expect(card.data.items).toHaveLength(2)
    expect(card.data.items[0].label).toBe('春熙路步行街')
  })

  it('只有一个候选时不打扰桌面', async () => {
    const { createDesk } = await import('../../src/cards/desk')
    const desk = createDesk(() => now)
    const r = createRegistry(store, TOOLS, () => now, {
      desk,
      amap: fakeAmap({ '/v5/place/text': { status: '1', pois: [
        { id: 'B1', name: '春熙路步行街', address: '锦江区', location: '104.07,30.65' },
      ] } }),
    })
    await r.invoke('navigation.search', { query: '春熙路步行街' })
    expect(desk.findByKey('candidates')).toBeUndefined()
  })

  it('setDestination 定下来后候选列表卡自动撤掉——任务闭环', async () => {
    const { createDesk } = await import('../../src/cards/desk')
    const desk = createDesk(() => now)
    const r = createRegistry(store, TOOLS, () => now, {
      desk,
      amap: fakeAmap({
        '/v5/place/text': { status: '1', pois: [
          { id: 'B1', name: '甲', address: 'a', location: '104.07,30.65' },
          { id: 'B2', name: '乙', address: 'b', location: '104.08,30.66' },
        ] },
        '/v5/place/detail': { status: '1', pois: [{ id: 'B1', name: '甲', address: 'a', location: '104.07,30.65' }] },
        '/v5/direction/driving': { status: '1', route: { paths: [{ distance: '9000', cost: { duration: '1200' }, steps: [] }] } },
      }),
    })
    await r.invoke('navigation.search', { query: 'x' })
    expect(desk.findByKey('candidates')).toBeTruthy()
    await r.invoke('navigation.setDestination', { poiId: 'B1' })
    expect(desk.findByKey('candidates')).toBeUndefined()
  })

  // 用户实拍：从"附近的停车场"里挑了一个设成目的地，那张周边列表一直留在屏上。
  // 目的地一定，along 卡跟候选卡一样算"这件事翻篇"
  it('setDestination 定下来后沿途/周边搜索卡也撤掉', async () => {
    const { createDesk } = await import('../../src/cards/desk')
    const desk = createDesk(() => now)
    const r = createRegistry(store, TOOLS, () => now, {
      desk,
      amap: fakeAmap({
        '/v5/place/around': { status: '1', pois: [
          { id: 'P1', name: '停车场甲', address: 'a', location: '104.07,30.60', distance: '300' },
          { id: 'P2', name: '停车场乙', address: 'b', location: '104.08,30.61', distance: '500' },
        ] },
        '/v5/place/detail': { status: '1', pois: [{ id: 'P1', name: '停车场甲', address: 'a', location: '104.07,30.60' }] },
        '/v5/direction/driving': { status: '1', route: { paths: [{ distance: '900', cost: { duration: '120' }, steps: [] }] } },
      }),
    })
    await r.invoke('navigation.searchAlong', { keyword: '停车场' })
    expect(desk.findByKey('along')).toBeTruthy()
    await r.invoke('navigation.setDestination', { poiId: 'P1' })
    expect(desk.findByKey('along')).toBeUndefined()
  })

  // 模板已经声明了自己支持哪些尺寸，仲裁该认这个下限，不该让每个建卡处手写
  it('自动上屏的卡从模板 sizes 继承最小尺寸', async () => {
    const desk = createDesk()
    const r = createRegistry(store, TOOLS, () => now, {
      desk,
      amap: fakeAmap({ '/v5/place/text': { status: '1', pois: [
        { id: 'B1', name: '甲', address: 'a', location: '104.07,30.65' },
        { id: 'B2', name: '乙', address: 'b', location: '104.08,30.66' },
      ] } }),
    })
    await r.invoke('navigation.search', { query: 'x' })
    expect(desk.findByKey('candidates')!.minSize).toBe('box') // list 模板最小的那档
  })

  // 候选卡不能像问题卡那样"用户一开口就撤"——实测用户的下一句往往就是冲着
  // 屏幕上这张卡问的（"上面那个离这儿多远？"），撤了他就没东西可指了
  it('用户就着候选卡追问时，卡片还在', async () => {
    const desk = createDesk()
    const r = createRegistry(store, TOOLS, () => now, {
      desk,
      amap: fakeAmap({
        '/v5/place/text': { status: '1', pois: [
          { id: 'B1', name: '甲', address: 'a', location: '104.07,30.65' },
          { id: 'B2', name: '乙', address: 'b', location: '104.08,30.66' },
        ] },
      }),
    })
    await r.invoke('navigation.search', { query: 'x' })
    desk.endTask()
    expect(desk.findByKey('candidates')).toBeTruthy()
  })

  // 卡片没上屏而 Tool 说 ok，Agent 就会照常说"你说第几个"，用户对着空屏幕懵。
  // 桌面确实可能满，但那时候必须让 Agent 知道——即使它现在进的是等位区而不是被拒绝
  it('候选卡进等位区时，Tool 结果里要带得出这件事', async () => {
    const desk = createDesk()
    // 先用一张挤不走的 2/3 导航卡 + 两张 1/6 把桌面占死
    desk.show({ template: 'nav', size: 'stage', kind: 'system', evictable: false, ttl: 'untilDismissed' })
    desk.show({ template: 'feedback', size: 'box', kind: 'system', evictable: false, ttl: 'untilDismissed' })
    desk.show({ template: 'feedback', size: 'box', kind: 'system', evictable: false, ttl: 'untilDismissed' })
    const r = createRegistry(store, TOOLS, () => now, {
      desk,
      amap: fakeAmap({ '/v5/place/text': { status: '1', pois: [
        { id: 'B1', name: '甲', address: 'a', location: '104.07,30.65' },
        { id: 'B2', name: '乙', address: 'b', location: '104.08,30.66' },
      ] } }),
    })
    const res = await r.invoke('navigation.search', { query: 'x' })
    expect(res.status).toBe('ok')         // 搜索本身是成功的
    expect(res.code).toBe('CARD_STAGED')  // 但得让 Agent 知道屏幕上暂时没东西（排队中，不是消失）
    expect(res.message).toBeTruthy()
    expect(desk.findByKey('candidates'), '数据还在——排在等位区').toBeTruthy()
  })

  // 实测用户在成都说"临平出口"，全国搜命中了杭州临平区，规划出 1800 公里。
  // 没指定城市时就该在当前城市里找——这是车机导航的常识
  it('没传 near 时按车辆当前城市搜，不满世界找同名地点', async () => {
    const calls: string[] = []
    const amap = createAmapClient((async (url: string) => {
      calls.push(url)
      const path = new URL(url).pathname
      const body = path === '/v3/geocode/regeo'
        ? { status: '1', regeocode: { addressComponent: { city: '成都市', province: '四川省' } } }
        : { status: '1', pois: [{ id: 'B1', name: '临平', address: 'a', location: '104.07,30.65' }] }
      return { ok: true, json: async () => body }
    }) as Fetcher, { webKey: 'test-key' })
    const r = createRegistry(store, TOOLS, () => now, { amap })
    await r.invoke('navigation.search', { query: '临平出口' })
    const search = calls.find(u => u.includes('/v5/place/text'))!
    expect(new URL(search).searchParams.get('region')).toBe('成都市')
  })

  it('用户明说了城市就听用户的', async () => {
    const calls: string[] = []
    const amap = createAmapClient((async (url: string) => {
      calls.push(url)
      return { ok: true, json: async () => ({ status: '1', pois: [] }) }
    }) as Fetcher, { webKey: 'test-key' })
    const r = createRegistry(store, TOOLS, () => now, { amap })
    await r.invoke('navigation.search', { query: '临平', near: '杭州' })
    const search = calls.find(u => u.includes('/v5/place/text'))!
    expect(new URL(search).searchParams.get('region')).toBe('杭州')
    expect(calls.some(u => u.includes('regeo'))).toBe(false) // 不用白查一次当前城市
  })

  // 比完路线说明目的地已经定了，那张"你要去哪个"就翻篇了。
  // 实测它跟路线卡并排挂着，两张 1/2 把桌面占满，导航卡再来就没地方了
  it('比完路线也算目的地定了，候选卡撤掉', async () => {
    const desk = createDesk()
    const r = createRegistry(store, TOOLS, () => now, {
      desk,
      amap: fakeAmap({
        '/v5/place/text': { status: '1', pois: [
          { id: 'B1', name: '甲', address: 'a', location: '104.07,30.65' },
          { id: 'B2', name: '乙', address: 'b', location: '104.08,30.66' },
        ] },
        '/v5/place/detail': { status: '1', pois: [{ id: 'B1', name: '甲', address: 'a', location: '104.07,30.65' }] },
        '/v5/direction/driving': { status: '1', route: { paths: [
          { distance: '9000', cost: { duration: '1200', tolls: '2' }, steps: [] },
          { distance: '9500', cost: { duration: '1300', tolls: '0' }, steps: [] },
        ] } },
      }),
    })
    await r.invoke('navigation.search', { query: 'x' })
    expect(desk.findByKey('candidates')).toBeTruthy()
    await r.invoke('navigation.compareRoutes', { poiId: 'B1' })
    expect(desk.findByKey('candidates')).toBeUndefined()
    expect(desk.findByKey('routes')).toBeTruthy() // 但路线卡自己得留着
  })

  // 但事情办完了就得撤。之前只在设目的地时撤，存常用地址这条路径漏了，
  // 实测那张卡挂了 6 轮不散
  it('存成常用地址也算办完了，候选卡撤掉', async () => {
    const desk = createDesk()
    const r = createRegistry(store, TOOLS, () => now, {
      desk,
      amap: fakeAmap({
        '/v5/place/text': { status: '1', pois: [
          { id: 'B1', name: '甲', address: 'a', location: '104.07,30.65' },
          { id: 'B2', name: '乙', address: 'b', location: '104.08,30.66' },
        ] },
        '/v5/place/detail': { status: '1', pois: [{ id: 'B1', name: '甲', address: 'a', location: '104.07,30.65' }] },
      }),
    })
    await r.invoke('navigation.search', { query: 'x' })
    expect(desk.findByKey('candidates')).toBeTruthy()
    await r.invoke('places.save', { alias: '家', address: 'a', location: '104.07,30.65' })
    expect(desk.findByKey('candidates')).toBeUndefined()
  })

  it('type=bus 时搜公交线路，city 用 near 传', async () => {
    const r = createRegistry(store, TOOLS, () => now, {
      amap: fakeAmap({ '/v3/bus/linename': { status: '1', buslines: [{ id: 'L1', type: '地铁线路', name: '10号线', start_stop: '角门西', end_stop: '首都机场' }] } }),
    })
    const res = await r.invoke('navigation.search', { query: '10号线', type: 'bus', near: '北京' })
    expect(res.status).toBe('ok')
    expect((res.data as any).buslines[0].name).toBe('10号线')
  })

  it('type=bus 但没传 near（城市）：拒绝，高德这个接口本来就要求必填', async () => {
    const r = createRegistry(store, TOOLS, () => now, { amap: fakeAmap({}) })
    const res = await r.invoke('navigation.search', { query: '10号线', type: 'bus' })
    expect(res.status).toBe('rejected')
  })
})

describe('navigation.setDestination', () => {
  it('传 address：地理编码 + 路径规划成功后写入导航状态', async () => {
    const r = createRegistry(store, TOOLS, () => now, {
      amap: fakeAmap({
        '/v3/geocode/geo': { status: '1', geocodes: [{ location: '116.48,39.99', formatted_address: '北京市朝阳区望京', adcode: '110105' }] },
        '/v5/direction/driving': { status: '1', route: { paths: [{ distance: '9000', cost: { duration: '1200' }, steps: [{ instruction: '直行', step_distance: '9000' }] }] } },
      }),
    })
    const res = await r.invoke('navigation.setDestination', { address: '望京' })
    expect(res.status).toBe('ok')
    expect(store.get('navigation.active')).toBe(true)
    expect(store.get('navigation.destination')).toBe('北京市朝阳区望京')
    expect(store.get('navigation.eta')).toBe(20)
    expect(store.get('navigation.distanceRemaining')).toBe(9)
    expect((res.data as any).mapUrl).toContain('/v3/staticmap?')
    expect((res.data as any).mapUrl).toContain('markers=')
    expect(store.get('navigation.destinationLocation')).toBe('116.48,39.99') // 存下来，供 getStatus 以后重建地图
  })

  it('途经点在地图上要有独立标注，不能只标起终点', async () => {
    const r = createRegistry(store, TOOLS, () => now, {
      amap: fakeAmap({
        '/v3/geocode/geo': { status: '1', geocodes: [{ location: '104.1,30.6', formatted_address: '目的地' }] },
        '/v5/direction/driving': { status: '1', route: { paths: [{ distance: '9000', cost: { duration: '1200' }, steps: [] }] } },
      }),
    })
    const res = await r.invoke('navigation.setDestination', {
      address: '目的地', waypoints: ['104.05,30.65', '104.08,30.62'],
    })
    const mapUrl = decodeURIComponent((res.data as any).mapUrl)
    expect(mapUrl).toContain('104.05,30.65') // 途经点 1
    expect(mapUrl).toContain('104.08,30.62') // 途经点 2
    // 起点 A、终点 B、途经点用数字标号区分
    expect(mapUrl).toMatch(/,1:104\.05,30\.65/)
    expect(mapUrl).toMatch(/,2:104\.08,30\.62/)
  })

  it('途经点存进信号，导航卡刷新时地图上依然有标注', async () => {
    const r = createRegistry(store, TOOLS, () => now, {
      amap: fakeAmap({
        '/v3/geocode/geo': { status: '1', geocodes: [{ location: '104.1,30.6', formatted_address: '目的地' }] },
        '/v5/direction/driving': { status: '1', route: { paths: [{ distance: '9000', cost: { duration: '1200' }, steps: [] }] } },
      }),
    })
    await r.invoke('navigation.setDestination', { address: '目的地', waypoints: ['104.05,30.65'] })
    expect(store.get('navigation.waypoints')).toBe('104.05,30.65')
  })

  it('支持途经点：先去 A 再去 B（市场车机的核心能力）', async () => {
    let drivingUrl = ''
    const amap = createAmapClient((async (url: string) => {
      const path = new URL(url).pathname
      if (path === '/v5/direction/driving') drivingUrl = url
      const body = path === '/v3/geocode/geo'
        ? { status: '1', geocodes: [{ location: '104.1,30.6', formatted_address: '目的地', adcode: '510100' }] }
        : { status: '1', route: { paths: [{ distance: '9000', cost: { duration: '1200' }, steps: [] }] } }
      return { ok: true, json: async () => body }
    }) as Fetcher, { webKey: 'k' })
    const r = createRegistry(store, TOOLS, () => now, { amap })
    const res = await r.invoke('navigation.setDestination', { address: '目的地', waypoints: ['104.05,30.65'] })
    expect(res.status).toBe('ok')
    expect(decodeURIComponent(drivingUrl)).toContain('waypoints=104.05,30.65')
  })

  it('自动带上车牌与车型——限行规避不该让用户每次说一遍', async () => {
    let drivingUrl = ''
    const amap = createAmapClient((async (url: string) => {
      const path = new URL(url).pathname
      if (path === '/v5/direction/driving') drivingUrl = url
      const body = path === '/v3/geocode/geo'
        ? { status: '1', geocodes: [{ location: '104.1,30.6', formatted_address: '目的地' }] }
        : { status: '1', route: { paths: [{ distance: '9000', cost: { duration: '1200' }, steps: [] }] } }
      return { ok: true, json: async () => body }
    }) as Fetcher, { webKey: 'k' })
    const r = createRegistry(store, TOOLS, () => now, { amap })
    await r.invoke('navigation.setDestination', { address: '目的地' })
    const url = decodeURIComponent(drivingUrl)
    expect(url).toContain('plate=川A88888')  // 来自 vehicle.plate 信号
    expect(url).toContain('cartype=1')       // vehicle.carType=ev
  })

  it('返回过路费、收费里程、限行、红绿灯——用户关心的账要算清楚', async () => {
    const r = createRegistry(store, TOOLS, () => now, {
      amap: fakeAmap({
        '/v3/geocode/geo': { status: '1', geocodes: [{ location: '104.1,30.6', formatted_address: '目的地' }] },
        '/v5/direction/driving': { status: '1', route: { paths: [{
          distance: '30000', restriction: '0', traffic_lights: '12',
          cost: { duration: '2400', tolls: '25', toll_distance: '20000' }, steps: [],
        }] } },
      }),
    })
    const res = await r.invoke('navigation.setDestination', { address: '目的地' })
    const d = res.data as any
    expect(d.tolls).toBe(25)
    expect(d.tollDistance).toBe(20)
    expect(d.restricted).toBe(false)
    expect(d.trafficLights).toBe(12)
  })

  it('既不传 poiId 也不传 address：拒绝', async () => {
    const r = createRegistry(store, TOOLS, () => now, { amap: fakeAmap({}) })
    const res = await r.invoke('navigation.setDestination', {})
    expect(res.status).toBe('rejected')
  })

  it('地址查不到坐标：unavailable', async () => {
    const r = createRegistry(store, TOOLS, () => now, {
      amap: fakeAmap({ '/v3/geocode/geo': { status: '1', geocodes: [] } }),
    })
    const res = await r.invoke('navigation.setDestination', { address: '火星' })
    expect(res.status).toBe('unavailable')
  })
})

describe('navigation.compareRoutes —— 多方案对比', () => {
  const routesAmap = () => fakeAmap({
    '/v3/geocode/geo': { status: '1', geocodes: [{ location: '104.1,30.6', formatted_address: '目的地' }] },
    '/v5/direction/driving': { status: '1', route: { paths: [
      { distance: '30000', traffic_lights: '10', cost: { duration: '1800', tolls: '25' }, steps: [] },
      { distance: '35000', traffic_lights: '20', cost: { duration: '2400', tolls: '0' }, steps: [] },
    ] } },
  })

  it('给出多条方案，每条带耗时/里程/过路费', async () => {
    const r = createRegistry(store, TOOLS, () => now, { amap: routesAmap() })
    const res = await r.invoke('navigation.compareRoutes', { address: '目的地' })
    expect(res.status).toBe('ok')
    const routes = (res.data as any).routes
    expect(routes).toHaveLength(2)
    expect(routes[0]).toMatchObject({ eta: 30, distance: 30, tolls: 25 })
    expect(routes[1]).toMatchObject({ eta: 40, distance: 35, tolls: 0 })
  })

  it('自动给每条方案打人话标签，方便 Agent 直接念', async () => {
    const r = createRegistry(store, TOOLS, () => now, { amap: routesAmap() })
    const res = await r.invoke('navigation.compareRoutes', { address: '目的地' })
    const labels = (res.data as any).routes.map((x: any) => x.label)
    expect(labels[0]).toContain('最快')
    expect(labels[1]).toContain('免费') // 不花过路费的那条
  })

  it('方案列表自动上屏，供用户对着屏幕语音选', async () => {
    const desk = createDeskForTest()
    const r = createRegistry(store, TOOLS, () => now, { desk, amap: routesAmap() })
    await r.invoke('navigation.compareRoutes', { address: '目的地' })
    const card = desk.findByKey('routes')!
    expect(card).toBeTruthy()
    expect(card.template).toBe('list')
    expect(card.data.items).toHaveLength(2)
  })

  it('选定某条方案后按它的偏好真正设目的地，方案卡撤掉', async () => {
    const desk = createDeskForTest()
    const r = createRegistry(store, TOOLS, () => now, { desk, amap: routesAmap() })
    await r.invoke('navigation.compareRoutes', { address: '目的地' })
    const res = await r.invoke('navigation.setDestination', { address: '目的地', preference: 'avoidToll' })
    expect(res.status).toBe('ok')
    expect(store.get('navigation.active')).toBe(true)
    expect(desk.findByKey('routes')).toBeUndefined()
  })
})

describe('navigation.searchAlong —— 沿途/周边搜索', () => {
  const poiAmap = () => fakeAmap({
    '/v5/place/around': { status: '1', pois: [
      { id: 'P1', name: '国家电网充电站', address: '天府大道', location: '104.07,30.60', distance: '1200' },
      { id: 'P2', name: '特来电充电站', address: '天府三街', location: '104.08,30.61', distance: '2400' },
    ] },
  })

  it('电车默认找充电站，油车默认找加油站——车型决定推荐什么', async () => {
    let seenUrl = ''
    const amap = createAmapClient((async (url: string) => {
      seenUrl = url
      return { ok: true, json: async () => ({ status: '1', pois: [] }) }
    }) as Fetcher, { webKey: 'k' })
    const r = createRegistry(store, TOOLS, () => now, { amap })
    await r.invoke('navigation.searchAlong', {}) // 什么都不传，靠车型推断（默认 ev）
    expect(decodeURIComponent(seenUrl)).toContain('充电站')

    store.setDirect('vehicle.carType', 'fuel')
    await r.invoke('navigation.searchAlong', {})
    expect(decodeURIComponent(seenUrl)).toContain('加油站')
  })

  it('导航中沿路线找，不是绕着车打转', async () => {
    store.setDirect('navigation.active', true)
    store.setDirect('navigation.routePolyline', '104.07,30.60;104.09,30.62;104.11,30.64')
    let seenUrl = ''
    const amap = createAmapClient((async (url: string) => {
      seenUrl = url
      return { ok: true, json: async () => ({ status: '1', pois: [] }) }
    }) as Fetcher, { webKey: 'k' })
    const r = createRegistry(store, TOOLS, () => now, { amap })
    await r.invoke('navigation.searchAlong', { keyword: '服务区' })
    // 搜索中心点应取路线前方的点，而不是当前车位置
    expect(decodeURIComponent(seenUrl)).not.toContain('location=116.397428,39.90923')
  })

  it('可以指定搜索中心——"找周围有饺子馆的充电站"这类复合需求靠它组合出来', async () => {
    let seenUrl = ''
    const amap = createAmapClient((async (url: string) => {
      seenUrl = url
      return { ok: true, json: async () => ({ status: '1', pois: [] }) }
    }) as Fetcher, { webKey: 'k' })
    const r = createRegistry(store, TOOLS, () => now, { amap })
    // 第一步拿到充电站坐标后，Agent 应能以该坐标为中心再搜一次
    const res = await r.invoke('navigation.searchAlong', { keyword: '饺子', near: '104.07,30.60' })
    expect(res.status).toBe('ok')
    expect(decodeURIComponent(seenUrl)).toContain('location=104.07,30.60')
  })

  it('指定中心时可以缩小半径——"周围"是步行距离，不是五公里', async () => {
    let seenUrl = ''
    const amap = createAmapClient((async (url: string) => {
      seenUrl = url
      return { ok: true, json: async () => ({ status: '1', pois: [] }) }
    }) as Fetcher, { webKey: 'k' })
    const r = createRegistry(store, TOOLS, () => now, { amap })
    await r.invoke('navigation.searchAlong', { keyword: '饺子', near: '104.07,30.60', radius: 800 })
    expect(decodeURIComponent(seenUrl)).toContain('radius=800')
  })

  it('结果自动上屏，带距离', async () => {
    const desk = createDeskForTest()
    const r = createRegistry(store, TOOLS, () => now, { desk, amap: poiAmap() })
    const res = await r.invoke('navigation.searchAlong', { keyword: '充电站' })
    expect(res.status).toBe('ok')
    expect((res.data as any).pois).toHaveLength(2)
    const card = desk.findByKey('along')!
    expect(card).toBeTruthy()
    expect(card.data.items[0].sub).toContain('1.2') // 1200米 → 1.2公里
  })

  it('搜到的地点可以直接设成途经点——"顺路充个电"闭环', async () => {
    const r = createRegistry(store, TOOLS, () => now, { amap: poiAmap() })
    const res = await r.invoke('navigation.searchAlong', { keyword: '充电站' })
    const first = (res.data as any).pois[0]
    expect(first.location).toBe('104.07,30.60') // 有坐标才能当途经点传回 setDestination
  })
})

describe('region.districts —— 周边区县查询', () => {
  it('列出成都下辖区县，供"附近哪个县在下雨"这类需求逐个查', async () => {
    const r = createRegistry(store, TOOLS, () => now, {
      amap: fakeAmap({
        '/v3/config/district': { status: '1', districts: [{
          name: '成都市', level: 'city', districts: [
            { name: '双流区', adcode: '510116', level: 'district', center: '103.92,30.57' },
            { name: '都江堰市', adcode: '510181', level: 'district', center: '103.62,30.99' },
          ],
        }] },
      }),
    })
    const res = await r.invoke('region.districts', { area: '成都' })
    expect(res.status).toBe('ok')
    expect((res.data as any).districts).toHaveLength(2)
    expect((res.data as any).districts[0].name).toBe('双流区')
  })

  it('不传 area 时用当前城市——用户说"附近"时不用他报地名', async () => {
    let seen = ''
    const amap = createAmapClient((async (url: string) => {
      seen = url
      const p = new URL(url).pathname
      const body = p === '/v3/geocode/regeo'
        ? { status: '1', regeocode: { addressComponent: { city: '成都市' } } }
        : { status: '1', districts: [] }
      return { ok: true, json: async () => body }
    }) as Fetcher, { webKey: 'k' })
    const r = createRegistry(store, TOOLS, () => now, { amap })
    const res = await r.invoke('region.districts', {})
    expect(res.status).toBe('ok')
    expect(decodeURIComponent(seen)).toContain('keywords=成都市')
  })
})

describe('多出行方式与常用地址', () => {
  it('setDestination 支持 mode=walking，走步行接口', async () => {
    let seenPath = ''
    const amap = createAmapClient((async (url: string) => {
      const p = new URL(url).pathname
      if (p.startsWith('/v5/direction')) seenPath = p
      const body = p === '/v3/geocode/geo'
        ? { status: '1', geocodes: [{ location: '104.1,30.6', formatted_address: '目的地' }] }
        : { status: '1', route: { paths: [{ distance: '800', cost: { duration: '600' }, steps: [] }] } }
      return { ok: true, json: async () => body }
    }) as Fetcher, { webKey: 'k' })
    const r = createRegistry(store, TOOLS, () => now, { amap })
    const res = await r.invoke('navigation.setDestination', { address: '目的地', mode: 'walking' })
    expect(res.status).toBe('ok')
    expect(seenPath).toBe('/v5/direction/walking')
  })

  it('places.save 存常用地址，places.list 读回来', async () => {
    const r = createRegistry(store, TOOLS, () => now)
    const saved = await r.invoke('places.save', { alias: '家', address: '成都市天府三街', location: '104.06,30.57' })
    expect(saved.status).toBe('ok')
    const listed = await r.invoke('places.list', {})
    expect((listed.data as any).places).toEqual([
      { alias: '家', address: '成都市天府三街', location: '104.06,30.57' },
    ])
  })

  it('setDestination 直接用别名导航——"回家"不用每次搜', async () => {
    let drivingUrl = ''
    const amap = createAmapClient((async (url: string) => {
      if (new URL(url).pathname === '/v5/direction/driving') drivingUrl = url
      return { ok: true, json: async () => ({ status: '1', route: { paths: [{ distance: '5000', cost: { duration: '900' }, steps: [] }] } }) }
    }) as Fetcher, { webKey: 'k' })
    const r = createRegistry(store, TOOLS, () => now, { amap })
    await r.invoke('places.save', { alias: '家', address: '成都市天府三街', location: '104.06,30.57' })
    const res = await r.invoke('navigation.setDestination', { alias: '家' })
    expect(res.status).toBe('ok')
    expect(store.get('navigation.destination')).toBe('家')
    // 用存下来的坐标直接算路，不再走一次地理编码
    expect(decodeURIComponent(drivingUrl)).toContain('destination=104.06,30.57')
  })

  it('别名不存在时明确告知，不瞎猜', async () => {
    const r = createRegistry(store, TOOLS, () => now, { amap: fakeAmap({}) })
    const res = await r.invoke('navigation.setDestination', { alias: '老家' })
    expect(res.status).toBe('unavailable')
    expect(res.code).toBe('PLACE_NOT_FOUND')
  })
})

describe('navigation.control', () => {
  it('没有目的地时 start 被拒', async () => {
    const r = createRegistry(store, TOOLS, () => now, { amap: fakeAmap({}) })
    const res = await r.invoke('navigation.control', { action: 'start' })
    expect(res.status).toBe('rejected')
  })

  it('cancel 清空导航状态', async () => {
    store.setDirect('navigation.active', true)
    store.setDirect('navigation.destination', '望京')
    store.setDirect('navigation.eta', 20)
    store.setDirect('navigation.destinationLocation', '116.48,39.99')
    const r = createRegistry(store, TOOLS, () => now, { amap: fakeAmap({}) })
    const res = await r.invoke('navigation.control', { action: 'cancel' })
    expect(res.status).toBe('ok')
    expect(store.get('navigation.active')).toBe(false)
    expect(store.get('navigation.destination')).toBe('')
    expect(store.get('navigation.destinationLocation')).toBe('')
  })

  it('pause 只暂停，不清空目的地', async () => {
    store.setDirect('navigation.active', true)
    store.setDirect('navigation.destination', '望京')
    const r = createRegistry(store, TOOLS, () => now, { amap: fakeAmap({}) })
    await r.invoke('navigation.control', { action: 'pause' })
    expect(store.get('navigation.active')).toBe(false)
    expect(store.get('navigation.destination')).toBe('望京')
  })
})

describe('navigation.getStatus', () => {
  it('读取当前导航状态', async () => {
    store.setDirect('navigation.active', true)
    store.setDirect('navigation.destination', '望京')
    store.setDirect('navigation.eta', 20)
    store.setDirect('navigation.distanceRemaining', 9)
    const r = createRegistry(store, TOOLS, () => now, { amap: fakeAmap({}) })
    const res = await r.invoke('navigation.getStatus', {})
    expect(res.status).toBe('ok')
    expect((res.data as any).destination).toBe('望京')
    expect((res.data as any).eta).toBe(20)
    expect((res.data as any).distance).toBe(9) // 跟 setDestination 的字段名对齐，两边共用同一张 nav 卡
  })

  it('导航中时顺带查实时路况', async () => {
    store.setDirect('navigation.active', true)
    store.setDirect('navigation.destination', '望京')
    const r = createRegistry(store, TOOLS, () => now, {
      amap: fakeAmap({ '/v3/traffic/status/circle': { status: '1', trafficinfo: { status: '2', expedite: '30', congested: '50', blocked: '20' } } }),
    })
    const res = await r.invoke('navigation.getStatus', {})
    expect(res.status).toBe('ok')
    expect((res.data as any).traffic.status).toBe('slow')
  })

  it('查路况失败不拖累整体状态查询——路况是锦上添花，不是核心', async () => {
    store.setDirect('navigation.active', true)
    store.setDirect('navigation.destination', '望京')
    const r = createRegistry(store, TOOLS, () => now, { amap: fakeAmap({}) }) // 没配路况的假响应，会抛错
    const res = await r.invoke('navigation.getStatus', {})
    expect(res.status).toBe('ok')
    expect((res.data as any).traffic).toBeUndefined()
  })

  it('导航中且有目的地坐标时，getStatus 也能重建地图（不是只有 setDestination 那一下才有图）', async () => {
    store.setDirect('navigation.active', true)
    store.setDirect('navigation.destination', '望京')
    store.setDirect('navigation.destinationLocation', '116.48,39.99')
    const r = createRegistry(store, TOOLS, () => now, { amap: fakeAmap({}) })
    const res = await r.invoke('navigation.getStatus', {})
    expect(res.status).toBe('ok')
    expect((res.data as any).mapUrl).toContain('/v3/staticmap?')
  })

  it('没有目的地坐标时不生成 mapUrl，不报错', async () => {
    store.setDirect('navigation.active', true)
    store.setDirect('navigation.destination', '望京')
    const r = createRegistry(store, TOOLS, () => now, { amap: fakeAmap({}) })
    const res = await r.invoke('navigation.getStatus', {})
    expect(res.status).toBe('ok')
    expect((res.data as any).mapUrl).toBeUndefined()
  })

  it('amap 完全没装配时依然返回 ok，只是没有 traffic/mapUrl 这些附加字段', async () => {
    store.setDirect('navigation.active', true)
    store.setDirect('navigation.destination', '望京')
    store.setDirect('navigation.destinationLocation', '116.48,39.99')
    const r = createRegistry(store, TOOLS, () => now) // 完全不传 amap
    const res = await r.invoke('navigation.getStatus', {})
    expect(res.status).toBe('ok')
    expect((res.data as any).mapUrl).toBeUndefined()
    expect((res.data as any).traffic).toBeUndefined()
  })

  it('没有导航中就不查路况（省一次不必要的网络请求）', async () => {
    store.setDirect('navigation.active', false)
    const r = createRegistry(store, TOOLS, () => now, { amap: fakeAmap({}) })
    const res = await r.invoke('navigation.getStatus', {})
    expect(res.status).toBe('ok')
    expect((res.data as any).traffic).toBeUndefined()
  })
})

describe('weather.query', () => {
  it('查到城市天气，实况与预报都给', async () => {
    // weatherInfo 被调两次（base 和 all），假 fetch 按路径分发，一个响应体里同时给两种字段即可
    const r = createRegistry(store, TOOLS, () => now, {
      amap: fakeAmap({
        '/v3/geocode/geo': { status: '1', geocodes: [{ location: '116.4,39.9', formatted_address: '北京市', adcode: '110000' }] },
        '/v3/weather/weatherInfo': {
          status: '1',
          lives: [{ city: '北京市', weather: '晴', temperature: '25', winddirection: '北', windpower: '3', humidity: '40', reporttime: '2026-08-10 12:00' }],
          forecasts: [{ casts: [{ date: '2026-08-11', dayweather: '多云', nightweather: '晴', daytemp: '30', nighttemp: '20' }] }],
        },
      }),
    })
    const res = await r.invoke('weather.query', { location: '北京' })
    expect(res.status).toBe('ok')
    expect((res.data as any).now.weather).toBe('晴')
    expect((res.data as any).forecast[0].dayWeather).toBe('多云')
  })

  it('查不到这个地方：unavailable', async () => {
    const r = createRegistry(store, TOOLS, () => now, {
      amap: fakeAmap({ '/v3/geocode/geo': { status: '1', geocodes: [] } }),
    })
    const res = await r.invoke('weather.query', { location: '火星' })
    expect(res.status).toBe('unavailable')
  })
})

/* ────────────────────────── 查询结果自动上屏：显示是机制，不指望模型自觉 ────────────────────────── */
describe('查询/交互结果自动上屏', () => {
  const mkDesk = async () => createDeskForTest()

  it('weather.query 成功 → 天气卡自动上屏', async () => {
    const desk = await mkDesk()
    const r = createRegistry(store, TOOLS, () => now, {
      desk,
      amap: fakeAmap({
        '/v3/geocode/geo': { status: '1', geocodes: [{ location: '104.06,30.65', formatted_address: '成都市', adcode: '510100' }] },
        '/v3/weather/weatherInfo': {
          status: '1',
          lives: [{ city: '成都市', weather: '晴', temperature: '30', winddirection: '东', windpower: '3', humidity: '50', reporttime: 't' }],
          forecasts: [{ casts: [{ date: '2026-08-11', dayweather: '晴', nightweather: '晴', daytemp: '33', nighttemp: '24' }] }],
        },
      }),
    })
    await r.invoke('weather.query', { location: '成都' })
    const card = desk.layout().cards.find(c => c.template === 'weather')!
    expect(card).toBeTruthy()
    expect(card.template).toBe('weather')
    expect(card.data.now.weather).toBe('晴')
    expect(card.data.title).toContain('成都')
  })

  // "找周边最凉快的县城"会并行查一串地方，key 写死会让后一个盖掉前一个——
  // 用户听到的是七个地方的对比，屏幕上只剩最后那个
  it('查多个地方 → 一地一张卡，不互相覆盖', async () => {
    const desk = await mkDesk()
    const live = (city: string, temp: string) => ({
      status: '1',
      lives: [{ city, weather: '晴', temperature: temp, winddirection: '东', windpower: '3', humidity: '50', reporttime: 't' }],
      forecasts: [{ casts: [{ date: '2026-08-11', dayweather: '晴', nightweather: '晴', daytemp: temp, nighttemp: '24' }] }],
    })
    let geo = 0, wx = 0
    const r = createRegistry(store, TOOLS, () => now, {
      desk,
      amap: fakeAmap({
        '/v3/geocode/geo': () => ({ status: '1', geocodes: [
          { location: '1,1', formatted_address: ['延庆区', '怀柔区'][geo], adcode: ['110119', '110116'][geo++] },
        ] }),
        '/v3/weather/weatherInfo': () => live(['延庆区', '怀柔区'][Math.floor(wx++ / 2)], '25'),
      }),
    })
    // 家族语义（2026-08-12）：**同一轮**的并行查询并存——runtime 给同批调用
    // 同一个 round。没带轮次的直调每次自成一批（顺序替换）
    await r.invoke('weather.query', { location: '延庆' }, { round: 3 })
    await r.invoke('weather.query', { location: '怀柔' }, { round: 3 })
    const titles = desk.layout().cards.filter(c => c.template === 'weather').map(c => c.data.title)
    expect(titles).toHaveLength(2)
    expect(titles.join()).toContain('延庆')
    expect(titles.join()).toContain('怀柔')
  })

  // 顺序单查是另一种意图：新一轮替换旧批——问完成都问北京，屏上不该堆两张
  it('顺序两轮查询 → 后一城替换前一城', async () => {
    const desk = await mkDesk()
    let geo = 0
    const r = createRegistry(store, TOOLS, () => now, {
      desk,
      amap: fakeAmap({
        '/v3/geocode/geo': () => ({ status: '1', geocodes: [
          { location: '1,1', formatted_address: ['成都市', '北京市'][geo], adcode: ['510100', '110000'][geo++] },
        ] }),
        '/v3/weather/weatherInfo': () => ({ status: '1',
          lives: [{ city: 'x', weather: '晴', temperature: '30', winddirection: '东', windpower: '3', humidity: '50', reporttime: 't' }],
          forecasts: [{ casts: [] }] }),
      }),
    })
    await r.invoke('weather.query', { location: '成都' }, { round: 1 })
    await r.invoke('weather.query', { location: '北京' }, { round: 2 })
    const titles = desk.layout().cards.filter(c => c.template === 'weather').map(c => c.data.title)
    expect(titles).toHaveLength(1)
    expect(titles[0]).toContain('北京')
  })

  /**
   * 实测：Agent 想查"当前位置天气"时会把坐标串当地名传进来，
   * 而 geocode 是"地名→坐标"，拿 104.065861,30.657401 去搜就命中了
   * 内蒙古某个叫"一零四"的地方，卡片标题成了"阿拉善左旗一零四天气"。
   * 坐标要走 regeo（逆地理编码）。
   */
  it('传坐标查天气时走逆地理编码，不能当地名搜', async () => {
    const calls: string[] = []
    const amap = createAmapClient((async (url: string) => {
      calls.push(new URL(url).pathname)
      const p = new URL(url).pathname
      const body = p === '/v3/geocode/regeo'
        ? { status: '1', regeocode: { addressComponent: { city: '成都市', province: '四川省', adcode: '510100' } } }
        : { status: '1', lives: [{ city: '成都市', weather: '中雨', temperature: '18', winddirection: '东',
            windpower: '3', humidity: '80', reporttime: 't' }],
            forecasts: [{ casts: [{ date: '2026-08-12', dayweather: '中雨', nightweather: '小雨', daytemp: '20', nighttemp: '17' }] }] }
      return { ok: true, json: async () => body }
    }) as Fetcher, { webKey: 'test-key' })
    const r = createRegistry(store, TOOLS, () => now, { amap })
    const res = await r.invoke('weather.query', { location: '104.065861,30.657401' })
    expect(res.status).toBe('ok')
    expect(calls).toContain('/v3/geocode/regeo')
    expect(calls).not.toContain('/v3/geocode/geo')   // 绝不能走正向地理编码
    expect((res.data as any).city).toContain('成都')
  })

  it('传地名时照常走正向地理编码', async () => {
    const calls: string[] = []
    const amap = createAmapClient((async (url: string) => {
      calls.push(new URL(url).pathname)
      const p = new URL(url).pathname
      const body = p === '/v3/geocode/geo'
        ? { status: '1', geocodes: [{ location: '104.06,30.65', formatted_address: '乐山市', adcode: '511100' }] }
        : { status: '1', lives: [{ city: '乐山市', weather: '多云', temperature: '30', winddirection: '东',
            windpower: '2', humidity: '60', reporttime: 't' }], forecasts: [{ casts: [] }] }
      return { ok: true, json: async () => body }
    }) as Fetcher, { webKey: 'test-key' })
    const r = createRegistry(store, TOOLS, () => now, { amap })
    await r.invoke('weather.query', { location: '乐山' })
    expect(calls).toContain('/v3/geocode/geo')
  })

  // full 走覆盖层盖住整个桌面——"你会什么"是内容不是告警，用普通卡片（用户点名）
  it('capability.list 成功 → 能力目录卡上桌面，不上覆盖层', async () => {
    const desk = await mkDesk()
    const r = createRegistry(store, TOOLS, () => now, { desk })
    await r.invoke('capability.list', {})
    const card = desk.findByKey('capabilities')!
    expect(card).toBeTruthy()
    expect(card.template).toBe('capability')
    expect(card.size).not.toBe('full')
    expect(card.data.items.length).toBeGreaterThan(0)
  })

  it('voice.ask → 问题与选项自动出确认卡', async () => {
    const desk = await mkDesk()
    const r = createRegistry(store, TOOLS, () => now, { desk })
    await r.invoke('voice.ask', { question: '你要去哪个？', options: ['步行街', '地铁站'] })
    const card = desk.findByKey('ask')!
    expect(card).toBeTruthy()
    expect(card.template).toBe('confirm')
    expect(card.data.question).toBe('你要去哪个？')
    expect(card.data.options).toEqual(['步行街', '地铁站'])
  })

  // 模型的问句往往是一整段（"春熙路有好几个，你说去哪个？第一个是…第二个是…"），
  // 拿它当卡片标题会挤掉下面的列表，而且选项在列表里已经有了
  it('voice.ask 时桌面已有候选列表卡 → 什么都不动，屏幕上已经在展示候选了', async () => {
    const desk = await mkDesk()
    const r = createRegistry(store, TOOLS, () => now, {
      desk,
      amap: fakeAmap({ '/v5/place/text': { status: '1', pois: [
        { id: 'B1', name: '甲', address: 'a', location: '1,1' },
        { id: 'B2', name: '乙', address: 'b', location: '2,2' },
      ] } }),
    })
    await r.invoke('navigation.search', { query: 'x' })
    await r.invoke('voice.ask', { question: '春熙路有好几个，你说去哪个？第一个是步行街，第二个是地铁站。', options: ['甲', '乙'] })
    expect(desk.findByKey('ask')).toBeUndefined() // 不开第二张
    expect(desk.findByKey('candidates')!.data.title).toBe('你要去哪个？') // 列表卡自己的短标题，没被长问句覆盖
  })

  it('灰级 MRTR 拦截 → 确认卡自动上屏，带确认问句', async () => {
    const desk = await mkDesk()
    const r = createRegistry(store, TOOLS, () => now, { desk })
    const first = await r.invoke('door.set', { door: 'driver', action: 'open' })
    expect(first.status).toBe('inputRequired')
    const card = desk.findByKey('confirm')!
    expect(card).toBeTruthy()
    expect(card.template).toBe('confirm')
    expect(card.data.question).toContain('车门')
  })

  // 实测：行驶中要求开门，MRTR 弹了确认卡，但 Agent 判断"太危险"直接拒绝了，
  // 于是语音在说"停稳了再说"、屏幕在问"确认吗"。这张卡成了孤儿，还挂了两轮
  it('用户下一句一开口，没走完的确认卡就散了', async () => {
    const desk = await mkDesk()
    const r = createRegistry(store, TOOLS, () => now, { desk })
    await r.invoke('door.set', { door: 'driver', action: 'open' })
    expect(desk.findByKey('confirm')).toBeTruthy()
    desk.endTask()
    expect(desk.findByKey('confirm')).toBeUndefined()
  })

  it('带 token 确认执行成功 → 确认卡自动撤掉', async () => {
    const desk = await mkDesk()
    const r = createRegistry(store, TOOLS, () => now, { desk })
    const first = await r.invoke('door.set', { door: 'driver', action: 'open' })
    expect(desk.findByKey('confirm')).toBeTruthy()
    const second = await r.invoke('door.set', { door: 'driver', action: 'open' }, { confirmToken: first.token })
    expect(second.status).toBe('ok')
    expect(desk.findByKey('confirm')).toBeUndefined()
  })

  it('没装配 desk 时这些 Tool 照常工作，只是不显示', async () => {
    const r = createRegistry(store, TOOLS, () => now)
    const res = await r.invoke('voice.ask', { question: 'q', options: [] })
    expect(res.status).toBe('ok')
  })
})

/* ────────────────────────── 契约完整性 ────────────────────────── */
describe('Tool 契约完整性', () => {
  it('每个暴露的 Tool 都有非空 description（模型选型依据）', async () => {
    for (const t of reg.list()) expect(t.desc, `${t.name} 缺少 desc`).toBeTruthy()
  })

  it('每个 Tool 都声明了 permission', async () => {
    for (const t of TOOLS) expect(t.permission, `${t.name} 缺少 permission`).toBeTruthy()
  })
})

/**
 * 雨刷。暴雨场景里用户一定会提，而真车这是基础能力——
 * 之前一直没有，属于 L1 车控的遗漏
 */
describe('wiper.set', () => {
  it('按档位设置', async () => {
    const r = await reg.invoke('wiper.set', { mode: 'high' })
    expect(r.status).toBe('ok')
    expect(store.get('cabin.wiper.mode')).toBe('high')
  })

  it('自动感应雨量也是一档', async () => {
    await reg.invoke('wiper.set', { mode: 'auto' })
    expect(store.get('cabin.wiper.mode')).toBe('auto')
  })

  it('不认识的档位被拒', async () => {
    expect((await reg.invoke('wiper.set', { mode: 'turbo' })).code).toBe('INVALID_PARAMS')
  })
})

/**
 * ══════════ 权限与确认的边界（2026-08-14 代码审查） ══════════
 */
describe('黑名单闸必须认动态权限', () => {
  /**
   * invoke 先用**静态** t.permission 判黑、后用**动态** permissionOf() 判灰：
   * 一个 escalate 到 '黑' 的工具（类型完全允许，语义即"行驶中彻底禁用"）
   * 静态等级不是黑 → 过黑闸；动态结果是黑而不是灰 → 也过灰闸，
   * 最该被禁的状态下反而免确认直接执行。当前配置只用到 to:'灰' 所以没引爆，
   * 但这是权限机制层的次序漏洞，加一条数据就触发——正撞上"加能力=加数据"。
   */
  it('escalate 升到黑的工具，在升级条件成立时被拒（不是免确认执行）', async () => {
    const store = createStore(SIGNALS, CONSTRAINTS)
    const tools = [{
      name: 'test.blackOnMove', desc: 't', permission: '彩' as const, brief: 't',
      params: { v: { type: 'number' as const, desc: 'v' } },
      writes: [{ path: 'cabin.ambientLight.brightness', from: 'v' }],
      escalate: [{ when: ['vehicle.speed', '>', 5] as [string, any, any], to: '黑' as const }],
    }]
    const r = createRegistry(store, tools as any)
    store.setDirect('vehicle.speed', 0)
    expect((await r.invoke('test.blackOnMove', { v: 50 })).status, '静止时照常执行').toBe('ok')
    store.setDirect('vehicle.speed', 60)
    const moving = await r.invoke('test.blackOnMove', { v: 80 })
    expect(moving.status, '行驶中该被彻底拒绝').toBe('rejected')
    expect(moving.code).toBe('FORBIDDEN')
  })
})

describe('MRTR 确认令牌的生命周期', () => {
  /**
   * token 只在成功消费时 delete，过期条目永不清理：Map 在长会话下无界增长，
   * pendingConfirm 每次全量扫描。更直接的用户可见后果是——用户触发确认后
   * 说"算了"，那个未过期的 token 会继续劫持输入路由满 60 秒
   * （pipeline 见到 pending 就跳过快层直送慢层），快层的秒回能力凭空消失一分钟。
   */
  it('过期的 token 会被清掉，不再劫持输入路由', async () => {
    const store = createStore(SIGNALS, CONSTRAINTS)
    let now = 1000
    const r = createRegistry(store, TOOLS, () => now)
    const first = await r.invoke('door.set', { door: 'driver', action: 'open' })
    expect(first.status).toBe('inputRequired')
    expect(r.pendingConfirm(), '确认挂着').toBeTruthy()
    now += 61_000                                   // 过了 TTL
    expect(r.pendingConfirm(), '过期后不再算 pending').toBeFalsy()
  })

  it('用户放弃的确认可以显式作废，不用干等 60 秒', async () => {
    const store = createStore(SIGNALS, CONSTRAINTS)
    const r = createRegistry(store, TOOLS)
    await r.invoke('door.set', { door: 'driver', action: 'open' })
    expect(r.pendingConfirm()).toBeTruthy()
    r.clearConfirms()
    expect(r.pendingConfirm(), '放弃之后立刻不再劫持').toBeFalsy()
  })
})

/**
 * ══════════ 参数默认值：路径占位符的必要配套 ══════════
 *
 * `sunroof.set` 的写入路径是 `cabin.sunroof.{part}.position`。part 不传时
 * 路径会拼成 `cabin.sunroof.undefined.position` —— 而"开天窗"这句话里
 * 用户根本不会说"玻璃还是遮阳帘"，逼模型每次都传是把机制的缺口转嫁给它。
 *
 * `ParamDef.default` 是**数据**：在校验之前把缺省值填进 args，
 * 之后所有环节（校验、展开、写入）都当它是用户传的。
 */
describe('参数默认值', () => {
  it('缺省时按 default 填，路径拼得出来（不再是 undefined）', async () => {
    const st = createStore(SIGNALS.map(x => x.alias.startsWith('cabin.sunroof') ? { ...x, equipped: true } : x), CONSTRAINTS)
    const r = await createRegistry(st, TOOLS, () => now).invoke('sunroof.set', { position: 60 })
    expect(r.status).toBe('ok')
    expect(st.getTarget('cabin.sunroof.glass.position')).toBe(60)
    expect(st.getTarget('cabin.sunroof.shade.position'), '别连坐').toBe(0)
  })

  it('显式传了就听显式的', async () => {
    const st = createStore(SIGNALS.map(x => x.alias.startsWith('cabin.sunroof') ? { ...x, equipped: true } : x), CONSTRAINTS)
    await createRegistry(st, TOOLS, () => now).invoke('sunroof.set', { position: 30, part: 'shade' })
    expect(st.getTarget('cabin.sunroof.shade.position')).toBe(30)
  })

  /** 默认值也要过校验 —— 写错的 default 该在测试里炸，不该悄悄写进信号 */
  it('每个带 default 的参数，默认值都在自己的取值范围内', () => {
    for (const t of TOOLS)
      for (const [k, d] of Object.entries(t.params)) {
        const dv = (d as any).default
        if (dv === undefined) continue
        if (d.values) expect(d.values, `${t.name}.${k}`).toContain(dv)
        if (d.range) {
          expect(dv, `${t.name}.${k}`).toBeGreaterThanOrEqual(d.range[0])
          expect(dv, `${t.name}.${k}`).toBeLessThanOrEqual(d.range[1])
        }
      }
  })
})
