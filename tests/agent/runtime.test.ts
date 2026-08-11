import { describe, it, expect, beforeEach } from 'vitest'
import { createStore } from '../../src/core/store'
import { createRegistry } from '../../src/tools/registry'
import { createAgent } from '../../src/agent/runtime'
import { buildSystemPrompt } from '../../src/agent/context'
import { SIGNALS } from '../../src/config/signals'
import { CONSTRAINTS } from '../../src/config/constraints'
import { TOOLS } from '../../src/config/tools'
import { MAIN_AGENT } from '../../agents/main-agent/manifest'
import type { LLM, LLMReply } from '../../src/agent/llm'

let store: ReturnType<typeof createStore>
let reg: ReturnType<typeof createRegistry>

/** 脚本化假模型：按轮次吐出预设回复，用于脱离网络做 TDD */
function fakeLLM(script: LLMReply[]): LLM & { seen: any[] } {
  let i = 0
  const seen: any[] = []
  return {
    seen,
    async chat(req) { seen.push(req); return script[i++] ?? { text: '(脚本已用尽)' } },
    async models() { return [] },
  }
}

const mkAgent = (llm: LLM, extra: Record<string, unknown> = {}) =>
  createAgent({ manifest: MAIN_AGENT, registry: reg, store, llm, ...extra })

beforeEach(() => {
  store = createStore(SIGNALS, CONSTRAINTS)
  reg = createRegistry(store, TOOLS)
})

/* ────────────────────────── 上下文注入 ────────────────────────── */
describe('上下文注入', () => {
  it('包含车辆状态快照', () => {
    store.setDirect('vehicle.speed', 60)
    const p = buildSystemPrompt(MAIN_AGENT, store, reg)
    expect(p).toContain('车辆状态')
    expect(p).toContain('60')
  })

  it('包含说话人位置，用于指代消解（Golden Case 4）', () => {
    store.setDirect('perception.voiceSource', 'rearLeft')
    expect(buildSystemPrompt(MAIN_AGENT, store, reg)).toContain('左后')
  })

  // 裸英文枚举值（"香型: none"）逼着模型自己现编中文说法，实测编出了枚举里
  // 根本没有的"清香"。中文名是数据，跟着信号定义走
  it('枚举值按信号自带的中文标签注入', () => {
    const p = buildSystemPrompt(MAIN_AGENT, store, reg)
    expect(p).toContain('香型: 无')
    expect(p).not.toContain('香型: none')
  })

  it('没配中文标签的枚举值原样注入', () => {
    store.setDirect('vehicle.carType', 'ev')
    expect(buildSystemPrompt(MAIN_AGENT, store, reg)).toContain('ev')
  })

  it('CONTINUOUS 信号取整注入，不带无意义小数', () => {
    store.setDirect('vehicle.speed', 62.4718)
    const p = buildSystemPrompt(MAIN_AGENT, store, reg)
    expect(p).toContain('62')
    expect(p).not.toContain('62.4718')
  })

  it('未选装能力在提示里被显式标注，降低幻觉概率', () => {
    const p = buildSystemPrompt(MAIN_AGENT, store, reg)
    expect(p).toContain('未配备')
    expect(p).toContain('全景天窗')
  })

  it('绝不泄露「黑」级能力', () => {
    expect(buildSystemPrompt(MAIN_AGENT, store, reg)).not.toContain('brake.apply')
  })

  it('注入桌面布局摘要 —— 无APP化下 Agent 必须知道屏幕上有什么', () => {
    const p = buildSystemPrompt(MAIN_AGENT, store, reg, { desktop: 'Agent 区：车窗(1/6)，剩余 2 格' })
    expect(p).toContain('桌面布局')
    expect(p).toContain('剩余 2 格')
  })

  it('未提供桌面摘要时不注入空段落', () => {
    expect(buildSystemPrompt(MAIN_AGENT, store, reg)).not.toContain('桌面布局')
  })

  it('人设 ≤ 22 行（v1.0 约定：主 Agent 是测试探针不是产品）', () => {
    expect(MAIN_AGENT.persona.trim().split('\n').length).toBeLessThanOrEqual(22)
  })
})

