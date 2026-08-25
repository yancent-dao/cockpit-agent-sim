import { describe, it, expect, beforeEach } from 'vitest'
import { createStore } from '../../src/core/store'
import { createRegistry } from '../../src/tools/registry'
import { createPipeline, type PipelineEvent } from '../../src/agent/pipeline'
import { SIGNALS } from '../../src/config/signals'
import { CONSTRAINTS } from '../../src/config/constraints'
import { TOOLS } from '../../src/config/tools'
import { MAIN_AGENT } from '../../agents/main-agent/manifest'
import { FAST_AGENT } from '../../agents/main-agent/fast'
import type { LLM, LLMRequest, LLMReply } from '../../src/agent/llm'

/**
 * 过滤器架构（设计文档 §2-§4）：快层小模型先斩（只挂 fast 工具面），
 * 一律转交慢层——校验、接力、静默判断。共享同一份 thread。
 */

/** 可编程假模型：每次 chat 依次消费一个 responder，可以是延迟的 */
function fakeLLM(...responders: Array<(req: LLMRequest) => LLMReply | Promise<LLMReply>>) {
  const seen: LLMRequest[] = []
  let i = 0
  return {
    seen,
    async chat(req: LLMRequest) {
      seen.push(req)
      const r = responders[i++] ?? (() => ({ text: '' }))
      return r(req)
    },
    async models() { return [] },
  } as LLM & { seen: LLMRequest[] }
}

const call = (name: string, args: any, id = 'c' + Math.random().toString(36).slice(2, 6)) =>
  ({ id, name, args })

let store: ReturnType<typeof createStore>
let reg: ReturnType<typeof createRegistry>

beforeEach(() => {
  store = createStore(SIGNALS, CONSTRAINTS)
  reg = createRegistry(store, TOOLS)
})

const mk = (fast: LLM, slow: LLM) => {
  const events: PipelineEvent[] = []
  const p = createPipeline({
    registry: reg, store, fastLlm: fast, slowLlm: slow,
    fastManifest: FAST_AGENT, slowManifest: MAIN_AGENT,
  })
  p.on(e => events.push(e))
  return { p, events }
}

describe('快层先斩', () => {
  it('简单车控：快层调工具并立刻出声，信号已变', async () => {
    const fast = fakeLLM(() => ({ text: '好嘞，主驾窗开一半', toolCalls: [call('window.set', { window: 'driver', position: 50 })] }))
    const slow = fakeLLM(() => ({ text: '' }))
    const { p, events } = mk(fast, slow)
    await p.run('开一半窗')
    expect(store.getTarget('cabin.window.driver.position')).toBe(50)
    const speaks = events.filter(e => e.type === 'speaking')
    expect(speaks[0]?.text).toContain('开一半')
  })

  it('快层工具面只有 fast 工具——想越权 schema 都看不到', async () => {
    const fast = fakeLLM(() => ({ text: '' }))
    const slow = fakeLLM(() => ({ text: '' }))
    const { p } = mk(fast, slow)
    await p.run('随便说点什么')
    const names = fast.seen[0].tools.map((t: any) => t.function.name)
    expect(names.join(',')).toContain('window_set')
    expect(names.join(',')).not.toContain('navigation')
    expect(names.join(',')).not.toContain('door')
  })

  it('慢层静默：快层答对且无剩余任务时不再出声', async () => {
    const fast = fakeLLM(() => ({ text: '调到24度了', toolCalls: [call('climate.set', { targetTemp: 24 })] }))
    const slow = fakeLLM(() => ({ text: '' }))
    const { p, events } = mk(fast, slow)
    await p.run('空调24度')
    expect(events.filter(e => e.type === 'speaking')).toHaveLength(1)
  })
})

describe('转交报告：单一 thread 两层共写', () => {
  it('慢层看得到快层的调用与结果（不是转述）', async () => {
    const fast = fakeLLM(() => ({ text: '好', toolCalls: [call('climate.set', { targetTemp: 24 })] }))
    const slow = fakeLLM(() => ({ text: '' }))
    const { p } = mk(fast, slow)
    await p.run('空调24度')
    const msgs = slow.seen[0].messages
    const asst = msgs.find(m => m.role === 'assistant' && m.tool_calls?.length)
    expect(asst, '快层的 tool_calls 原样在 thread 里').toBeTruthy()
    const toolMsg = msgs.find(m => m.role === 'tool')
    expect(toolMsg?.content).toContain('ok')
  })

  it('慢层纠错：改完开口，事件流两次 speaking', async () => {
    const fast = fakeLLM(() => ({ text: '调到28了', toolCalls: [call('climate.set', { targetTemp: 28 })] }))
    const slow = fakeLLM(
      () => ({ toolCalls: [call('climate.set', { targetTemp: 24 })] }),
      () => ({ text: '刚才听岔了，帮你调回24度' }),
    )
    const { p, events } = mk(fast, slow)
    await p.run('空调24度')
    expect(store.get('cabin.climate.targetTemp')).toBe(24)
    const speaks = events.filter(e => e.type === 'speaking').map(e => (e as any).text)
    expect(speaks).toHaveLength(2)
    expect(speaks[1]).toContain('24')
  })
})

describe('工具粒度装载', () => {
  it('慢层 system 常驻工具目录（brief 行），不是全量 schema', async () => {
    const fast = fakeLLM(() => ({ text: '' }))
    const slow = fakeLLM(() => ({ text: '' }))
    const { p } = mk(fast, slow)
    await p.run('帮我导航去天府广场')
    const sys = slow.seen[0].system
    expect(sys).toContain('navigation.search: 搜地点出候选列表')
    const names = slow.seen[0].tools.map((t: any) => t.function.name)
    expect(names.join(','), '未勾选未常驻的工具 schema 不该在').not.toContain('navigation_search')
  })

  it('快层 handoff 勾选的工具，慢层第一轮就有全 schema', async () => {
    const fast = fakeLLM(() => ({ text: '我看看', toolCalls: [call('agent.handoff', { suggestedTools: ['navigation.search'] })] }))
    const slow = fakeLLM(() => ({ text: '' }))
    const { p } = mk(fast, slow)
    await p.run('帮我导航去天府广场')
    const names = slow.seen[0].tools.map((t: any) => t.function.name)
    expect(names).toContain('navigation_search')
  })

  it('tools.load 补载：点名后下一轮 schema 就位', async () => {
    const fast = fakeLLM(() => ({ text: '' }))
    const slow = fakeLLM(
      () => ({ toolCalls: [call('tools.load', { names: ['music.play'] })] }),
      () => ({ text: '装好了' }),
    )
    const { p } = mk(fast, slow)
    await p.run('放首歌')
    const r1 = slow.seen[0].tools.map((t: any) => t.function.name)
    const r2 = slow.seen[1].tools.map((t: any) => t.function.name)
    expect(r1).not.toContain('music_play')
    expect(r2).toContain('music_play')
  })

  it('常驻工具（voice/card/memory）永远在慢层', async () => {
    const fast = fakeLLM(() => ({ text: '' }))
    const slow = fakeLLM(() => ({ text: '' }))
    const { p } = mk(fast, slow)
    await p.run('你好')
    const names = slow.seen[0].tools.map((t: any) => t.function.name)
    expect(names).toContain('voice_ask')
    expect(names).toContain('card_show')
    expect(names).toContain('memory_remember')
  })
})

