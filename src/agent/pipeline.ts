import type { Store } from '../core/store'
import type { Registry, ToolResult } from '../tools/registry'
import type { LLM, Msg } from './llm'
import type { AgentManifest } from '../../agents/main-agent/manifest'
import { buildSystemPrompt } from './context'
import type { TraceStep } from './runtime'

/**
 * 过滤器架构（设计文档 v2.7 §2-§5）：快层小模型先斩后奏，慢层大模型校验接力。
 *
 * 机制归代码，决策归模型：这里只有——两段循环、共享 thread、转交拼装、
 * 世代戳、工具装载的搬运。做不做、对不对、要不要开口，全在模型的输出里。
 */

export type PipelineEvent =
  | { type: 'thinking' }
  | { type: 'executing'; name: string }
  | { type: 'speaking'; text: string; layer: 'fast' | 'slow' }
  | { type: 'confirming'; text: string }
  | { type: 'rejected'; text: string }
  /** 旧 turn 的慢层迟到话术：不抢麦，降级给横幅（§4.1） */
  | { type: 'lateNote'; text: string }
  | { type: 'done' }
  | { type: 'error'; message: string }

export interface PipelineDeps {
  registry: Registry
  store: Store
  fastLlm: LLM
  slowLlm: LLM
  fastManifest: AgentManifest
  slowManifest: AgentManifest
  clock?: () => number
  desktopSummary?: () => string
  prefsList?: () => string[]
  recentSummary?: () => string
  onTurnStart?: () => void
}

export interface TurnResult {
  reply: string
  trace: TraceStep[]
  rounds: number
  stopReason: 'reply' | 'maxRounds' | 'error' | 'empty'
}

/* 元工具：装载管道，不进 TOOLS（那是业务能力表）。schema 由这里注入，调用由这里拦截 */
const HANDOFF_SCHEMA = {
  type: 'function', function: {
    name: 'agent_handoff',
    description: '收尾时勾选：把后续工作可能用到的工具名（从工具目录里挑）转交给大模型同事预载。没有就不调。',
    parameters: {
      type: 'object',
      properties: { suggestedTools: { type: 'array', items: { type: 'string' }, description: '工具名列表，如 ["navigation.search"]' } },
    },
  },
}
const LOAD_SCHEMA = {
  type: 'function', function: {
    name: 'tools_load',
    description: '把工具目录里的能力装进手边（下一轮获得完整 schema）。要用目录里的工具但它不在当前工具列表时先调这个。',
    parameters: {
      type: 'object', required: ['names'],
      properties: { names: { type: 'array', items: { type: 'string' }, description: '要装载的工具名列表' } },
    },
  },
}
const isMeta = (name: string, meta: string) => name === meta || name === meta.replace(/\./g, '_')

