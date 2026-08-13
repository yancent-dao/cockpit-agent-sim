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