describe('快层越权调用：转交的常态，不是用户脸上的错误', () => {
  // 用户实拍：横幅弹"已拒绝执行 当前 Agent 无权调用 navigation.setDestination"——
  // 快层对着目录直接调了圈外工具。registry 拒得对，但这是内部分工不是用户的事
  it('快层调圈外工具 → 不 emit rejected（无横幅），结果照进 thread 让慢层接手', async () => {
    const fast = fakeLLM(() => ({ toolCalls: [call('navigation.setDestination', { poiId: 'X' })] }))
    const slow = fakeLLM(() => ({ text: '我来导' }))
    const { p, events } = mk(fast, slow)
    await p.run('导航去春熙路')
    expect(events.filter(e => e.type === 'rejected'), '越权拒绝不上横幅').toHaveLength(0)
    const report = p.thread.find(m => m.role === 'tool' && m.content.includes('NOT_AUTHORIZED'))
    expect(report, '如实进转交报告').toBeTruthy()
  })

  it('快层的约束拒绝（真业务拒绝）同样静默——解释权归慢层', async () => {
    store.setDirect('vehicle.speed', 120)
    const fast = fakeLLM(() => ({ toolCalls: [call('window.set', { window: 'driver', position: 100 })] }))
    const slow = fakeLLM(() => ({ text: '在高速上呢，开窗要确认下' }))
    const { p, events } = mk(fast, slow)
    await p.run('把窗全开')
    expect(events.filter(e => e.type === 'rejected')).toHaveLength(0)
  })

  it('快层目录段的文案是"仅供勾选"，不是慢层那句"用 tools.load 取"——它没有 tools.load', async () => {
    const fast = fakeLLM(() => ({ text: '' }))
    const slow = fakeLLM(() => ({ text: '' }))
    const { p } = mk(fast, slow)
    await p.run('你好')
    expect(fast.seen[0].system).toContain('勾选')
    expect(fast.seen[0].system).not.toContain('tools.load')
    expect(slow.seen[0].system).toContain('tools.load')
  })
})

describe('自纠错误不上横幅', () => {
  // 实拍：慢层建卡缺 ttl/data.html 被拒，横幅弹"有错误做不了"，下一轮它自己
  // 就补对了——参数自纠是模型内部过程，用户只该看到最终结果
  it('INVALID_PARAMS/DATA_SHAPE 这类自纠码静默；业务性 unavailable 照常上横幅', async () => {
    const fast = fakeLLM(() => ({ text: '' }))
    const slow = fakeLLM(
      () => ({ toolCalls: [call('climate.set', { targetTemp: '很热' })] }),   // INVALID_PARAMS
      () => ({ toolCalls: [call('media.control', { action: 'next' })] }),     // NO_QUEUE（业务性）
      () => ({ text: '好了' }),
    )
    const { p, events } = mk(fast, slow)
    await p.run('随便干点什么')
    const rejects = events.filter(e => e.type === 'rejected') as any[]
    expect(rejects, '自纠码不上横幅，业务拒绝保留').toHaveLength(1)
    expect(rejects[0].text).toContain('没在放')
  })
})

describe('barge-in：turn 世代戳', () => {
  it('旧 turn 的慢层迟到话术不抢麦，降级为 lateNote；活照干完', async () => {
    let release!: (r: LLMReply) => void
    const gate = new Promise<LLMReply>(res => { release = res })
    const fast = fakeLLM(
      () => ({ text: '好' }),
      () => ({ text: '好' }),
    )
    const slow = fakeLLM(
      () => gate,                                    // turn1 慢层挂起
      () => ({ text: '' }),                          // turn2 慢层
    )
    const { p, events } = mk(fast, slow)
    const t1 = p.run('第一句')
    await new Promise(r => setTimeout(r, 0))
    const t2 = p.run('第二句')                        // barge-in
    release({ text: '第一句的迟到补充' })
    await Promise.all([t1, t2])
    const speaks = events.filter(e => e.type === 'speaking').map(e => (e as any).text)
    expect(speaks, '迟到话术不进 speaking').not.toContain('第一句的迟到补充')
    const late = events.find(e => e.type === 'lateNote') as any
    expect(late?.text).toContain('迟到补充')
  })

  /**
   * ══════════ 插话不该把上一句的活丢掉 ══════════
   *
   * 实拍（2026-08-14）：用户连说「关闭空调」「关闭车窗」，**两条都没执行**，
   * 日志里连快层都没启动。根因在快层：`stale(g)` 的检查落在
   * chat 返回之后、**执行工具之前**，于是模型已经决定要调 climate.set 了，
   * 却因为用户又说了一句而整轮丢掉。
   *
   * 设计写的是「旧慢层活照干完、话术降级」—— 慢层做到了，快层没有。
   * 而快层挂的正是车控这类**用户明说要做的事**，丢掉它最刺眼。
   *
   * 判据要分清两种作废（四条纪律第 3 条）：
   *   · barge-in（用户**追加**一句）→ 活照干完，只是不抢麦
   *   · reset（清空会话）→ 副作用一起作废
   */
  it('插话之后，上一句快层已经决定的工具照样执行', async () => {
    let release!: (r: LLMReply) => void
    const gate = new Promise<LLMReply>(res => { release = res })
    const fast = fakeLLM(
      () => gate,                                       // turn1 快层挂起
      () => ({ text: '好' }),                            // turn2 快层
    )
    const slow = fakeLLM(() => ({ text: '' }), () => ({ text: '' }))
    const { p } = mk(fast, slow)
    const t1 = p.run('关闭空调')
    await new Promise(r => setTimeout(r, 0))
    const t2 = p.run('关闭车窗')                          // barge-in
    // turn1 的快层这时才返回：它要关空调
    // 用温度不用 power：power 的初始值就是 false，断言会假绿
    release({ text: '', toolCalls: [call('climate_set', { targetTemp: 26 })] })
    await Promise.all([t1, t2])
    expect(store.getTarget('cabin.climate.targetTemp'), '插话不该把空调这件事丢掉').toBe(26)
  })

  it('但迟到的那一轮不再开新一轮 —— 干完手头的就收手', async () => {
    let release!: (r: LLMReply) => void
    const gate = new Promise<LLMReply>(res => { release = res })
    const fast = fakeLLM(
      () => gate,
      () => ({ text: '好' }),
      () => ({ text: '不该有这一轮' }),
    )
    const slow = fakeLLM(() => ({ text: '' }), () => ({ text: '' }))
    const { p } = mk(fast, slow)
    const t1 = p.run('关闭空调')
    await new Promise(r => setTimeout(r, 0))
    const t2 = p.run('关闭车窗')
    release({ text: '', toolCalls: [call('climate_set', { targetTemp: 26 })] })
    await Promise.all([t1, t2])
    // turn1 快层：一轮（挂起那次）。turn2 快层：一轮。总共 2 次 chat
    expect((fast as any).seen.length, '作废的那轮不该再开新一轮 LLM').toBe(2)
  })

  it('清空会话是另一回事：副作用一起作废', async () => {
    let release!: (r: LLMReply) => void
    const gate = new Promise<LLMReply>(res => { release = res })
    const fast = fakeLLM(() => gate)
    const slow = fakeLLM(() => ({ text: '' }))
    const { p } = mk(fast, slow)
    const t1 = p.run('关闭空调')
    await new Promise(r => setTimeout(r, 0))
    p.reset()
    release({ text: '', toolCalls: [call('climate_set', { targetTemp: 26 })] })
    await t1
    expect(store.getTarget('cabin.climate.targetTemp'), '重置之后不该有幽灵副作用').toBe(22)
  })

  it('旧慢层的消息插在新用户输入之前——时间线不交错', async () => {
    let release!: (r: LLMReply) => void
    const gate = new Promise<LLMReply>(res => { release = res })
    const fast = fakeLLM(() => ({ text: '好' }), () => ({ text: '好' }))
    const slow = fakeLLM(() => gate, () => ({ text: '' }))
    const { p } = mk(fast, slow)
    const t1 = p.run('第一句')
    await new Promise(r => setTimeout(r, 0))
    const t2 = p.run('第二句')
    release({ text: '迟到结论' })
    await Promise.all([t1, t2])
    const idxLate = p.thread.findIndex(m => m.role === 'assistant' && m.content.includes('迟到结论'))
    const idxUser2 = p.thread.findIndex(m => m.role === 'user' && m.content === '第二句')
    expect(idxLate).toBeGreaterThan(-1)
    expect(idxLate, '旧 turn 结果在新输入之前').toBeLessThan(idxUser2)
  })
})