export function createPipeline(deps: PipelineDeps) {
  const { registry, store, clock = Date.now } = deps
  const listeners: Array<(e: PipelineEvent) => void> = []
  const emit = (e: PipelineEvent) => listeners.forEach(l => l(e))
  const on = (cb: (e: PipelineEvent) => void) => {
    listeners.push(cb)
    return () => listeners.splice(listeners.indexOf(cb), 1)
  }

  /** 共享 thread：两层共写的单一事实。llm 各看各的快照视图，落笔都在这 */
  const thread: Msg[] = []
  let gen = 0
  /** 最新 turn 的用户消息位置：旧代慢层的迟到消息插它前面——时间线不交错（§4.1） */
  let boundary = 0
  let toolRound = 0

  const stale = (g: number) => g !== gen
  /** 落 thread：当前代直接追加；旧代插到最新 turn 的用户输入之前 */
  const commit = (g: number, ...msgs: Msg[]) => {
    if (!stale(g)) thread.push(...msgs)
    else { thread.splice(boundary, 0, ...msgs); boundary += msgs.length }
  }

  /** 执行一轮 tool calls（元工具由 interceptors 拦，业务走 registry）。返回 tool 消息 */
  async function execRound(
    g: number, calls: NonNullable<Awaited<ReturnType<LLM['chat']>>['toolCalls']>,
    allow: string[], trace: TraceStep[],
    interceptors: Record<string, (args: any) => ToolResult>,
  ): Promise<Msg[]> {
    const round = ++toolRound
    const results = await Promise.all(calls.map(async c => {
      const metaKey = Object.keys(interceptors).find(k => isMeta(c.name, k))
      const name = metaKey ?? registry.canonicalName(c.name)
      trace.push({ type: 'toolCall', at: clock(), name, args: c.args, permission: registry.permissionOf(c.name) })
      emit({ type: 'executing', name })
      const s = clock()
      const result = metaKey
        ? interceptors[metaKey](c.args)
        : await registry.invoke(c.name, c.args, { allow, round })
      trace.push({ type: 'toolResult', at: clock(), name, result, ms: clock() - s })
      if (result.status === 'inputRequired') emit({ type: 'confirming', text: result.message ?? '需要确认' })
      if (result.status === 'rejected' || result.status === 'unavailable')
        emit({ type: 'rejected', text: result.message ?? '无法执行' })
      return { c, result }
    }))
    return results.map(({ c, result }) => ({
      role: 'tool' as const, tool_call_id: c.id, content: JSON.stringify(result),
    }))
  }

  const asstMsg = (reply: { text?: string; toolCalls?: any[] }): Msg => ({
    role: 'assistant', content: reply.text ?? '',
    tool_calls: reply.toolCalls?.map(c => ({
      id: c.id, type: 'function' as const,
      function: { name: c.name, arguments: JSON.stringify(c.args) },
    })),
  })

  /**
   * 快层视图：最近几条**原话与话术**。工具调用与结果一律不带（§3.2）——
   * 它要的是对话承接感，不是执行细节；上一轮慢层的长报告会撑爆它的预算。
   */
  const fastView = (snapshot: Msg[]): Msg[] =>
    snapshot
      .filter(m => (m.role === 'user' || m.role === 'assistant') && m.content)
      .map(m => ({ role: m.role, content: m.content }))
      .slice(-6)

  /** 快层：能干的立刻干、立刻说；收尾勾选转交。打断（世代变了）即弃场闭嘴 */
  async function runFast(g: number, trace: TraceStep[]): Promise<{ suggested: string[]; said: string; rounds: number }> {
    const fm = deps.fastManifest
    const tools = [...registry.schemas('openai', fm.tools), HANDOFF_SCHEMA]
    let suggested: string[] = []
    let said = ''
    let rounds = 0
    while (rounds < fm.maxRounds) {
      rounds++
      const system = buildSystemPrompt(fm, store, registry, {
        catalog: registry.briefCatalog(),
        signalFilter: registry.signalsFor(fm.tools),
      })
      trace.push({ type: 'prompt', at: clock(), system, toolCount: tools.length })
      const view = fastView(thread)
      let reply
      try { reply = await deps.fastLlm.chat({ system, messages: view, tools }) }
      catch (e) { trace.push({ type: 'error', at: clock(), message: `快层：${e}` }); return { suggested, said, rounds } }
      if (stale(g)) return { suggested, said, rounds }
      // 话术立刻出——先斩后奏的"奏"不等工具返回（车控是本地毫秒级，查询类模型自会下一轮再说）
      if (reply.text) { said = reply.text; emit({ type: 'speaking', text: reply.text, layer: 'fast' }) }
      if (!reply.toolCalls?.length) {
        if (reply.text) commit(g, { role: 'assistant', content: reply.text })
        return { suggested, said, rounds }
      }
      commit(g, asstMsg(reply))
      const toolMsgs = await execRound(g, reply.toolCalls, fm.tools, trace, {
        'agent.handoff': args => {
          suggested = (args?.suggestedTools ?? []).filter((n: string) => registry.list().some(t => t.name === registry.canonicalName(n)))
          return { status: 'ok', message: '已转交' }
        },
      })
      commit(g, ...toolMsgs)
    }
    return { suggested, said, rounds }
  }

  /** 慢层：目录 + 预载 + 补载；校验、接力、静默判断都在模型的输出里 */
  async function runSlow(g: number, suggested: string[], trace: TraceStep[]): Promise<{ said: string; rounds: number; stop: TurnResult['stopReason'] }> {
    const sm = deps.slowManifest
    const loaded = new Set<string>([...(sm.resident ?? []), ...suggested.map(n => registry.canonicalName(n))])
    const view = thread.slice()   // 冻结视图：旧代慢层不许看见新 turn 的内容
    let rounds = 0
    while (rounds < sm.maxRounds) {
      rounds++
      const system = buildSystemPrompt(sm, store, registry, {
        desktop: deps.desktopSummary?.(), prefs: deps.prefsList?.(), recent: deps.recentSummary?.(),
        catalog: registry.briefCatalog(),
        signalFilter: registry.signalsFor([...loaded]),
      })
      trace.push({ type: 'prompt', at: clock(), system, toolCount: loaded.size })
      // 最后一轮撤工具逼话术——语音场景没有"静默耗尽轮次"这个选项
      const last = rounds === sm.maxRounds
      const tools = last ? [] : [...registry.schemas('openai', [...loaded]), LOAD_SCHEMA]
      let reply
      try { reply = await deps.slowLlm.chat({ system, messages: view, tools }) }
      catch (e) {
        trace.push({ type: 'error', at: clock(), message: `慢层：${e}` })
        emit({ type: 'error', message: String(e) })
        return { said: '', rounds, stop: 'error' }
      }

      if (!reply.toolCalls?.length) {
        const text = reply.text ?? ''
        if (text) commit(g, { role: 'assistant', content: text })
        trace.push({ type: 'reply', at: clock(), text })
        if (stale(g)) {
          // 迟到的话术不抢麦：降级为横幅素材（§4.1）。活已经干完，成果都在
          if (text) emit({ type: 'lateNote', text })
        } else {
          if (text) emit({ type: 'speaking', text, layer: 'slow' })
          emit({ type: 'done' })
        }
        return { said: text, rounds, stop: 'reply' }
      }

      const am = asstMsg(reply)
      commit(g, am); view.push(am)
      const toolMsgs = await execRound(g, reply.toolCalls, sm.tools, trace, {
        'tools.load': args => {
          const names: string[] = (args?.names ?? []).map((n: string) => registry.canonicalName(n))
          const known = names.filter(n => registry.list().some(t => t.name === n))
          known.forEach(n => loaded.add(n))
          const unknown = names.filter(n => !known.includes(n))
          return known.length
            ? { status: 'ok', message: `已装载：${known.join('、')}${unknown.length ? `；没有这些工具：${unknown.join('、')}` : ''}` }
            : { status: 'rejected', code: 'UNKNOWN_TOOL', message: `目录里没有：${names.join('、')}`, suggestion: '对照工具目录里的名字再试' }
        },
      })
      commit(g, ...toolMsgs); view.push(...toolMsgs)
    }
    if (!stale(g)) emit({ type: 'done' })
    return { said: '', rounds, stop: 'maxRounds' }
  }

  async function run(text: string): Promise<TurnResult> {
    const trace: TraceStep[] = []
    // 空输入直接返回：送进模型它会凭空发挥（实测会无端开窗）
    if (!text.trim()) return { reply: '', trace, rounds: 0, stopReason: 'empty' }
    const g = ++gen
    deps.onTurnStart?.()
    trace.push({ type: 'userInput', at: clock(), text })
    boundary = thread.length
    thread.push({ role: 'user', content: text })
    emit({ type: 'thinking' })

    // pending 确认直达慢层（§4.2）：快层不知道有确认挂着，接了必错。
    // 状态分支不是意图分支——看的是系统状态，不是话的内容
    const pending = registry.pendingConfirm()
    let fast = { suggested: [] as string[], said: '', rounds: 0 }
    if (!pending) fast = await runFast(g, trace)
    else fast.suggested = [pending.tool]

    const slow = await runSlow(g, fast.suggested, trace)
    return {
      reply: [fast.said, slow.said].filter(Boolean).join(' '),
      trace, rounds: fast.rounds + slow.rounds,
      stopReason: slow.stop,
    }
  }

  const reset = () => { thread.length = 0; boundary = 0 }

  return { run, on, reset, thread, get generation() { return gen } }
}

export type Pipeline = ReturnType<typeof createPipeline>
