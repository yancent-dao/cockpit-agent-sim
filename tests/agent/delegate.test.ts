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
 * task.delegate（设计文档 §6）：拆分决策归慢层模型——一轮连发 N 个 delegate
 * 即并行；同步模式主模型汇总，后台模式完成后机械交付。
 * 边界：深度 1 / 并发 ≤3 / 子 Agent 无灰权限。
 */

function scriptedLLM(fn: (req: LLMRequest, n: number) => LLMReply | Promise<LLMReply>) {
  const seen: LLMRequest[] = []
  return {
    seen,
    async chat(req: LLMRequest) { seen.push(req); return fn(req, seen.length) },
    async models() { return [] },
  } as LLM & { seen: LLMRequest[] }
}

const call = (name: string, args: any, id = 'c' + Math.random().toString(36).slice(2, 6)) =>
  ({ id, name, args })

/** 子 Agent 的请求特征：首条消息**就是** goal 本身（不背主对话包袱），精确匹配防误伤主对话 */
const isSub = (req: LLMRequest, goal: string) => req.messages[0]?.content === goal

let store: ReturnType<typeof createStore>
let reg: ReturnType<typeof createRegistry>
beforeEach(() => {
  store = createStore(SIGNALS, CONSTRAINTS)
  reg = createRegistry(store, TOOLS)
})

const mk = (slowFn: (req: LLMRequest, n: number) => LLMReply | Promise<LLMReply>) => {
  const fast = scriptedLLM(() => ({ text: '' }))
  const slow = scriptedLLM(slowFn)
  const events: PipelineEvent[] = []
  const p = createPipeline({
    registry: reg, store, fastLlm: fast, slowLlm: slow,
    fastManifest: FAST_AGENT, slowManifest: MAIN_AGENT,
  })
  p.on(e => events.push(e))
  return { p, slow, events }
}

describe('同步模式：并行子 Agent，主模型汇总', () => {
  it('一轮两个 delegate → 两个子 Agent 各自出结论，主模型看到后汇总开口', async () => {
    const { p, events } = mk((req) => {
      if (isSub(req, '调研石油行情')) return { text: '油价涨了百分之三' }
      if (isSub(req, '搜周杰伦的新闻')) return { text: '新专辑下月发' }
      const hasResults = req.messages.some(m => m.role === 'tool' && m.content.includes('油价'))
      if (!hasResults) return { toolCalls: [
        call('task.delegate', { goal: '调研石油行情' }),
        call('task.delegate', { goal: '搜周杰伦的新闻' }),
      ] }
      return { text: '油价涨了，周杰伦新专辑下月发' }
    })
    await p.run('查下石油行情，再看看周杰伦有什么新闻')
    const speak = events.filter(e => e.type === 'speaking').map(e => (e as any).text)
    expect(speak.join('')).toContain('油价')
    expect(speak.join('')).toContain('周杰伦')
    // 转交给主模型的是结构化结果
    const toolMsgs = p.thread.filter(m => m.role === 'tool' && m.content.includes('summary'))
    expect(toolMsgs.length).toBe(2)
  })

  it('两个子 Agent 真并发——第二个不等第一个跑完', async () => {
    let started = 0
    let unblock!: () => void
    const both = new Promise<void>(res => { unblock = res })
    const { p } = mk(async (req) => {
      if (isSub(req, '任务甲') || isSub(req, '任务乙')) {
        started++
        if (started === 2) unblock()
        await both                       // 两个都到齐才放行——串行的话这里死锁超时
        return { text: '完成' }
      }
      if (!req.messages.some(m => m.role === 'tool')) return { toolCalls: [
        call('task.delegate', { goal: '任务甲' }),
        call('task.delegate', { goal: '任务乙' }),
      ] }
      return { text: '都完成了' }
    })
    await p.run('两件事一起办')
    expect(started).toBe(2)
  })
})