describe('stale turn 的慢层 LLM 报错不该冒泡到当前对话（实拍：120s 超时挂起的旧 turn 被 barge-in 后才 reject，"出错了：TimeoutError"弹到用户正在问的新一句上）', () => {
  it('旧 turn 的慢层 LLM 报错，此时已被新一句插话判 stale——不该 emit error', async () => {
    let rejectFn!: (e: any) => void
    const gate = new Promise<LLMReply>((_, rej) => { rejectFn = rej })
    const fast = fakeLLM(() => ({ text: '好' }), () => ({ text: '好' }))
    const slow = fakeLLM(
      () => gate,                 // turn1 慢层挂起（模拟 120s 超时）
      () => ({ text: '' }),       // turn2 慢层
    )
    const { p, events } = mk(fast, slow)
    const t1 = p.run('第一句')
    await new Promise(r => setTimeout(r, 0))
    const t2 = p.run('第二句')    // barge-in，turn1 变 stale
    rejectFn(new Error('TimeoutError: signal timed out'))
    await Promise.all([t1, t2])
    const errors = events.filter(e => e.type === 'error')
    expect(errors, 'stale 的 LLM 报错不该冒泡成当前对话的错误').toHaveLength(0)
  })

  it('快层已办成事并报过话、无接力清单——慢层 LLM 挂了不该抢麦报错（2026-08-25 实拍：开车窗成功+已播报，慢层 429 却弹"出错了：模型限流"）', async () => {
    const fast = fakeLLM(
      () => ({ toolCalls: [call('window.set', { window: 'driver', position: 100 })] }),
      () => ({ toolCalls: [call('agent.handoff', { say: '主驾车窗已打开', suggestedTools: [] })] }),
    )
    const slow = fakeLLM(() => { throw new Error('429 模型限流了') })
    const { p, events } = mk(fast, slow)
    await p.run('打开车窗')
    expect(events.filter(e => e.type === 'error'), '用户已有完整反馈，收尾失败不该冒泡').toHaveLength(0)
    expect(events.filter(e => e.type === 'done'), '轮次要正常收尾').toHaveLength(1)
  })

  it('快层整轮越权转交（有接力清单）时慢层 LLM 挂了必须报错——活还没人干', async () => {
    const fast = fakeLLM(
      () => ({ toolCalls: [call('navigation.setDestination', { name: '天府广场' })] }),
      () => ({ toolCalls: [call('agent.handoff', { say: '这就帮你设导航', suggestedTools: ['navigation.setDestination'] })] }),
    )
    const slow = fakeLLM(() => { throw new Error('网络挂了') })
    const { p, events } = mk(fast, slow)
    await p.run('导航去天府广场')
    expect(events.filter(e => e.type === 'error'), '接力的活黄了必须让用户知道').toHaveLength(1)
  })

  it('但没被 barge-in 的正常报错，还是要照常告诉用户', async () => {
    const fast = fakeLLM(() => ({ text: '好' }))
    const slow = fakeLLM(() => { throw new Error('网络挂了') })
    const { p, events } = mk(fast, slow)
    await p.run('第一句')
    const errors = events.filter(e => e.type === 'error')
    expect(errors).toHaveLength(1)
    expect((errors[0] as any).message).toContain('网络挂了')
  })
})

describe('确认流跨层：pending 确认直达慢层', () => {
  it('有 pending 确认时，用户下一句不过快层', async () => {
    await reg.invoke('door.set', { door: 'passenger', action: 'open' })   // 灰 → inputRequired
    const fast = fakeLLM(() => ({ text: '不该被调用' }))
    const slow = fakeLLM(() => ({ text: '好，帮你开副驾门' }))
    const { p, events } = mk(fast, slow)
    await p.run('确认')
    expect(fast.seen, '快层被跳过').toHaveLength(0)
    expect(events.filter(e => e.type === 'speaking')).toHaveLength(1)
  })
})

describe('handoff 的 say：勾选与话术一个调用完成', () => {
  // 实拍：话术轮 qwen 只调了 handoff 没给 text，轮次用尽一声没吭，首声全等慢层。
  // 修法：handoff 带 say 字段——说话不再依赖模型"调完还记得说"
  it('handoff.say 直接成为快层话术：emit speaking + 进 trace', async () => {
    const fast = fakeLLM(
      () => ({ toolCalls: [call('climate.set', { targetTemp: 24 })] }),
      () => ({ toolCalls: [call('agent.handoff', { say: '空调24度好了', suggestedTools: [] })] }),
    )
    const slow = fakeLLM(() => ({ text: '' }))
    const { p, events } = mk(fast, slow)
    const r = await p.run('空调24度')
    const speaks = events.filter(e => e.type === 'speaking') as any[]
    expect(speaks).toHaveLength(1)
    expect(speaks[0].text).toBe('空调24度好了')
    expect(speaks[0].layer).toBe('fast')
    expect(r.reply).toContain('空调24度好了')
  })
})