/* ────────────────────────── 执行循环 ────────────────────────── */
describe('执行循环', () => {
  // 实测：用户输入为空时若照样送进模型，模型会凭空发挥（无端开窗、查天气）
  it('空输入不调模型，也不污染会话历史', async () => {
    const llm = fakeLLM([{ text: '不该被调用' }])
    const a = mkAgent(llm)
    const r = await a.run('   ')
    expect(r.stopReason).toBe('empty')
    expect(r.reply).toBe('')
    expect(llm.seen).toHaveLength(0)
    expect(a.history).toHaveLength(0)
  })

  // 上一轮问"你要哪个"，用户这一轮开口就等于回答了（或换了话题），
  // 那张问题卡再挂着就是垃圾
  it('每轮开始时通知外部清理上一轮的临时卡', async () => {
    const cleaned: number[] = []
    const a = mkAgent(fakeLLM([{ text: '好' }]), { onTurnStart: () => cleaned.push(1) })
    await a.run('第一句')
    await a.run('第二句')
    expect(cleaned).toHaveLength(2)
  })

  it('空输入不触发清理——用户根本没说话', async () => {
    const cleaned: number[] = []
    const a = mkAgent(fakeLLM([{ text: '好' }]), { onTurnStart: () => cleaned.push(1) })
    await a.run('  ')
    expect(cleaned).toHaveLength(0)
  })

  it('模型直接回话，不调工具', async () => {
    const a = mkAgent(fakeLLM([{ text: '你好' }]))
    const r = await a.run('你好')
    expect(r.reply).toBe('你好')
    expect(r.trace.filter(s => s.type === 'toolCall')).toHaveLength(0)
  })

  it('调用工具 → 回填结果 → 第二轮出话术（Golden Case 1）', async () => {
    const a = mkAgent(fakeLLM([
      { toolCalls: [{ id: '1', name: 'window.set', args: { window: 'driver', position: 100 } }] },
      { text: '好的，主驾车窗已打开' },
    ]))
    const r = await a.run('打开主驾车窗')
    expect(store.getTarget('cabin.window.driver.position')).toBe(100)
    expect(r.reply).toContain('已打开')
    expect(r.rounds).toBe(2)
  })

  it('同一轮多个工具调用并行执行（Golden Case 3）', async () => {
    const a = mkAgent(fakeLLM([
      { toolCalls: [
        { id: '1', name: 'window.set', args: { window: 'driver', position: 0 } },
        { id: '2', name: 'window.set', args: { window: 'passenger', position: 0 } },
      ] },
      { text: '关好了' },
    ]))
    const r = await a.run('把前排窗户关了')
    expect(r.trace.filter(s => s.type === 'toolResult')).toHaveLength(2)
  })

  it('工具结果以结构化 JSON 回填给模型，含 status 与 message', async () => {
    const llm = fakeLLM([
      { toolCalls: [{ id: '1', name: 'window.set', args: { window: 'driver', position: 50 } }] },
      { text: 'ok' },
    ])
    await mkAgent(llm).run('开一半')
    const second = llm.seen[1]
    const toolMsg = second.messages.find((m: any) => m.role === 'tool')
    expect(toolMsg).toBeTruthy()
    expect(JSON.parse(toolMsg.content).status).toBe('ok')
  })

  it('拒绝结果原样回填，让模型自己组织话术（Golden Case 8）', async () => {
    store.set('cabin.childLock', true)
    const llm = fakeLLM([
      { toolCalls: [{ id: '1', name: 'window.set', args: { window: 'rearLeft', position: 100 } }] },
      { text: '儿童锁开着呢，后排窗户打不开' },
    ])
    const r = await mkAgent(llm).run('把后窗打开')
    const toolMsg = llm.seen[1].messages.find((m: any) => m.role === 'tool')
    const payload = JSON.parse(toolMsg.content)
    expect(payload.status).toBe('rejected')
    expect(payload.code).toBe('CHILD_LOCK_ON')
    expect(payload.suggestion).toBeTruthy()
    expect(r.reply).toContain('儿童锁')
  })

  it('未选装能力回填 unavailable，模型据此坦白（Golden Case 9）', async () => {
    const llm = fakeLLM([
      { toolCalls: [{ id: '1', name: 'sunroof.set', args: { position: 100 } }] },
      { text: '这台车没配天窗' },
    ])
    await mkAgent(llm).run('开天窗')
    const payload = JSON.parse(llm.seen[1].messages.find((m: any) => m.role === 'tool').content)
    expect(payload.status).toBe('unavailable')
    expect(payload.code).toBe('NOT_EQUIPPED')
  })

  it('超过最大轮次时终止，不无限循环', async () => {
    const loop = { toolCalls: [{ id: 'x', name: 'vehicle.getState', args: {} }] }
    const a = mkAgent(fakeLLM(Array(20).fill(loop)))
    const r = await a.run('查状态')
    expect(r.rounds).toBeLessThanOrEqual(6)
    expect(r.stopReason).toBe('maxRounds')
  })

  // 实测模型把 6 轮全用在工具调用上，用户说了话助手一声不吭。
  // 语音场景下没有"静默"这个选项——最后一轮不给工具，逼它出话
  it('最后一轮不给工具，保证用户至少听到一句', async () => {
    const loop = { toolCalls: [{ id: 'x', name: 'vehicle.getState', args: {} }] }
    const llm = fakeLLM([...Array(5).fill(loop), { text: '查完了，都正常' }])
    const r = await mkAgent(llm).run('查状态')
    expect(r.reply).toBe('查完了，都正常')
    expect(llm.seen.at(-1)!.tools).toHaveLength(0)
  })

  it('能力授权：manifest 白名单外的调用被拒', async () => {
    const limited = createAgent({
      manifest: { ...MAIN_AGENT, tools: ['vehicle.getState'] },
      registry: reg, store, llm: fakeLLM([
        { toolCalls: [{ id: '1', name: 'window.set', args: { window: 'driver', position: 50 } }] },
        { text: '我没这个权限' },
      ]),
    })
    await limited.run('开窗')
    expect(store.getTarget('cabin.window.driver.position')).toBe(0)
  })

  it('只把授权范围内的 schema 交给模型', async () => {
    const llm = fakeLLM([{ text: 'ok' }])
    await createAgent({
      manifest: { ...MAIN_AGENT, tools: ['window.*'] }, registry: reg, store, llm,
    }).run('hi')
    const names = llm.seen[0].tools.map((t: any) => t.function.name)
    expect(names).toEqual(['window_set'])
  })
})