describe('后台模式：立即返回，完成机械交付', () => {
  it('background → 立刻拿 taskId，主模型先答；子 Agent 完成后 taskDone 事件带 summary', async () => {
    let releaseSub!: (r: LLMReply) => void
    const gate = new Promise<LLMReply>(res => { releaseSub = res })
    const { p, events } = mk((req) => {
      if (isSub(req, '深度调研市场')) return gate
      if (!req.messages.some(m => m.role === 'tool')) return { toolCalls: [
        call('task.delegate', { goal: '深度调研市场', background: true }),
      ] }
      return { text: '我去查着，好了叫你' }
    })
    await p.run('帮我调研下市场')
    expect(events.filter(e => e.type === 'speaking').map(e => (e as any).text).join('')).toContain('查着')
    expect(p.tasks().filter(t => t.status === 'running')).toHaveLength(1)
    releaseSub({ text: '市场调研结论：稳中有升' })
    await new Promise(r => setTimeout(r, 0))
    const done = events.find(e => e.type === 'taskDone') as any
    expect(done?.summary).toContain('稳中有升')
    expect(p.tasks()[0].status).toBe('done')
  })

  it('后台任务可取消：状态置 cancelled，子 Agent 不再往下跑', async () => {
    let subCalls = 0
    let releaseSub!: (r: LLMReply) => void
    const gate = new Promise<LLMReply>(res => { releaseSub = res })
    const { p } = mk((req) => {
      if (isSub(req, '慢活')) {
        subCalls++
        // 第一轮挂住；若取消后还有第二轮说明没停
        return subCalls === 1 ? gate : { toolCalls: [call('tools.load', { names: ['web.search'] })] }
      }
      if (!req.messages.some(m => m.role === 'tool')) return { toolCalls: [
        call('task.delegate', { goal: '慢活', background: true }),
      ] }
      return { text: '跑着了' }
    })
    await p.run('干个慢活')
    const id = p.tasks()[0].id
    p.cancelTask(id)
    releaseSub({ toolCalls: [call('tools.load', { names: ['web.search'] })] })   // 想继续也不行
    await new Promise(r => setTimeout(r, 5))
    expect(p.tasks()[0].status).toBe('cancelled')
    expect(subCalls, '取消后子 Agent 不再发起新轮').toBe(1)
  })
})

describe('边界三条', () => {
  it('深度 1：子 Agent 的工具列表里没有 task.delegate', async () => {
    const { p, slow } = mk((req) => {
      if (isSub(req, '子任务')) {
        const names = (req.tools ?? []).map((t: any) => t.function.name)
        expect(names.join(',')).not.toContain('delegate')
        return { text: '好了' }
      }
      if (!req.messages.some(m => m.role === 'tool')) return { toolCalls: [call('task.delegate', { goal: '子任务' })] }
      return { text: '完成' }
    })
    await p.run('办个事')
    expect(slow.seen.length).toBeGreaterThanOrEqual(3)
  })

  it('并发上限 3：第 4 个 delegate 被拒', async () => {
    const { p } = mk((req) => {
      if (['活1','活2','活3','活4'].some(g => isSub(req, g))) return { text: '完成' }
      if (!req.messages.some(m => m.role === 'tool')) return { toolCalls: [
        call('task.delegate', { goal: '活1' }), call('task.delegate', { goal: '活2' }),
        call('task.delegate', { goal: '活3' }), call('task.delegate', { goal: '活4' }),
      ] }
      return { text: '完成' }
    })
    await p.run('一堆活')
    const rejected = p.thread.filter(m => m.role === 'tool' && m.content.includes('TASKS_LIMIT'))
    expect(rejected).toHaveLength(1)
  })

  it('子 Agent 无灰权限：调 door.set 直接 NOT_AUTHORIZED，绝不后台弹确认', async () => {
    const { p } = mk((req) => {
      if (isSub(req, '想办法开门')) {
        if (!req.messages.some(m => m.role === 'tool'))
          return { toolCalls: [call('tools.load', { names: ['door.set'] })] }
        if (!req.messages.some(m => m.content.includes('NOT_AUTHORIZED')))
          return { toolCalls: [call('door.set', { door: 'driver', action: 'open' })] }
        return { text: '开不了' }
      }
      if (!req.messages.some(m => m.role === 'tool')) return { toolCalls: [call('task.delegate', { goal: '想办法开门' })] }
      return { text: '完成' }
    })
    await p.run('后台开个门试试')
    const sub = p.thread.filter(m => m.role === 'tool' && m.content.includes('summary'))
    expect(sub[0]?.content ?? '').toContain('开不了')
  })
})