describe('分层追踪：一个需求的流转全程可见', () => {
  it('trace 的 prompt/reply 条目带 layer 与 LLM 耗时——日志能还原快慢流水', async () => {
    const fast = fakeLLM(() => ({ text: '好嘞', toolCalls: [call('climate.set', { targetTemp: 24 })] }))
    const slow = fakeLLM(() => ({ text: '' }))
    const { p } = mk(fast, slow)
    const r = await p.run('空调24度')
    const prompts = r.trace.filter(t => t.type === 'prompt') as any[]
    expect(prompts.some(t => t.layer === 'fast')).toBe(true)
    expect(prompts.some(t => t.layer === 'slow')).toBe(true)
    for (const t of prompts) expect(typeof t.llmMs, 'LLM 耗时已回填').toBe('number')
    const replies = r.trace.filter(t => t.type === 'reply') as any[]
    expect(replies.some(t => t.layer === 'fast' && t.text.includes('好嘞')), '快层话术进 trace').toBe(true)
  })
})

describe('快层上下文', () => {
  it('话术轮看得见**本轮**的执行结果——不然会说"马上查"其实早查完了（实拍）', async () => {
    const fast = fakeLLM(
      () => ({ toolCalls: [call('climate.set', { targetTemp: 24 })] }),
      () => ({ text: '空调24度好了' }),
    )
    const slow = fakeLLM(() => ({ text: '' }))
    const { p } = mk(fast, slow)
    await p.run('空调24度')
    const r2 = fast.seen[1]
    expect(r2.messages.some(m => m.role === 'tool'), '本轮工具结果在视图里').toBe(true)
    const names = (r2.tools ?? []).map((t: any) => t.function.name)
    expect(names, '话术轮只留 handoff——勾选通道不撤，业务工具撤').toEqual(['agent_handoff'])
  })

  it('历史轮的工具细节仍然不带——只裁旧的，不裁本轮的', async () => {
    const fast = fakeLLM(
      () => ({ text: '好', toolCalls: [call('climate.set', { targetTemp: 24 })] }),   // turn1 R1
      () => ({ text: '好了' }),                                                        // turn1 R2（话术轮）
      () => ({ text: '再热了点' }),                                                    // turn2 R1
    )
    const slow = fakeLLM(() => ({ text: '' }), () => ({ text: '' }))
    const { p } = mk(fast, slow)
    await p.run('空调24度')
    await p.run('再热一点')
    const msgs = fast.seen[2].messages    // turn2 首轮：历史 = turn1，本轮只有新输入
    expect(msgs.some(m => m.role === 'tool'), '历史轮工具结果不进视图').toBe(false)
    expect(msgs.some(m => m.tool_calls?.length), '历史轮 tool_calls 不进视图').toBe(false)
    expect(msgs[msgs.length - 1].content).toBe('再热一点')
  })

  it('空输入直接返回，不叫任何模型', async () => {
    const fast = fakeLLM()
    const slow = fakeLLM()
    const { p } = mk(fast, slow)
    await p.run('   ')
    expect(fast.seen).toHaveLength(0)
    expect(slow.seen).toHaveLength(0)
  })
})

/**
 * ══════════ 同一个调用连着失败，要停下来说人话 ══════════
 *
 * 实拍（2026-08-14）：用户问「你有什么功能」，模型连着 **9 轮**用同样的错误
 * 参数调 card.show，每轮都被同一个 DATA_SHAPE_MISMATCH 拒，**40 秒**烧完
 * 轮次上限，最后「无话术」—— 屏幕空白，Agent 一声不吭。
 *
 * 参数形状那半边已经在 registry 收了（`{item:[…]}` 展平），但**不撞死在
 * 同一堵墙上**是独立的一条：下次换个 Tool、换个错误码，同样会烧满轮次。
 *
 * 判据只看**同一个工具 + 同一个错误码连续几次**，不看是什么工具、
 * 什么错误 —— 机制不是意图分支。
 */
describe('不撞死在同一堵墙上', () => {
  const badCall = () => ({
    text: '', toolCalls: [call('card_show', { template: 'list' })],   // 缺 data，必被拒
  })

  it('同一个调用连着失败就收手，不烧满轮次', async () => {
    const fast = fakeLLM(() => ({ text: '' }))
    // 给足够多的相同失败回合；真收手的话后面这些根本用不到
    const slow = fakeLLM(...Array.from({ length: 9 }, () => badCall))
    const { p } = mk(fast, slow)
    await p.run('你有什么功能')
    expect((slow as any).seen.length, '撞三次墙就该停，不该跑满 9 轮').toBeLessThanOrEqual(5)
  })

  it('收手时必须说人话 —— 沉默是最糟的收场', async () => {
    const fast = fakeLLM(() => ({ text: '' }))
    const slow = fakeLLM(
      badCall, badCall, badCall, badCall,
      () => ({ text: '这张卡我排不出来，换个说法试试' }),
    )
    const { p, events } = mk(fast, slow)
    const r = await p.run('你有什么功能')
    const spoke = events.some(e => e.type === 'speaking')
    expect(spoke || !!r.reply, '不能一句话都不说').toBe(true)
  })

  /** 换了工具或换了错误码就不算"撞同一堵墙"，正常重试 */
  it('错误码变了就重新计数 —— 那是在往前走不是在打转', async () => {
    const fast = fakeLLM(() => ({ text: '' }))
    const slow = fakeLLM(
      () => ({ text: '', toolCalls: [call('card_show', { template: 'list' })] }),          // 缺 data
      () => ({ text: '', toolCalls: [call('window_set', { window: 'driver' })] }),         // 缺 position
      () => ({ text: '', toolCalls: [call('climate_set', { targetTemp: 99 })] }),          // 超范围
      () => ({ text: '好了' }),
    )
    const { p } = mk(fast, slow)
    const r = await p.run('随便干点什么')
    expect(r.reply, '一直在换招就不该被熔断').toContain('好了')
  })
})

/**
 * ══════════ 快层越权 = 立刻转交，不必再跑一轮 ══════════
 *
 * 实拍算账（2026-08-14，设一次导航目的地）：
 *   快层轮1 9.1s → 调 navigation.setDestination → 越权，**0ms** 被拒
 *   快层轮2 3.9s → 只剩 handoff，转交
 *   慢层     1.2s → 真把事办了
 * 16.7 秒里 13 秒是快层烧的，而它一件事都没做成。
 *
 * 第一轮拿到 NOT_AUTHORIZED 的那一刻，**这活归慢层已经是确定的事实**，
 * 而且越权的那几个工具名就是最好的 suggestedTools —— 第二轮纯属白等。
 *
 * 判据是**权限判定的结果**（系统状态），不是话的内容 ——
 * 跟「pending 确认直达慢层」同一条：状态分支不是意图分支。
 */
