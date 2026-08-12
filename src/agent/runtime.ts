import type { Store } from '../core/store'
import type { Registry, ToolResult } from '../tools/registry'
import type { LLM, Msg } from './llm'
import type { AgentManifest } from '../../agents/main-agent/manifest'
import { buildSystemPrompt } from './context'

export type TraceStep =
  | { type: 'userInput'; at: number; text: string }
  | { type: 'prompt'; at: number; system: string; toolCount: number }
  | { type: 'toolCall'; at: number; name: string; args: any; permission?: string }
  | { type: 'toolResult'; at: number; name: string; result: ToolResult; ms: number }
  | { type: 'reply'; at: number; text: string }
  | { type: 'error'; at: number; message: string }

export type AgentEvent =
  | { type: 'thinking' }
  | { type: 'executing'; name: string }
  | { type: 'speaking'; text: string }
  | { type: 'confirming'; text: string }
  | { type: 'rejected'; text: string }
  | { type: 'done' }
  | { type: 'error'; message: string }

export interface RunResult {
  reply: string
  trace: TraceStep[]
  rounds: number
  stopReason: 'reply' | 'maxRounds' | 'error' | 'empty'
}

export interface AgentDeps {
  manifest: AgentManifest
  registry: Registry
  store: Store
  llm: LLM
  clock?: () => number
  desktopSummary?: () => string
  /** 长期记忆（用户偏好），注入 system。落实靠模型，代码不解析 */
  prefsList?: () => string[]
  /** 会话摘要（最近放过/查过的结论） */
  recentSummary?: () => string
  /**
   * 每轮用户真正开口时回调。用来清理上一轮遗留的临时卡——
   * 上一轮问"你要哪个"，用户这轮一开口就等于回答了或换了话题，那张问题卡该走了。
   * Runtime 不认识卡片，具体清理什么由装配方决定。
   */
  onTurnStart?: () => void
}

export function createAgent({ manifest, registry, store, llm, clock = Date.now, desktopSummary, prefsList, recentSummary, onTurnStart }: AgentDeps) {
  let toolRound = 0
  const listeners: Array<(e: AgentEvent) => void> = []
  const emit = (e: AgentEvent) => listeners.forEach(l => l(e))
  const on = (cb: (e: AgentEvent) => void) => {
    listeners.push(cb)
    return () => listeners.splice(listeners.indexOf(cb), 1)
  }

  /** 会话历史，跨 run 保留以支持多轮承接 */
  let history: Msg[] = []
  const reset = () => { history = [] }

  async function run(userText: string): Promise<RunResult> {
    const trace: TraceStep[] = []
    const t0 = clock()
    // 空输入直接返回：送进模型它会凭空发挥（实测会无端开窗、查天气），
    // 也别把空话塞进历史污染后续多轮
    if (!userText.trim()) return { reply: '', trace, rounds: 0, stopReason: 'empty' }

    onTurnStart?.()
    trace.push({ type: 'userInput', at: t0, text: userText })
    history.push({ role: 'user', content: userText })

    const tools = registry.schemas('openai', manifest.tools)
    let rounds = 0

    try {
      while (rounds < manifest.maxRounds) {
        rounds++
        const system = buildSystemPrompt(manifest, store, registry,
          { desktop: desktopSummary?.(), prefs: prefsList?.(), recent: recentSummary?.() })
        trace.push({ type: 'prompt', at: clock(), system, toolCount: tools.length })
        emit({ type: 'thinking' })

        // 最后一轮撤掉工具：语音场景没有"静默"这个选项，模型把轮次全用在
        // 调工具上会让用户说完话什么也没听到。没工具可用它只能出话术。
        const last = rounds === manifest.maxRounds
        const reply = await llm.chat({ system, messages: history, tools: last ? [] : tools })

        // ── 无工具调用：出话术，结束 ──
        if (!reply.toolCalls?.length) {
          const text = reply.text ?? ''
          history.push({ role: 'assistant', content: text })
          trace.push({ type: 'reply', at: clock(), text })
          emit({ type: 'speaking', text })
          emit({ type: 'done' })
          return { reply: text, trace, rounds, stopReason: 'reply' }
        }

        // ── 有工具调用：并行执行后回填 ──
        history.push({
          role: 'assistant',
          content: reply.text ?? '',
          tool_calls: reply.toolCalls.map(c => ({
            id: c.id, type: 'function' as const,
            function: { name: c.name, arguments: JSON.stringify(c.args) },
          })),
        })

        // 家族机制的批号：同一条模型回复里的并行工具调用共一轮——
        // "哪个县最凉快"并行查五地是一个意图的展开，五张天气卡该并存；
        // 下一轮再查别的城，上一批整体退场
        const round = ++toolRound
        const results = await Promise.all(reply.toolCalls.map(async c => {
          // provider（如 Anthropic）不接受点号，模型可能回传 window_set 这种 wire 形式；
          // 追踪面板统一显示回内部点号命名，不然同一个 Tool 换个模型名字就变了
          const name = registry.canonicalName(c.name)
          trace.push({
            type: 'toolCall', at: clock(), name, args: c.args,
            permission: registry.permissionOf(c.name),
          })
          emit({ type: 'executing', name })
          const s = clock()
          const result = await registry.invoke(c.name, c.args, { allow: manifest.tools, round })
          trace.push({ type: 'toolResult', at: clock(), name, result, ms: clock() - s })
          if (result.status === 'inputRequired') emit({ type: 'confirming', text: result.message ?? '需要确认' })
          if (result.status === 'rejected' || result.status === 'unavailable')
            emit({ type: 'rejected', text: result.message ?? '无法执行' })
          return { c, result }
        }))

        for (const { c, result } of results)
          history.push({ role: 'tool', tool_call_id: c.id, content: JSON.stringify(result) })
      }

      emit({ type: 'done' })
      return { reply: '', trace, rounds, stopReason: 'maxRounds' }
    } catch (e) {
      const message = e instanceof Error ? e.message : String(e)
      trace.push({ type: 'error', at: clock(), message })
      emit({ type: 'error', message })
      return { reply: '', trace, rounds, stopReason: 'error' }
    }
  }

  return { run, on, reset, manifest, get history() { return history } }
}

export type Agent = ReturnType<typeof createAgent>