/* ────────────────────────── MRTR 确认流 ────────────────────────── */
describe('二次确认 · 端到端', () => {
  it('灰级工具首次调用回填 CONFIRM_REQUIRED，且未执行', async () => {
    const llm = fakeLLM([
      { toolCalls: [{ id: '1', name: 'door.set', args: { door: 'driver', action: 'open' } }] },
      { text: '要打开车门吗？' },
    ])
    await mkAgent(llm).run('开门')
    const payload = JSON.parse(llm.seen[1].messages.find((m: any) => m.role === 'tool').content)
    expect(payload.status).toBe('inputRequired')
    expect(payload.token).toBeTruthy()
    expect(store.getTarget('cabin.door.driver.isOpen')).toBe(false)
  })

  it('模型带 confirmToken 重调后真正执行', async () => {
    const a = mkAgent(fakeLLM([
      { toolCalls: [{ id: '1', name: 'door.set', args: { door: 'driver', action: 'open' } }] },
      { text: '要打开车门吗？' },
    ]))
    const first = await a.run('开门')
    const token = (first.trace.find(s => s.type === 'toolResult') as any).result.token

    const a2 = createAgent({
      manifest: MAIN_AGENT, registry: reg, store,
      llm: fakeLLM([
        { toolCalls: [{ id: '2', name: 'door.set', args: { door: 'driver', action: 'open', confirmToken: token } }] },
        { text: '车门打开了' },
      ]),
    })
    await a2.run('确认')
    expect(store.getTarget('cabin.door.driver.isOpen')).toBe(true)
  })

  it('灰级工具的 schema 里必须带 confirmToken 参数', () => {
    const s = reg.schemas('openai').find(x => x.function.name === 'door_set')!
    expect(s.function.properties ?? s.function.parameters.properties).toHaveProperty('confirmToken')
  })
})

/* ────────────────────────── 可观测 ────────────────────────── */
describe('全链路追踪', () => {
  it('trace 按顺序记录 prompt / toolCall / toolResult / reply', async () => {
    const a = mkAgent(fakeLLM([
      { toolCalls: [{ id: '1', name: 'window.set', args: { window: 'driver', position: 30 } }] },
      { text: '开好了' },
    ]))
    const r = await a.run('开窗')
    // 每一轮都记一次 prompt —— 这正是可观测面板要展示的"第二轮看到了什么"
    expect(r.trace.map(s => s.type)).toEqual(
      ['userInput', 'prompt', 'toolCall', 'toolResult', 'prompt', 'reply'])
  })

  it('trace 里记录了每个 Tool 的权限等级', async () => {
    const a = mkAgent(fakeLLM([
      { toolCalls: [{ id: '1', name: 'window.set', args: { window: 'driver', position: 30 } }] },
      { text: 'ok' },
    ]))
    const r = await a.run('开窗')
    const call = r.trace.find(s => s.type === 'toolCall') as any
    expect(call.permission).toBe('彩')
  })

  it('每步带耗时', async () => {
    const a = mkAgent(fakeLLM([{ text: 'ok' }]))
    const r = await a.run('hi')
    expect(r.trace.every(s => typeof s.at === 'number')).toBe(true)
  })

  it('对外广播事件供 UI 订阅', async () => {
    const events: string[] = []
    const a = mkAgent(fakeLLM([
      { toolCalls: [{ id: '1', name: 'window.set', args: { window: 'driver', position: 30 } }] },
      { text: 'ok' },
    ]))
    a.on(e => events.push(e.type))
    await a.run('开窗')
    expect(events).toContain('thinking')
    expect(events).toContain('executing')
    expect(events).toContain('speaking')
    expect(events).toContain('done')
  })
})