describe('快层越权就直接转交', () => {
  it('整轮都越权 → 不再开第二轮', async () => {
    const fast = fakeLLM(
      () => ({ text: '', toolCalls: [call('navigation_setDestination', { location: '春熙路' })] }),
      () => ({ text: '不该有这一轮' }),
    )
    const slow = fakeLLM(() => ({ text: '好嘞，出发' }))
    const { p } = mk(fast, slow)
    await p.run('导航去春熙路')
    expect((fast as any).seen.length, '越权那一刻就该收手').toBe(1)
  })

  it('越权的工具名当作转交建议 —— 慢层第一轮就能直接调', async () => {
    const fast = fakeLLM(() => ({ text: '', toolCalls: [call('navigation_setDestination', {})] }))
    const slow = fakeLLM(() => ({ text: '好' }))
    const { p } = mk(fast, slow)
    await p.run('导航去春熙路')
    // 慢层拿到的工具表里要有它（预载），否则慢层还得先 tools.load 一轮
    const names = ((slow as any).seen[0].tools ?? []).map((t: any) => t.function?.name ?? t.name)
    expect(names, '越权的工具该被预载进慢层').toContain('navigation_setDestination')
  })

  /** 只有**整轮**都越权才算——一半成功一半越权说明快层还在干活，别打断它 */
  it('有一个成功就照常走完 —— 那说明快层还在办事', async () => {
    const fast = fakeLLM(
      () => ({ text: '', toolCalls: [
        call('climate_set', { targetTemp: 26 }),                 // 有权限
        call('navigation_setDestination', {}),                   // 越权
      ] }),
      () => ({ text: '好了' }),
    )
    const slow = fakeLLM(() => ({ text: '' }))
    const { p } = mk(fast, slow)
    await p.run('开到26度顺便导航')
    expect((fast as any).seen.length, '还有活在干，不该提前收手').toBe(2)
  })

  it('工具调成功时照常走完两轮', async () => {
    const fast = fakeLLM(
      () => ({ text: '', toolCalls: [call('climate_set', { targetTemp: 26 })] }),
      () => ({ text: '好了' }),
    )
    const slow = fakeLLM(() => ({ text: '' }))
    const { p } = mk(fast, slow)
    await p.run('开到26度')
    expect((fast as any).seen.length).toBe(2)
  })
})


/**
 * ══════════ 接力棒必须看得见（2026-08-17 实拍回归） ══════════
 *
 * 「整轮越权就立刻转交」省掉了快层第二轮，但把接力语境一起省掉了：
 * thread 的最后一幕变成「调 setDestination → NOT_AUTHORIZED」，慢层看到的
 * 是"这工具刚被拒"，不知道被拒的是**快层**、自己有权限 —— 实拍它先模仿
 * 快层去调 agent_handoff（UNKNOWN_TOOL），再嘴上认输"我这边没权限做不了"，
 * 用户明说要的导航就这么黄了。
 *
 * 修法：转交时给慢层的**本轮视图**注入一条接力说明（是谁被拒的、你有权限、
 * 直接调、别学快层调 handoff）。只进视图不落 thread —— 它是运行时状态注释，
 * 不是对话事实。
 */
describe('越权转交的接力棒', () => {
  it('慢层视图末尾有接力说明：点名工具 + 说清你有权限', async () => {
    const fast = fakeLLM(() => ({ text: '', toolCalls: [call('navigation_setDestination', { address: '春熙路' })] }))
    const slow = fakeLLM(() => ({ text: '好' }))
    const { p } = mk(fast, slow)
    await p.run('导航去春熙路')
    const view = (slow as any).seen[0].messages
    const hint = view[view.length - 1]
    expect(hint.role).toBe('system')
    expect(hint.content).toContain('navigation.setDestination')
    expect(hint.content).toMatch(/你有权限|你可以直接调/)
    // 别点名 agent.handoff —— 小模型对否定句里的名字有正向引力，
    // 实拍（打开后备箱）：提示里写着"别调它"，慢层第一轮偏偏就调了它
    expect(hint.content).not.toContain('agent.handoff')
    expect(hint.content).not.toContain('agent_handoff')
  })

  it('接力说明不落 thread —— 下一轮不该还带着', async () => {
    const fast = fakeLLM(
      () => ({ text: '', toolCalls: [call('navigation_setDestination', {})] }),
      () => ({ text: '好' }),
    )
    const slow = fakeLLM(() => ({ text: '好' }), () => ({ text: '好' }))
    const { p } = mk(fast, slow)
    await p.run('导航去春熙路')
    expect(p.thread.some(m => m.role === 'system' && (m.content ?? '').includes('你有权限')),
      '视图注释不是对话事实').toBe(false)
  })

  it('没有越权时不注入 —— 别给每一轮都塞一条没用的说明', async () => {
    const fast = fakeLLM(() => ({ text: '好' }))
    const slow = fakeLLM(() => ({ text: '好' }))
    const { p } = mk(fast, slow)
    await p.run('你好')
    const view = (slow as any).seen[0].messages
    expect(view.some((m: any) => (m.content ?? '').includes('你有权限'))).toBe(false)
  })
})

/**
 * handoff 是快层的**终止符** —— 实拍它调完 handoff 还开了一轮，
 * 又调一遍 handoff（0.9s 纯浪费）。收尾调完就该收手。
 */
describe('handoff 即收尾', () => {
  it('快层调过 handoff 就不再开下一轮', async () => {
    const fast = fakeLLM(
      () => ({ text: '', toolCalls: [call('agent_handoff', { say: '转同事', suggestedTools: [] })] }),
      () => ({ text: '不该有这一轮' }),
    )
    const slow = fakeLLM(() => ({ text: '好' }))
    const { p } = mk(fast, slow)
    await p.run('做个计算器')
    expect((fast as any).seen.length).toBe(1)
  })
})


/**
 * ══════════ 慢层迷路时要被扶正，不是撞 UNKNOWN_TOOL（2026-08-16 实拍） ══════════
 *
 * 「打开后备箱」：慢层模仿共享 thread 里快层的调用记录去调 agent_handoff，
 * 吃了个 UNKNOWN_TOOL 之后直接放弃，嘴上让用户"在屏幕上点确认"——
 * 那个确认弹窗根本不存在（trunk.set 从没被调，确认流从没被触发）。
 * 给它一个能自纠的回执（SELF_FIX，不上横幅），下一轮把灰工具真调起来。
 */
describe('慢层的 handoff 扶正', () => {
  it('慢层调 agent_handoff 拿到纠偏回执而非 UNKNOWN_TOOL，且还有下一轮', async () => {
    const fast = fakeLLM(() => ({ text: '', toolCalls: [call('trunk.set', { state: 'open' })] }))
    const slow = fakeLLM(
      () => ({ text: '', toolCalls: [call('agent_handoff', { say: '无权调用', suggestedTools: { item: 'trunk.set' } })] }),
      () => ({ text: '', toolCalls: [call('trunk.set', { target: 'trunk', action: 'open' })] }),
      () => ({ text: '要打开后备箱吗' }),
    )
    const { p } = mk(fast, slow)
    await p.run('打开后备箱')
    const toolMsgs = p.thread.filter(m => m.role === 'tool').map(m => String(m.content))
    expect(toolMsgs.some(t => t.includes('UNKNOWN_TOOL') && t.includes('agent_handoff'))).toBe(false)
    const fix = toolMsgs.find(t => t.includes('LAST_STOP'))
    expect(fix, '纠偏回执要指路：直接调工具').toContain('直接调')
    expect((slow as any).seen.length, '纠偏后还有下一轮去真办事').toBeGreaterThanOrEqual(2)
  })

  it('灰工具由慢层调起时确认流照常走 —— 屏幕上有确认可点', async () => {
    const fast = fakeLLM(() => ({ text: '', toolCalls: [call('trunk.set', { state: 'open' })] }))
    const slow = fakeLLM(() => ({ text: '', toolCalls: [call('trunk.set', { target: 'trunk', action: 'open' })] }))
    const { p, events } = mk(fast, slow)
    await p.run('打开后备箱')
    expect(events.some(e => e.type === 'confirming'), '灰工具要弹确认，不是让用户找不存在的按钮').toBe(true)
  })

  it('快层 handoff 的 suggestedTools 收 {item:…} 退化 —— 照样预载给慢层', async () => {
    const fast = fakeLLM(() => ({ text: '', toolCalls: [call('agent_handoff', { say: '转交', suggestedTools: { item: 'navigation.setDestination' } })] }))
    const slow = fakeLLM(() => ({ text: '好' }))
    const { p } = mk(fast, slow)
    await p.run('导航去春熙路')
    const names = ((slow as any).seen[0].tools ?? []).map((t: any) => t.function.name)
    expect(names).toContain('navigation_setDestination')
  })
})

/**
 * ══════════ 慢层复述静音（2026-08-17 实拍） ══════════
 *
 * 屏端的同文去重逮不住换说法的复述：「空调已打开」→「空调已经开了。
 * 需要调温度或者风量吗？」、「车窗已打开」→「窗户也打开了」。
 * persona 写了"说过的一个点都不许再说"，小模型照样违反。
 *
 * 立成机制，判据是系统状态不是语义：快层已报过结果（≥1 个业务工具成功
 * 且说了话）、慢层全程零业务调用 → 它的最终话术必是复述，不出声。
 * 文本仍落 thread（上下文要），trace 仍记（排查要）。
 * 慢层真干了活（补活/纠错/被拒后解释）照说不误。
 */
describe('慢层复述静音', () => {
  it('快层办成并播报后，慢层没干活的话术不再出声', async () => {
    const fast = fakeLLM(
      () => ({ text: '空调已打开', toolCalls: [call('climate.set', { power: true })] }),
      () => ({ text: '', toolCalls: [call('agent_handoff', { say: '', suggestedTools: [] })] }),
    )
    const slow = fakeLLM(() => ({ text: '空调已经开了。需要调温度或者风量吗？' }))
    const { p, events } = mk(fast, slow)
    await p.run('打开空调')
    const speaks = events.filter(e => e.type === 'speaking')
    expect(speaks, '只有快层那一声').toHaveLength(1)
    expect((speaks[0] as any).layer).toBe('fast')
    expect(p.thread.some(m => m.role === 'assistant' && (m.content ?? '').includes('需要调温度')),
      '话术仍进 thread 供上下文').toBe(true)
  })

  it('慢层干了新活（补开车窗）→ 照说不误', async () => {
    const fast = fakeLLM(() => ({ text: '空调开了', toolCalls: [call('climate.set', { power: true })] }))
    const slow = fakeLLM(
      () => ({ text: '', toolCalls: [call('window.set', { window: 'driver', position: 50 })] }),
      () => ({ text: '车窗也开了一半' }),
    )
    const { p, events } = mk(fast, slow)
    await p.run('开空调和车窗')
    const texts = events.filter(e => e.type === 'speaking').map((e: any) => e.text)
    expect(texts).toContain('车窗也开了一半')
  })

  it('快层没办成任何事（纯聊天）→ 慢层是唯一的应答者，必须出声', async () => {
    const fast = fakeLLM(() => ({ text: '', toolCalls: [call('agent_handoff', { say: '', suggestedTools: [] })] }))
    const slow = fakeLLM(() => ({ text: '我是车载助手，能开窗调温放歌' }))
    const { p, events } = mk(fast, slow)
    await p.run('你能干什么')
    const texts = events.filter(e => e.type === 'speaking').map((e: any) => e.text)
    expect(texts).toContain('我是车载助手，能开窗调温放歌')
  })
})


/**
 * ══════════ 慢层的视图里不该存在「无权」（2026-08-18 实拍） ══════════
 *
 * 「导航去一个可以打游戏的地方」：工具预载成功（注入 13 工具）、接力提示
 * 也在，慢层照样说"权限没给到"。原因是共享 thread 里躺着快层那条
 * NOT_AUTHORIZED 的工具结果**原文**——对小模型，一条鲜活的错误记录比
 * 末尾一条 system 提示重得多，它信了证据没信提示。
 *
 * 根治从证据下手：那条记录对慢层是**假的**（被拒的是快层，慢层全权）。
 * 每层看到的应该是自己视角下的真相——慢层视图里把它改写成转交语义；
 * thread 原文不动（快层的历史是真的），面板 trace 照旧真实。
 */
describe('慢层视图的被拒记录改写', () => {
  it('NOT_AUTHORIZED 在慢层视图里变成转交语义，thread 原文不动', async () => {
    const fast = fakeLLM(() => ({ text: '', toolCalls: [call('navigation.search', { query: '网吧' })] }))
    const slow = fakeLLM(() => ({ text: '好' }))
    const { p } = mk(fast, slow)
    await p.run('导航去网吧')
    const view = (slow as any).seen[0].messages
    const toolMsgs = view.filter((m: any) => m.role === 'tool').map((m: any) => String(m.content))
    expect(toolMsgs.some((t: string) => t.includes('NOT_AUTHORIZED')), '慢层不该看到"无权"').toBe(false)
    expect(toolMsgs.some((t: string) => t.includes('转交') || t.includes('你有权限')), '要看到的是转交语义').toBe(true)
    // thread 里的原始记录不动——那是快层的真实历史
    expect(p.thread.some(m => m.role === 'tool' && String(m.content).includes('NOT_AUTHORIZED'))).toBe(true)
  })
})

/**
 * ══════════ 语音链路批1（设计文档 2026-08-18-voice-channel-design.md） ══════════
 */
describe('成功型打转熔断', () => {
  it('相邻两轮同工具同参数、上轮已 ok → 本轮先斩为 REPEAT_CALL', async () => {
    const fast = fakeLLM(() => ({ text: '', toolCalls: [call('agent_handoff', { say: '', suggestedTools: ['voice.speak'] })] }))
    const slow = fakeLLM(
      () => ({ text: '', toolCalls: [call('voice.speak', { text: '选哪个？' })] }),
      () => ({ text: '', toolCalls: [call('voice.speak', { text: '选哪个？' })] }),
      () => ({ text: '好' }),
    )
    const { p } = mk(fast, slow)
    await p.run('问个问题')
    const toolMsgs = p.thread.filter(m => m.role === 'tool').map(m => String(m.content))
    expect(toolMsgs.some((t: string) => t.includes('REPEAT_CALL')), '重复调用要被斩').toBe(true)
  })

  it('同一轮内的并行重复不拦——连跳两首歌是一轮两个调用', async () => {
    const fast = fakeLLM(() => ({ text: '', toolCalls: [
      call('window.set', { window: 'driver', position: 50 }, 'c1'),
      call('window.set', { window: 'driver', position: 50 }, 'c2'),
    ] }))
    const slow = fakeLLM(() => ({ text: '' }))
    const { p } = mk(fast, slow)
    await p.run('开窗')
    const toolMsgs = p.thread.filter(m => m.role === 'tool').map(m => String(m.content))
    expect(toolMsgs.some((t: string) => t.includes('REPEAT_CALL'))).toBe(false)
  })

  it('跨 turn 不拦——新输入是新意愿', async () => {
    // responder 按轮消费：每个 turn 快层跑两轮（调完 + 收尾），要摆四个
    const fast = fakeLLM(
      () => ({ text: '', toolCalls: [call('climate.set', { targetTemp: 24 })] }),
      () => ({ text: '好' }),
      () => ({ text: '', toolCalls: [call('climate.set', { targetTemp: 24 })] }),
      () => ({ text: '好' }),
    )
    const slow = fakeLLM(() => ({ text: '' }), () => ({ text: '' }))
    const { p } = mk(fast, slow)
    await p.run('空调24')
    await p.run('再确认下空调24')
    const toolMsgs = p.thread.filter(m => m.role === 'tool').map(m => String(m.content))
    expect(toolMsgs.some((t: string) => t.includes('REPEAT_CALL'))).toBe(false)
  })
})

describe('stale 下 mic 工具拒绝——说话就是抢麦，建问题卡也是', () => {
  it('旧轮的 voice.ask 被拒且不建卡', async () => {
    /**
     * 确定性构造 barge-in：t1 的慢层在自己第一次被调用时触发插话
     * （等一个宏任务让 gen 先走），再返回 voice.ask——此刻它已是旧代。
     * 靠并发时序摆 responder 会把门闩发错人（前两版都这么假红/假绿过）。
     */
    let pipe: any
    let first = true
    const fast = fakeLLM(
      () => ({ text: '', toolCalls: [call('agent_handoff', { say: '', suggestedTools: ['voice.ask'] })] }),
      () => ({ text: '好' }),
    )
    const slowRespond = async () => {
      if (first) {
        first = false
        void pipe.run('第4个')                       // barge-in：本轮变旧
        await new Promise(r => setTimeout(r, 0))
        return { text: '', toolCalls: [call('voice.ask', { question: '去哪个？', options: ['A', 'B'] })] }
      }
      return { text: '' }
    }
    const slow = fakeLLM(slowRespond, slowRespond, slowRespond)
    const { p } = mk(fast, slow)
    pipe = p
    await p.run('导航去春熙路')
    await new Promise(r => setTimeout(r, 5))         // 等插话 turn 收尾
    const toolMsgs = p.thread.filter(m => m.role === 'tool').map(m => String(m.content))
    expect(toolMsgs.some((t: string) => t.includes('STALE_TURN')), '过期的问题不该再问').toBe(true)
  })
})

describe('屏端合成的回答直达慢层', () => {
  it('answer 输入不跑快层——快层对"第4个"无事可做', async () => {
    const fast = fakeLLM(() => ({ text: '不该被调用' }))
    const slow = fakeLLM(() => ({ text: '好，导航到春熙路步行街' }))
    const { p } = mk(fast, slow)
    await p.run('（用户在屏幕上点选）第4个：春熙路', { answer: true })
    expect((fast as any).seen.length, '快层一轮都不该跑').toBe(0)
    expect((slow as any).seen.length).toBe(1)
  })
})

/**
 * 撞墙计数不被元工具轮清洗（2026-08-19 实拍）：create 被拒 2 次 →
 * tools.load（成功）→ 又拒 2 次——计数在"成功轮"清零，永远凑不满 3，
 * 模型在同一堵墙上撞了 7 次烧光轮次。元工具轮是准备动作不是进展，
 * 不该重置"在打转"的判定。
 */
describe('撞墙计数与元工具轮', () => {
  it('失败→load→失败→失败 照样触发熔断跳最后一轮', async () => {
    const fast = fakeLLM(() => ({ text: '', toolCalls: [call('agent_handoff', { say: '', suggestedTools: [] })] }))
    const badCreate = () => ({ text: '', toolCalls: [call('automation.create', { name: 'x', when: { item: { time: 'bad' } }, do: [] })] })
    const slow = fakeLLM(
      badCreate,
      badCreate,
      () => ({ text: '', toolCalls: [call('tools.load', { names: ['climate.set'] })] }),
      badCreate,        // 第 3 次同签名失败——中间隔了一个元工具轮
      () => ({ text: '没建成，我换个方式再试' }),
      () => ({ text: '不该到这轮' }),
    )
    const { p } = mk(fast, slow)
    const r = await p.run('建个任务')
    // 熔断生效的铁证：第 3 次失败后的下一轮是"撤工具逼话术"的最后一轮
    const rounds = (slow as any).seen
    expect(rounds[4].tools.length, '熔断后最后一轮必须撤工具').toBe(0)
    expect(r.reply).toContain('没建成')
  })
})

/**
 * ══════════ 2026-08-19 实拍长日志六修 ══════════
 */
describe('空话术收场的兜底（实拍：automation 撞墙 9 轮后静默结束，用户干等 2 分钟）', () => {
  it('慢层空文本收场且快层也没报过 → 兜一句诚实的，不许静默', async () => {
    // 快层无话转交；慢层第一轮调工具失败，第二轮直接回空文本收场
    const fast = fakeLLM(() => ({ text: '', toolCalls: [call('agent.handoff', {})] }))
    const slow = fakeLLM(
      () => ({ text: '', toolCalls: [call('automation.create', { name: 'x', when: [], do: [] })] }),
      () => ({ text: '' }),   // 空收场——实拍就是这里静默了
    )
    const { p, events } = mk(fast, slow)
    await p.run('以后下雨自动关窗')
    const speaks = events.filter(e => e.type === 'speaking')
    expect(speaks.length, '必须有一句收场话').toBeGreaterThan(0)
  })

  it('快层已报过结果时，慢层空收场仍然合法静默（不重复打扰）', async () => {
    const fast = fakeLLM(() => ({ text: '调到24度了', toolCalls: [call('climate.set', { targetTemp: 24 })] }))
    const slow = fakeLLM(() => ({ text: '' }))
    const { p, events } = mk(fast, slow)
    await p.run('空调24度')
    expect(events.filter(e => e.type === 'speaking')).toHaveLength(1)
  })
})

describe('voice.ask 之后的下一句直达慢层（实拍：绘本 ask 挂着，"结束"被快层接走乱答）', () => {
  it('上一轮问了问题，下一轮输入不进快层', async () => {
    const fast = fakeLLM(() => ({ text: '', toolCalls: [call('agent.handoff', {})] }))
    const slow = fakeLLM(
      () => ({ text: '', toolCalls: [call('voice.ask', { question: '要探险还是回家？', options: ['探险', '回家'] })] }),
      () => ({ text: '问题问出去了' }),
      () => ({ text: '好，故事收尾了' }),
    )
    const { p } = mk(fast, slow)
    await p.run('给孩子讲个故事')
    const fastCallsBefore = fast.seen.length
    await p.run('结束')
    expect(fast.seen.length, 'ask 挂着时新输入不该进快层').toBe(fastCallsBefore)
  })
})

describe('voice.speak 绕过复述静音的堵口（实拍：快层报完偏好，慢层 voice.speak 又念一遍）', () => {
  it('快层已报结果、慢层没干新活 → voice.speak 拒，整 turn 只出声一次', async () => {
    const fast = fakeLLM(
      () => ({ text: '我看看', toolCalls: [call('vehicle.getState', { paths: ['cabin.climate.targetTemp'] })] }),
      () => ({ text: '空调22度', toolCalls: [call('agent.handoff', { say: '空调22度' })] }),
    )
    const slow = fakeLLM(
      () => ({ text: '', toolCalls: [call('voice.speak', { text: '您的空调偏好是22度。' })] }),
      () => ({ text: '' }),
    )
    const { p, events } = mk(fast, slow)
    const r = await p.run('我的空调偏好是什么')
    // 慢层零出声：reply 通道被 echo 静音，工具通道被 ECHO_FAST 闸住
    expect(events.filter(e => e.type === 'speaking' && e.layer === 'slow')).toHaveLength(0)
    const speakResult = r.trace.find(t => t.type === 'toolResult' && t.name === 'voice.speak') as any
    expect(speakResult?.result?.code, '复述性 voice.speak 要被出声权闸拒掉').toBe('ECHO_FAST')
  })

  it('快层没报过时 voice.speak 正常放行', async () => {
    const fast = fakeLLM(() => ({ text: '', toolCalls: [call('agent.handoff', {})] }))
    const slow = fakeLLM(
      () => ({ text: '', toolCalls: [call('voice.speak', { text: '查好了，今天晴。' })] }),
      () => ({ text: '' }),
    )
    const { p } = mk(fast, slow)
    const r = await p.run('今天天气怎么样')
    const speakResult = r.trace.find(t => t.type === 'toolResult' && t.name === 'voice.speak') as any
    expect(speakResult?.result?.status, '快层没报过时 voice.speak 放行').toBe('ok')
  })

  it('慢层先干了新活再 voice.speak → 放行（新信息该说）', async () => {
    const fast = fakeLLM(
      () => ({ text: '窗开了', toolCalls: [call('window.set', { window: 'driver', position: 50 })] }),
      () => ({ text: '', toolCalls: [call('agent.handoff', { say: '窗开了' })] }),
    )
    const slow = fakeLLM(
      () => ({ text: '', toolCalls: [call('climate.set', { targetTemp: 24 })] }),
      () => ({ text: '', toolCalls: [call('voice.speak', { text: '空调也顺手开到24度了。' })] }),
      () => ({ text: '' }),
    )
    const { p } = mk(fast, slow)
    const r = await p.run('有点热开点窗')
    const speakResult = r.trace.find(t => t.type === 'toolResult' && t.name === 'voice.speak') as any
    expect(speakResult?.result?.status, '慢层干了新活之后 voice.speak 放行').toBe('ok')
  })
})

describe('REPEAT_CALL 不许隔轮穿透（实拍：story.begin 同参重放，拦一轮后第三轮就过了，故事被开讲两次）', () => {
  it('同一签名连试三轮，第二三轮都被拦', async () => {
    const fast = fakeLLM(() => ({ text: '', toolCalls: [call('agent.handoff', {})] }))
    const sameCall = () => ({ text: '', toolCalls: [call('window.set', { window: 'driver', position: 50 })] })
    const slow = fakeLLM(sameCall, sameCall, sameCall, () => ({ text: '开好了' }))
    const { p } = mk(fast, slow)
    const r = await p.run('开窗')
    const results = r.trace.filter(t => t.type === 'toolResult' && t.name === 'window.set') as any[]
    expect(results.length).toBe(3)
    expect(results[0].result.status).toBe('ok')
    expect(results[1].result.code).toBe('REPEAT_CALL')
    expect(results[2].result.code, '隔轮重放也要拦——执念要换参数才放行').toBe('REPEAT_CALL')
  })
})

/**
 * ══════════ 交互总设计 P1（2026-08-19）══════════
 */
describe('R1-① 未起飞输入合并：前句零副作用就吞并，不丢弃', () => {
  it('前句 run 还没调过工具，新句进来 → 两句合并进同一个 run', async () => {
    const sleep = (ms: number) => new Promise(r => setTimeout(r, ms))
    // 前句的快层挂 80ms 才回——期间新句进来
    const fast = fakeLLM(
      async () => { await sleep(80); return { text: '' } },
      () => ({ text: '' }),
    )
    const slow = fakeLLM(() => ({ text: '好' }), () => ({ text: '好' }))
    const { p } = mk(fast, slow)
    const a = p.run('来个24点小游戏')
    await sleep(10)
    const b = p.run('再查下美股')
    await Promise.all([a, b])
    const lastReq = slow.seen[slow.seen.length - 1]
    const users = lastReq.messages.filter((m: any) => m.role === 'user').map((m: any) => m.content)
    // 合并的本质：两句在**同一条** user 消息里（明示"连说两句"），旧孤立消息被撤
    expect(users, '吞并后只有一条 user 消息').toHaveLength(1)
    expect(users[0]).toContain('24点')
    expect(users[0]).toContain('美股')
  })
})

describe('R3 快层话术的读者视角注释', () => {
  it('慢层视图里快层的话带注释——"同事"就是它自己', async () => {
    const fast = fakeLLM(() => ({ text: '导航得同事来搞，我先放歌',
      toolCalls: [call('music.play', { query: '周杰伦' })] }))
    const slow = fakeLLM(() => ({ text: '' }))
    const { p } = mk(fast, slow)
    await p.run('导航去春熙路，放周杰伦')
    const req = slow.seen[0]
    const flat = JSON.stringify(req.messages)
    expect(flat).toContain('快手分身')
    expect(flat, '注释要点破"同事"就是读者自己').toContain('指你自己')
  })
})

describe('R3 接力清单显式化', () => {
  it('快层越权的工具以任务清单形式出现在慢层视图里', async () => {
    const fast = fakeLLM(() => ({ text: '',
      toolCalls: [call('navigation.setDestination', { destination: '春熙路' }), call('agent.handoff', {})] }))
    const slow = fakeLLM(() => ({ text: '' }), () => ({ text: '' }))
    const { p } = mk(fast, slow)
    await p.run('导航去春熙路')
    const flat = JSON.stringify(slow.seen[0].messages) + (slow.seen[0].system ?? '')
    expect(flat, '接力清单点名未办的工具').toContain('navigation.setDestination')
    expect(flat).toMatch(/没办完|由你办/)
  })
})
